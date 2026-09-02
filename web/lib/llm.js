/**
 * Thin provider adapter over OpenAI and Anthropic, using plain fetch so the
 * deployed function stays dependency-light.
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

async function postJson(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
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

function toOpenAiMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') {
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

async function openaiChat({ system, messages, tools }) {
  const body = {
    model: config.llm.openaiModel,
    messages: toOpenAiMessages(system, messages),
    temperature: 0.2,
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = 'auto';
  }

  const url = 'https://api.openai.com/v1/chat/completions';
  const headers = { authorization: `Bearer ${config.llm.openaiKey}` };

  let data;
  try {
    data = await postJson(url, headers, body);
  } catch (err) {
    // Reasoning models (the gpt-5 family) reject an explicit temperature.
    if (/temperature/i.test(err.message)) {
      delete body.temperature;
      data = await postJson(url, headers, body);
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
  return { content: choice.content || '', toolCalls };
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

/** One turn of chat completion, possibly returning tool calls to execute. */
export async function chat({ system, messages, tools }) {
  return config.llm.provider === 'anthropic'
    ? anthropicChat({ system, messages, tools })
    : openaiChat({ system, messages, tools });
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
