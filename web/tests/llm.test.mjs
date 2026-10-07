/**
 * Groq first, OpenAI behind it.
 *
 * What has to hold: Groq is asked with the right model for the job (the one
 * that sees, for a scan), its answer arrives without the model's working-out,
 * and anything Groq cannot do is answered by OpenAI - quickly enough that both
 * fit in one serverless call. No network: fetch is replaced.
 */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';

const { config } = await import('../lib/config.js');
const llm = await import('../lib/llm.js');

const realFetch = globalThis.fetch;
const original = { ...config.llm };
afterEach(() => { globalThis.fetch = realFetch; Object.assign(config.llm, original); });

function network(answer) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { host: new URL(String(url)).host, body: JSON.parse(init.body), auth: init.headers.authorization };
    calls.push(call);
    const { status = 200, body, headers = {} } = answer(call, calls.length);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  return calls;
}

const reply = (content, toolCalls = []) => ({
  body: { choices: [{ message: { content, tool_calls: toolCalls.map((c, i) => ({ id: `c${i}`, function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] },
});

function useGroq({ openai = true } = {}) {
  Object.assign(config.llm, { provider: 'groq', groqKey: 'gsk_test', openaiKey: openai ? 'sk-test' : '' });
}

test('Groq answers first, with the conversation model, or the fast one for bulk work', async () => {
  useGroq();
  const calls = network(() => reply('Cairo.'));
  const a = await llm.chat({ system: 's', messages: [{ role: 'user', content: 'capital?' }] });
  await llm.chat({ system: 's', messages: [{ role: 'user', content: 'x' }], fast: true });

  assert.equal(a.content, 'Cairo.');
  assert.deepEqual(calls.map((c) => [c.host, c.body.model]), [
    ['api.groq.com', config.llm.groqModel],
    ['api.groq.com', config.llm.groqFastModel],
  ]);
  assert.equal(calls[0].auth, 'Bearer gsk_test');
});

test('a scan goes to the model that sees, without OpenAI\'s detail hint and without its working-out', async () => {
  useGroq();
  const calls = network(() => reply('<think>let me read this…</think>\nINVOICE INV-1'));
  const out = await llm.chat({ system: 's', messages: [llm.imageMessage('Transcribe.', Buffer.from('png'), 'image/png')], tools: [] });

  assert.equal(out.content, 'INVOICE INV-1');
  assert.equal(calls[0].body.model, config.llm.groqVisionModel);
  assert.equal(calls[0].body.reasoning_format, 'hidden');
  const image = calls[0].body.messages[1].content.find((p) => p.type === 'image_url');
  assert.deepEqual(Object.keys(image.image_url), ['url']);
});

test('tool calls come back in the engine\'s shape', async () => {
  useGroq();
  network(() => reply('', [{ name: 'track_shipment', args: { query: 'YV2RT40A8FB712905' } }]));
  const out = await llm.chat({
    system: 's', messages: [{ role: 'user', content: 'where?' }],
    tools: [{ name: 'track_shipment', description: 'd', parameters: { type: 'object', properties: {} } }],
  });
  assert.deepEqual(out.toolCalls, [{ id: 'c0', name: 'track_shipment', args: { query: 'YV2RT40A8FB712905' } }]);
});

test('when Groq refuses, OpenAI answers - a fumbled tool call, an outage, or a long rate limit', async () => {
  for (const failure of [
    { status: 400, body: { error: { code: 'tool_use_failed' } } },
    { status: 401, body: { error: { code: 'invalid_api_key' } } },
    // Told to wait 30 s: longer than Groq is allowed, so OpenAI is asked at once.
    { status: 429, body: { error: { message: 'rate limit' } }, headers: { 'retry-after': '30' } },
  ]) {
    useGroq();
    const calls = network((call) => (call.host === 'api.groq.com' ? failure : reply('from openai')));
    const started = Date.now();
    const out = await llm.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.content, 'from openai', `after a ${failure.status}`);
    assert.deepEqual(calls.map((c) => c.host), ['api.groq.com', 'api.openai.com']);
    assert.equal(calls[1].body.model, config.llm.openaiModel);
    assert.ok(Date.now() - started < 1000, 'no waiting before the fallback');
  }
});

test('with no OpenAI key behind it, a Groq failure is reported, not hidden', async () => {
  useGroq({ openai: false });
  network(() => ({ status: 400, body: { error: { code: 'bad' } } }));
  await assert.rejects(() => llm.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }] }), /api\.groq\.com\/\S* -> 400/);
});

test('LLM_PROVIDER=openai is untouched: OpenAI only, with OpenAI\'s detail hint on images', async () => {
  Object.assign(config.llm, { provider: 'openai', openaiKey: 'sk-test', groqKey: 'gsk_test' });
  const calls = network(() => reply('ok'));
  await llm.chat({ system: 's', messages: [llm.imageMessage('Transcribe.', Buffer.from('png'), 'image/png')] });
  assert.equal(calls[0].host, 'api.openai.com');
  assert.equal(calls[0].body.messages[1].content.find((p) => p.type === 'image_url').image_url.detail, 'high');
});
