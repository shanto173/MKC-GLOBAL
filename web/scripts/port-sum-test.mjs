/**
 * The Port Sum Up views against the real database, read-only: the queries the
 * tests cannot reach - the counts, the funds filter, the chunked read of a
 * page's papers, and the or() filter a Team MKY mention is resolved with.
 * Writes nothing.
 *
 *   npm run portsumtest
 */
import 'dotenv/config';
import { portSumList, portSumMentions, mentionTokens } from '../lib/admin/desk-port-sum.js';
import { db } from '../lib/supabase.js';

const who = { name: 'Ariful', role: 'admin', can: () => true };
const call = (fn, query) => new Promise((resolve) => {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { resolve({ status: this.statusCode, body }); return this; },
  };
  fn({ query, body: {} }, res, who).catch((err) => resolve({ status: 'threw', body: { error: err.message } }));
});

const show = (label, { status, body }, pick) => {
  const detail = status === 200 ? pick(body) : JSON.stringify(body);
  console.log(`${status === 200 ? 'OK  ' : 'FAIL'}  ${label} — ${detail}`);
};

// 1. The list: counts, and a page of rows with their papers.
const all = await call(portSumList, { filter: 'all', limit: '100' });
show('list, all funds', all, (b) => `${b.rows.length} rows, counts ${JSON.stringify(b.counts)}, next=${b.next ? 'yes' : 'no'}`);

// 2. Each funds filter, against the counts the first call gave.
for (const state of ['not_received', 'in_process', 'received']) {
  const one = await call(portSumList, { filter: 'all', funds: state, limit: '100' });
  const agrees = one.body?.counts?.[state] === one.body?.rows?.length || one.body?.next;
  show(`funds=${state}`, one, (b) => `${b.rows.length} rows, count ${b.counts?.[state]}${agrees ? '' : ' — MISMATCH'}`);
}

// 3. A page's papers: the chunked read. How many rows came back with papers.
const withDocs = (all.body.rows ?? []).filter((r) => r.documents?.length);
console.log(`OK    papers on the page — ${withDocs.length} of ${all.body.rows?.length} orders have papers`
  + `${withDocs[0] ? `; first: ${withDocs[0].documents.map((d) => d.label).join(', ')}` : ''}`);

// 4. A page bigger than one chunk (150): the read must still answer.
const big = await call(portSumList, { filter: 'all', limit: '300' });
show('a page of up to 300, papers read in chunks', big, (b) => `${b.rows.length} rows, ${b.rows.filter((r) => r.documents?.length).length} with papers`);

// 5. Search, pushed to the database.
const found = await call(portSumList, { filter: 'all', q: 'alexandria', limit: '20' });
show('search "alexandria"', found, (b) => `${b.rows.length} rows`);

// 6. The mention list, searched.
const name = (all.body.rows ?? []).find((r) => r.customer_name)?.customer_name ?? 'a';
const tags = await call(portSumMentions, { q: name.slice(0, 4), limit: '8' });
show(`mentions for "${name.slice(0, 4)}"`, tags, (b) => `${b.candidates.length} tags: ${b.candidates.map((c) => c.label).join(' | ')}`);

// 7. The or() filter a message's @ is resolved with - the shape, on the real API.
const tokens = mentionTokens(`please check @${name} today`);
const or = tokens.flatMap((t) => [`customer_name.ilike."${t}"`, `vin.ilike."${t}"`]).join(',');
const { data, error } = await db().from('bookings')
  .select('booking_ref, customer_name, vin')
  .not('vin', 'is', null).neq('vin', '')
  .not('status', 'in', '("cancelled","expired","rejected")')
  .or(or).limit(200);
console.log(error
  ? `FAIL  mention or() filter — ${error.message}`
  : `OK    mention or() filter — ${tokens.length} tokens asked, ${data.length} order(s) matched`
    + `${data[0] ? `: ${data[0].booking_ref} (${data[0].customer_name})` : ''}`);
