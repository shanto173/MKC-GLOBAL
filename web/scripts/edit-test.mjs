/**
 * Editing a booking while it is still on screen, before it exists.
 *
 * A customer reading the summary often corrects something instead of agreeing.
 * Two things must hold: the correction must NOT be treated as confirmation (it
 * would book the wrong details silently), and the bot must never ask for a
 * booking reference that does not exist yet.
 *
 * This drives the real tools against the real database, then removes its rows.
 *
 *   npm run edittest
 */

import 'dotenv/config';

// No customer or ops mail for a test booking, and no ping to the staff group.
process.env.RESEND_API_KEY = '';
process.env.STAFF_CHAT_ID = '';

const { runTool } = await import('../lib/tools.js');
const { db } = await import('../lib/supabase.js');

const VIN = `TEST${Date.now().toString(36).toUpperCase()}EDIT`;
const chatId = `edit-${Math.random().toString(36).slice(2, 8)}`;
const ctx = (turn, said = '') => ({ channel: 'web', chatId, turnId: `t${turn}`, customerLanguage: 'en', customerSaid: said });

const DETAILS = {
  vin: VIN,
  make: 'Mercedes-Benz',
  model: 'Actros 1845',
  vehicle_type: 'tractor unit',
  customer_name: 'Ariful Islam',
  customer_contact: 'ariful@example.com',
  origin_port: 'Vilnius',
  destination_port: 'Alexandria Port',
  gross_weight_kg: 8266,
  incoterm: 'EXW',
  ready_date: '2026-09-20',
  notes: 'Engine damaged, not running',
};

const problems = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' -> ' + detail}`);
  if (!ok) problems.push(name);
};

const draftRow = async () => (await db()
  .from('bookings')
  .select('booking_ref, status, raw, incoterm')
  .eq('chat_id', chatId)
  .order('created_at', { ascending: false })
  .limit(1)
  .maybeSingle()).data;

console.log(`chassis ${VIN}, chat ${chatId}\n`);

// 1 - the first call only proposes.
console.log('turn 1: customer gives every detail');
const first = await runTool('create_booking', DETAILS, ctx(1));
check('not booked on the first call', first.needs_confirmation === true && first.ok === false, JSON.stringify(first).slice(0, 160));
check('summary shows EXW', /EXW/.test(first.display ?? ''), (first.display ?? '').slice(0, 120));

// 2 - the customer corrects the Incoterm instead of agreeing.
console.log('\nturn 2: "change the Incoterm from EXW to FOB"');
const edit = await runTool('create_booking', { ...DETAILS, incoterm: 'FOB' }, ctx(2));
check('a correction does not book', edit.ok === false && edit.needs_confirmation === true, JSON.stringify(edit).slice(0, 200));
check('the change is named back to the model', Array.isArray(edit.edited) && edit.edited.includes('incoterm'), JSON.stringify(edit.edited));
check('corrected summary shows FOB', /FOB/.test(edit.display ?? '') && !/EXW/.test(edit.display ?? ''), (edit.display ?? '').slice(0, 160));
const afterEdit = await draftRow();
check('draft in the database now says FOB', afterEdit?.raw?.incoterm === 'FOB', JSON.stringify(afterEdit?.raw?.incoterm));
check('still a draft, not a real booking', afterEdit?.status === 'draft', afterEdit?.status);

// 3 - now they agree. The model sends a shorter argument list, as models do;
// nothing the customer said may be lost.
console.log('\nturn 3: "yes, book it" (model drops the notes and the weight)');
const { notes: _n, gross_weight_kg: _w, ready_date: _r, ...terse } = DETAILS;
const booked = await runTool('create_booking', { ...terse, incoterm: 'FOB' }, ctx(3, 'yes that is correct, please book it'));
check('the booking is created', booked.ok === true && Boolean(booked.booking_ref), JSON.stringify(booked).slice(0, 200));

const finalRow = await draftRow();
check('booked with the corrected Incoterm', finalRow?.incoterm === 'FOB' || finalRow?.raw?.incoterm === 'FOB', JSON.stringify(finalRow?.raw?.incoterm));
check('the dropped weight survived', Number(finalRow?.raw?.gross_weight_kg) === 8266, JSON.stringify(finalRow?.raw?.gross_weight_kg));
check('the dropped damage note survived', /damaged/i.test(finalRow?.raw?.notes ?? ''), JSON.stringify(finalRow?.raw?.notes));

// 4 - update_booking with no reference, while a draft is open, must redirect
// rather than ask the customer for a reference that cannot exist.
console.log('\nseparate chat: update_booking called with no reference during confirmation');
const chat2 = `edit2-${Math.random().toString(36).slice(2, 8)}`;
const ctx2 = { channel: 'web', chatId: chat2, turnId: 'x1', customerLanguage: 'en' };
await runTool('create_booking', { ...DETAILS, vin: VIN + 'B' }, ctx2);
const redirect = await runTool('update_booking', { incoterm: 'FOB' }, { ...ctx2, turnId: 'x2' });
check('redirects to create_booking', redirect.use_create_booking === true, JSON.stringify(redirect).slice(0, 200));
check('does not ask for a reference', !/which booking reference/i.test(redirect.message ?? ''), redirect.message);

// 5 - once the booking exists there IS a reference, so the tool supplies it
// instead of sending the model back round the create_booking loop.
console.log('\nsame chat, after booking: update_booking with no reference');
const afterBooked = await runTool('update_booking', { ready_date: '2026-10-01' }, { ...ctx(4) });
check('does not redirect once a real booking exists', !afterBooked.use_create_booking, JSON.stringify(afterBooked).slice(0, 200));
check('hands back the open reference', afterBooked.booking_ref === booked.booking_ref, JSON.stringify(afterBooked.booking_ref));

// 5b - the model rewording its own values between turns is not an edit. It
// says Mercedes one turn and Mercedes-Benz the next; comparing raw arguments
// made that look like a correction and asked the customer to confirm the very
// same card twice, which is what an Arabic run actually did.
console.log('\ndrift: same booking, the model rewords its own values');
const chat3 = `edit3-${Math.random().toString(36).slice(2, 8)}`;
const ctx3 = (turn) => ({ channel: 'web', chatId: chat3, turnId: `d${turn}`, customerLanguage: 'en' });
await runTool('create_booking', { ...DETAILS, vin: VIN + 'C' }, ctx3(1));
const drifted = await runTool('create_booking', {
  ...DETAILS,
  vin: VIN + 'C',
  make: 'Mercedes',
  destination_port: 'Alexandria Port (incl. El Dekheila)',
  gross_weight_kg: '8266',
  incoterm: 'exw',
  notes: 'Engine is damaged and the unit does not run',
}, ctx3(2));
check('reworded values still book', drifted.ok === true, JSON.stringify(drifted).slice(0, 200));

// 5c - damage appearing or disappearing is a change the customer must see.
console.log('\ndamage: added after the summary was shown');
const chat4 = `edit4-${Math.random().toString(36).slice(2, 8)}`;
const ctx4 = (turn) => ({ channel: 'web', chatId: chat4, turnId: `g${turn}`, customerLanguage: 'en' });
const { notes: _dn, ...sound } = DETAILS;
await runTool('create_booking', { ...sound, vin: VIN + 'D' }, ctx4(1));
const damaged = await runTool('create_booking', { ...sound, vin: VIN + 'D', engine_condition: 'damaged engine' }, ctx4(2));
check('added damage is re-confirmed, not booked', damaged.ok === false && damaged.needs_confirmation === true, JSON.stringify(damaged).slice(0, 200));
check('the damage shows on the summary', /damaged engine/i.test(damaged.display ?? ''), (damaged.display ?? '').slice(0, 200));

// 5d - the model sometimes fails to carry the correction into its arguments:
// told to change EXW to FOB it re-sends EXW, which used to look like agreement
// and booked the term the customer had just rejected.
console.log('\nmodel ignores the correction: same values, customer asked for a change');
const chat5 = `edit5-${Math.random().toString(36).slice(2, 8)}`;
const said = 'the weight you have is wrong, please fix it';
const ctx5 = (turn, s = '') => ({ channel: 'web', chatId: chat5, turnId: `c${turn}`, customerLanguage: 'en', customerSaid: s });
await runTool('create_booking', { ...DETAILS, vin: VIN + 'E' }, ctx5(1, `book chassis ${VIN}E`));
const ignored = await runTool('create_booking', { ...DETAILS, vin: VIN + 'E' }, ctx5(2, said));
check('does not book when nothing changed but a change was asked for', ignored.ok === false && ignored.needs_correction === true, JSON.stringify(ignored).slice(0, 200));
const secondTry = await runTool('create_booking', { ...DETAILS, vin: VIN + 'E' }, ctx5(3, said));
check('held back only once, never stuck in a loop', secondTry.ok === true, JSON.stringify(secondTry).slice(0, 200));

// 5e - an Incoterm is a closed list, so when the customer names one and the
// model re-sends the old value, the customer's word wins - and the corrected
// card still goes back for confirmation.
console.log('\nthe customer names the Incoterm, the model re-sends the old one');
const chat6 = `edit6-${Math.random().toString(36).slice(2, 8)}`;
const ctx6 = (turn, s = '') => ({ channel: 'web', chatId: chat6, turnId: `i${turn}`, customerLanguage: 'en', customerSaid: s });
await runTool('create_booking', { ...DETAILS, vin: VIN + 'F' }, ctx6(1, 'book it please'));
const rescued = await runTool('create_booking', { ...DETAILS, vin: VIN + 'F' }, ctx6(2, 'i want to change incotermn EXW to FOB'));
check('the correction is applied from the customer words', /FOB/.test(rescued.display ?? '') && !/EXW/.test(rescued.display ?? ''), (rescued.display ?? '').slice(0, 200));
check('and still asks before booking', rescued.ok === false && rescued.needs_confirmation === true, JSON.stringify(rescued).slice(0, 160));

// 6 - the same correction through the whole agent, tools and database included.
// This is the conversation a customer actually had: full details, then a change
// of Incoterm while the summary was still on screen.
console.log('\nlive agent: full details, then a correction, then agreement');
const { respond } = await import('../lib/agent.js');
const { clearHistory } = await import('../lib/session.js');
const liveVin = VIN + 'L';
const liveChat = `live-${Math.random().toString(36).slice(2, 8)}`;
const live = { channel: 'web', chatId: liveChat, userName: 'Ariful Islam' };

await respond(
  `I want to book a shipment. Chassis ${liveVin}, Mercedes-Benz Actros 1845, tractor unit, ` +
  'my name is Ariful Islam, from Vilnius to Alexandria Port, 8266 kg, EXW, ready 20 September 2026.',
  live,
);
const corrected = await respond('i want to change incotermn EXW to FOB', live);
check(
  'never asks for a booking reference that does not exist',
  !/(booking reference|رقم الحجز)/i.test(corrected.reply),
  corrected.reply.replace(/\ns+/g, ' ').slice(0, 200),
);
check('shows the corrected Incoterm back', /FOB/.test(corrected.reply), corrected.reply.replace(/\ns+/g, ' ').slice(0, 200));
check('does not claim it is booked', !/\b(is booked|has been booked|booking (is )?(created|confirmed))\b/i.test(corrected.reply), corrected.reply.slice(0, 200));

const liveDraft = (await db().from('bookings').select('status, raw').eq('chat_id', liveChat).maybeSingle()).data;
check('the draft holds FOB and is still a draft', liveDraft?.status === 'draft' && liveDraft?.raw?.incoterm === 'FOB', `${JSON.stringify(liveDraft?.raw?.incoterm)} / ${liveDraft?.status} / tools: ${corrected.toolsUsed.join(',') || 'none'}`);

const agreed = await respond('yes that is correct, please book it', live);
const liveFinal = (await db().from('bookings').select('booking_ref, status, incoterm, raw').eq('chat_id', liveChat).maybeSingle()).data;
check('booking created after agreement', liveFinal?.status === 'pending_review', JSON.stringify(liveFinal?.status));
check('booked as FOB', (liveFinal?.incoterm ?? liveFinal?.raw?.incoterm) === 'FOB', JSON.stringify(liveFinal?.incoterm));
check('the reference reaches the customer', Boolean(liveFinal?.booking_ref) && agreed.reply.includes(liveFinal.booking_ref), agreed.reply.replace(/\s+/g, ' ').slice(0, 200));
check(
  'and the thank-you the company asked for',
  /Thank you for booking your freight/i.test(agreed.reply) && agreed.reply.includes('🙏'),
  agreed.reply.replace(/\s+/g, ' ').slice(0, 220),
);

await clearHistory('web', liveChat);
await db().from('bookings').delete().eq('chat_id', liveChat);
await db().from('shipments').delete().eq('vin', liveVin);

// 7 - "Start fresh": forget the conversation and the half-finished proposal,
// keep everything the customer actually booked.
console.log('\nstart fresh: clears the chat, keeps real bookings');
const { forgetConversation, saveHistory, loadHistory } = await import('../lib/session.js');
const chat7 = `fresh-${Math.random().toString(36).slice(2, 8)}`;
const ctx7 = { channel: 'web', chatId: chat7, turnId: 'f1', customerLanguage: 'en' };
await saveHistory('web', chat7, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]);
await runTool('create_booking', { ...DETAILS, vin: VIN + 'G' }, ctx7);                       // a draft
await runTool('create_booking', { ...DETAILS, vin: VIN + 'H' }, { ...ctx7, turnId: 'f2' });  // and another
await runTool('create_booking', { ...DETAILS, vin: VIN + 'H' }, { ...ctx7, turnId: 'f3' });  // ...confirmed

const beforeFresh = (await db().from('bookings').select('status').eq('chat_id', chat7)).data ?? [];
check('one draft at a time, not one per chassis', beforeFresh.filter((b) => b.status === 'draft').length <= 1, JSON.stringify(beforeFresh.map((b) => b.status)));

const { drafts } = await forgetConversation('web', chat7);
const afterFresh = (await db().from('bookings').select('status').eq('chat_id', chat7)).data ?? [];
check('the conversation is forgotten', (await loadHistory('web', chat7)).length === 0, 'history survived');
check('the unconfirmed draft is gone', afterFresh.every((b) => b.status !== 'draft'), JSON.stringify(afterFresh.map((b) => b.status)));
check('the real booking is untouched', afterFresh.some((b) => b.status === 'pending_review'), JSON.stringify(afterFresh.map((b) => b.status)));
check('and it says what it dropped', typeof drafts === 'number', JSON.stringify(drafts));

await db().from('bookings').delete().eq('chat_id', chat7);
await db().from('shipments').delete().in('vin', [VIN + 'G', VIN + 'H']);

// cleanup
for (const id of [chatId, chat2, chat3, chat4, chat5, chat6]) await db().from('bookings').delete().eq('chat_id', id);
await db().from('shipments').delete().in('vin', [VIN, VIN + 'B', VIN + 'C', VIN + 'D', VIN + 'E', VIN + 'F']);

console.log(`\n${problems.length === 0 ? 'all checks pass' : problems.length + ' failed: ' + problems.join(', ')}`);
process.exit(problems.length === 0 ? 0 : 1);
