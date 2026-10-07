/**
 * Thin provider adapter over OpenAI, Groq and Anthropic, using plain fetch so
 * the deployed function stays dependency-light.
 *
 * Groq speaks OpenAI's request format, so it shares OpenAI's code. With
 * LLM_PROVIDER=groq it is asked first and OpenAI answers whenever Groq cannot -
 * a rate limit, an outage, a tool call it fumbled - so the customer gets an
 * answer rather than an apology. Groq is given less time and fewer retries than
 * a lone provider would be: a serverless function has 60 seconds, and a Groq
 * call that used 45 of them would leave OpenAI none.
 *
 * Internal message shape (provider independent):
 *   { role: 'user',      content: string }
 *   { role: 'assistant', content: string, tool_calls?: [{ id, name, args }] }
 *   { role: 'tool',      tool_call_id: string, name: string, content: string }
 *
 * Tool shape:
 *   { name, description, parameters }   // parameters = JSON Schema object
 */

import { config } from './config.js';

const TIMEOUT_MS = 45_000;

/**
 * How long to wait before trying again after a rate limit.
 *
 * A stronger model comes with a smaller allowance per minute, and two customers
 * writing at once is enough to reach it. The provider says how long to wait -
 * in a header, or in the message itself - and waiting is the whole fix: the
 * alternative is telling a customer something went wrong when nothing has.
 */
function retryAfterMs(res, text, attempt) {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 20_000);

  const stated = String(text).match(/try again in ([\d.]+)\s*(ms|s)\b/i);
  if (stated) {
    const value = Number(stated[1]) * (stated[2].toLowerCase() === 'ms' ? 1 : 1000);
    return Math.min(Math.ceil(value) + 250, 20_000);
  }
  return Math.min(1200 * 2 ** attempt, 20_000);
}

async function postJson(url, headers, body, attempt = 0, limits = {}) {
  const { timeoutMs = TIMEOUT_MS, retries = 3, maxWaitMs = 20_000 } = limits;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();

    // 429 is "wait, then ask again", not a failure. 500 and 503 are the
    // provider having a moment; both are worth one more try before the
    // customer is told anything.
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const wait = retryAfterMs(res, text, attempt);
      // A wait longer than allowed is not worth making: with a fallback behind
      // this provider, asking the fallback now is quicker than waiting here.
      if (wait <= maxWaitMs) {
        console.warn(`llm ${res.status}, retrying in ${wait}ms (attempt ${attempt + 1})`);
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, wait));
        return postJson(url, headers, body, attempt + 1, limits);
      }
    }

    if (!res.ok) {
      throw new Error(`${url} -> ${res.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

function toOpenAiMessages(system, messages, { plainImages = false } = {}) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    // Content may be an array of parts when the message carries an image; pass
    // it through so scans and photographs reach the model. OpenAI's "detail"
    // hint is OpenAI's own, and is left off for anyone else.
    if (Array.isArray(m.content) && m.role === 'user') {
      const content = plainImages
        ? m.content.map((p) => (p?.type === 'image_url' ? { type: 'image_url', image_url: { url: p.image_url?.url } } : p))
        : m.content;
      out.push({ role: 'user', content });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content ?? '' });
    }
  }
  return out;
}

/**
 * One chat completion against an endpoint that speaks OpenAI's format: OpenAI
 * itself, or Groq. `extra` carries provider-specific body fields.
 */
async function compatibleChat({ url, key, model, system, messages, tools, limits = {}, plainImages = false, extra = {} }) {
  const body = {
    model,
    messages: toOpenAiMessages(system, messages, { plainImages }),
    temperature: 0.2,
    ...extra,
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = 'auto';
  }

  const headers = { authorization: `Bearer ${key}` };

  let data;
  try {
    data = await postJson(url, headers, body, 0, limits);
  } catch (err) {
    // Reasoning models (the gpt-5 family) reject an explicit temperature.
    if (/temperature/i.test(err.message)) {
      delete body.temperature;
      data = await postJson(url, headers, body, 0, limits);
    } else {
      throw err;
    }
  }

  const choice = data.choices?.[0]?.message ?? {};
  const toolCalls = (choice.tool_calls ?? []).map((c) => ({
    id: c.id,
    name: c.function?.name,
    args: safeParse(c.function?.arguments),
  }));
  return { content: withoutThinking(choice.content || ''), toolCalls };
}

/**
 * A reasoning model's working-out, when it arrives inline as <think>…</think>.
 * Hidden by request (reasoning_format), and stripped here in case it is not: a
 * transcription that opened with the model talking to itself would be read as
 * the document.
 */
function withoutThinking(text) {
  return String(text).replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
}

async function openaiChat({ system, messages, tools, fast = false }) {
  return compatibleChat({
    url: 'https://api.openai.com/v1/chat/completions',
    key: config.llm.openaiKey,
    model: fast ? config.llm.openaiFastModel : config.llm.openaiModel,
    system, messages, tools,
  });
}

// ---------------------------------------------------------------------------
// Groq
// ---------------------------------------------------------------------------

const carriesImage = (messages) => messages.some(
  (m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url'),
);

/** The model this request goes to: one that sees, for a scan; the fast one for bulk work. */
export function groqModelFor({ messages, fast = false }) {
  if (carriesImage(messages)) return config.llm.groqVisionModel;
  return fast ? config.llm.groqFastModel : config.llm.groqModel;
}

async function groqChat({ system, messages, tools, fast = false }) {
  const model = groqModelFor({ messages, fast });
  return compatibleChat({
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: config.llm.groqKey,
    model,
    system, messages, tools,
    plainImages: true,
    // Qwen thinks out loud unless told not to show it.
    extra: /qwen/i.test(model) ? { reasoning_format: 'hidden' } : {},
    // OpenAI is behind Groq: a short leash, so a slow Groq leaves OpenAI time.
    limits: config.llm.openaiKey ? { timeoutMs: 20_000, retries: 1, maxWaitMs: 4_000 } : {},
  });
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
      const last = out[out.length - 1];
      // Consecutive tool results must be merged into one user message.
      if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.tool_calls) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
      }
      out.push({ role: 'assistant', content });
    } else {
      out.push({ role: m.role, content: m.content ?? '' });
    }
  }
  return out;
}

async function anthropicChat({ system, messages, tools }) {
  const body = {
    model: config.llm.anthropicModel,
    max_tokens: 1500,
    temperature: 0.2,
    system,
    messages: toAnthropicMessages(messages),
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const data = await postJson(
    'https://api.anthropic.com/v1/messages',
    {
      'x-api-key': config.llm.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body,
  );

  let content = '';
  const toolCalls = [];
  for (const block of data.content ?? []) {
    if (block.type === 'text') content += block.text;
    if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
  }
  return { content, toolCalls };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * One turn of chat completion, possibly returning tool calls to execute.
 *
 * With LLM_PROVIDER=groq, Groq answers and OpenAI stands behind it: anything
 * Groq cannot do - a rate limit past its short wait, an outage, a malformed
 * tool call (Groq refuses those with a 400) - is asked of OpenAI instead.
 */
export async function chat({ system, messages, tools, fast = false }) {
  if (config.llm.provider === 'anthropic') return anthropicChat({ system, messages, tools });
  if (config.llm.provider === 'groq' && config.llm.groqKey) {
    try {
      return await groqChat({ system, messages, tools, fast });
    } catch (err) {
      if (!config.llm.openaiKey) throw err;
      console.warn(`llm: groq failed, answering with openai instead: ${String(err?.message ?? err).slice(0, 300)}`);
      return openaiChat({ system, messages, tools, fast });
    }
  }
  return openaiChat({ system, messages, tools, fast });
}

/**
 * Builds a user message carrying an image, for reading a scanned document or a
 * photograph of one. Both providers accept base64 inline; this avoids paying for
 * a separate OCR service, and the model reads Arabic, Polish and Romanian forms
 * as readily as English ones.
 */
export function imageMessage(text, buffer, mimeType = 'image/jpeg') {
  const b64 = Buffer.from(buffer).toString('base64');
  if (config.llm.provider === 'anthropic') {
    return {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } },
        { type: 'text', text },
      ],
    };
  }
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}`, detail: 'high' } },
    ],
  };
}

/** True when we can produce embeddings (needed for vector RAG). */
export function embeddingsAvailable() {
  return Boolean(config.llm.openaiKey);
}

/** Embed one or more strings. Returns an array of float arrays. */
export async function embed(input) {
  const texts = Array.isArray(input) ? input : [input];
  const data = await postJson(
    'https://api.openai.com/v1/embeddings',
    { authorization: `Bearer ${config.llm.openaiKey}` },
    { model: config.llm.embeddingModel, input: texts },
  );
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

function safeParse(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
