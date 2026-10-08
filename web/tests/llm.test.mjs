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

// ---------------------------------------------------------------------------
// Tool schemas a strict validator accepts, and a ticket that is asked for
// once (live test, 2026-10-08: Groq refused create_support_ticket - "/customer
// expected string, but got null; /department value must be one of…" - the
// fallback to OpenAI cost 10-11 s a reply, and the "Customs Documentation"
// card asking for the problem and a number went out four times in a row)
// ---------------------------------------------------------------------------

const { createFakeDb } = await import('./helpers/fake-db.mjs');
const { setClientForTests } = await import('../lib/supabase.js');
const { invalidateSettings } = await import('../lib/settings.js');
const { resetFlowReady } = await import('../lib/flow/ready.js');
const { toolDefinitions } = await import('../lib/tools.js');
const { ticketAskCard, TICKET_ASK_HEADING } = await import('../lib/format.js');
const { DEPARTMENTS } = await import('../lib/config.js');

/** The subset of JSON Schema a strict validator (Groq's) enforces on a tool call. */
function violations(schema, value, at = '') {
  const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
  const types = [].concat(schema?.type ?? []);
  const out = [];
  if (types.length && !types.some((t) => t === kind(value) || (t === 'number' && kind(value) === 'integer'))) {
    out.push(`${at || '/'}: expected ${types.join('|')}, but got ${kind(value)}`);
  }
  if (schema?.enum && !schema.enum.includes(value)) out.push(`${at}: value must be one of ${schema.enum.join(', ')}`);
  if (kind(value) === 'object' && schema?.properties) {
    for (const name of schema.required ?? []) if (!(name in value)) out.push(`${at}/${name}: required`);
    for (const [name, v] of Object.entries(value)) {
      if (!schema.properties[name]) { if (schema.additionalProperties === false) out.push(`${at}/${name}: not allowed`); continue; }
      out.push(...violations(schema.properties[name], v, `${at}/${name}`));
    }
  }
  return out;
}

const sample = (prop) => {
  const values = (prop.enum ?? []).filter((v) => v !== null);
  if (values.length) return values[0];
  const type = [].concat(prop.type).find((t) => t !== 'null');
  return type === 'number' || type === 'integer' ? 1 : type === 'boolean' ? true : 'x';
};

test('every tool accepts null for whatever it does not require, as a strict validator demands', () => {
  for (const tool of toolDefinitions) {
    const { properties = {}, required = [] } = tool.parameters;
    const args = Object.fromEntries(Object.entries(properties).map(([name, prop]) => [name, required.includes(name) ? sample(prop) : null]));
    assert.deepEqual(violations(tool.parameters, args), [], `${tool.name} with its optional fields left null`);
  }
  const ticket = toolDefinitions.find((t) => t.name === 'create_support_ticket').parameters;
  assert.deepEqual(ticket.properties.department.enum.filter((v) => v !== null), DEPARTMENTS, 'exactly the departments in lib/config.js');
  assert.deepEqual(violations(ticket, { department: 'Customs Documentation', summary: 'ACID stuck', customer: null, contact: null }), []);
});

/** A database for the assistant, and Groq answering with one tool call - refusing it, as Groq does, if it breaks the schema it was sent. */
function assistantWorld({ chatId, history = [], call, clients = [] }) {
  const db = createFakeDb({
    bot_settings: [{ key: 'operations_phone', value: null }],
    clients,
    conversations: history.length ? [{ id: `${chatId.startsWith('wa:') ? 'whatsapp' : 'telegram'}:${chatId}`, messages: history }] : [],
  });
  setClientForTests(db);
  invalidateSettings();
  resetFlowReady(true);
  useGroq();
  const calls = network((req) => {
    if (req.host === 'api.groq.com' && req.body.tools?.length) {
      const tool = req.body.tools.find((t) => t.function.name === call.name);
      const wrong = violations(tool.function.parameters, call.args);
      if (wrong.length) {
        return { status: 400, body: { error: { message: `Tool call validation failed: parameters for tool ${call.name} did not match schema: errors: [${wrong.join(', ')}]`, code: 'tool_use_failed' } } };
      }
    }
    return reply('', [call]);
  });
  return { db, calls };
}

test('Groq\'s validator takes the ticket call with nulls in it, so there is no slow fallback to OpenAI', async () => {
  const { respond } = await import('../lib/agent.js');
  const chatId = 'wa:201005551234';
  const { db, calls } = assistantWorld({
    chatId,
    call: { name: 'create_support_ticket', args: { department: 'Customs Documentation', summary: 'My ACID registration is stuck at Nafeza since Monday.', customer: null, contact: null } },
  });
  const out = await respond('My ACID registration is stuck at Nafeza since Monday, can someone call me?', { channel: 'whatsapp', chatId, clientId: null });
  assert.deepEqual(calls.map((c) => c.host), ['api.groq.com'], 'answered by Groq alone');
  const [ticket] = db._tables.support_tickets ?? [];
  assert.ok(ticket, `a ticket was raised; the reply was: ${out.reply}`);
  assert.equal(ticket.department, 'Customs Documentation');
  assert.equal(ticket.contact, '+201005551234', 'on WhatsApp the number they write from is the number to call');
  assert.match(out.reply, new RegExp(ticket.ticket_ref));
});

test('the card asking for the problem and a number is sent once: the answer to it raises the ticket', async () => {
  const { respond } = await import('../lib/agent.js');
  const card = ticketAskCard('Customs Documentation', { needProblem: true, needContact: true });
  const history = [{ role: 'user', content: '4' }, { role: 'assistant', content: card }];

  // WhatsApp: the number is the chat itself; the department is the card's,
  // even when the model leaves it out.
  const wa = assistantWorld({
    chatId: 'wa:201005551234', history,
    call: { name: 'create_support_ticket', args: { department: null, summary: 'ACID registration stuck at Nafeza.', customer: null, contact: null } },
  });
  const one = await respond('My ACID registration is stuck at Nafeza since Monday', { channel: 'whatsapp', chatId: 'wa:201005551234' });
  assert.ok(!one.reply.includes(TICKET_ASK_HEADING[1]), `not the same card again: ${one.reply}`);
  assert.equal(wa.db._tables.support_tickets?.length, 1);
  assert.equal(wa.db._tables.support_tickets[0].department, 'Customs Documentation');
  assert.equal(wa.db._tables.support_tickets[0].contact, '+201005551234');

  // Telegram with no number anywhere: asked once already, so it is raised
  // with the chat as the way back rather than asked a second time.
  const tg = assistantWorld({
    chatId: '555', history,
    call: { name: 'create_support_ticket', args: { department: 'Customs Documentation', summary: 'ACID registration stuck at Nafeza.', customer: null, contact: null } },
  });
  const two = await respond('My ACID registration is stuck at Nafeza since Monday', { channel: 'telegram', chatId: '555' });
  assert.ok(!two.reply.includes(TICKET_ASK_HEADING[1]), `not the same card again: ${two.reply}`);
  assert.equal(tg.db._tables.support_tickets?.length, 1);
  assert.equal(tg.db._tables.support_tickets[0].contact, 'telegram:555');
});

test('the first time, with nothing known, the card is still sent - once', async () => {
  const { respond } = await import('../lib/agent.js');
  const { db } = assistantWorld({
    chatId: '555',
    call: { name: 'create_support_ticket', args: { department: 'Customer Care', summary: 'help', customer: null, contact: null } },
  });
  const out = await respond('There is a problem with my paperwork', { channel: 'telegram', chatId: '555' });
  assert.ok(out.reply.includes(TICKET_ASK_HEADING[1]), out.reply);
  assert.equal((db._tables.support_tickets ?? []).length, 0);
});
