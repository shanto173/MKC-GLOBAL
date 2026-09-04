/**
 * Tests the booking conversation without touching the database.
 *
 * The tools are replaced with canned results, so this checks the one thing the
 * prompt is responsible for: does the bot follow the roadmap's steps, in order,
 * and refuse to book a unit that is already booked or unconfirmed.
 *
 *   npm run flowtest
 */

import 'dotenv/config';
import { systemPrompt } from '../lib/agent.js';
import { toolDefinitions } from '../lib/tools.js';
import { chat } from '../lib/llm.js';

const ctx = { channel: 'telegram', chatId: '999', userName: 'Arif' };
const sys = systemPrompt(ctx);

/** Runs a scripted conversation, recording which tools were called on each turn. */
async function converse(turns) {
  const messages = [];
  const byTurn = [];

  for (const turn of turns) {
    const called = [];
    turn.onTurn?.();
    messages.push({ role: 'user', content: turn.user });

    for (let step = 0; step < 4; step++) {
      const { content, toolCalls } = await chat({ system: sys, messages, tools: toolDefinitions });
      if (!toolCalls.length) {
        messages.push({ role: 'assistant', content });
        break;
      }
      messages.push({ role: 'assistant', content, tool_calls: toolCalls });
      for (const c of toolCalls) {
        called.push({ name: c.name, args: c.args });
        const canned = typeof turn.results?.[c.name] === 'function'
          ? turn.results[c.name](c.args)
          : turn.results?.[c.name] ?? { ok: true };
        messages.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: JSON.stringify(canned) });
      }
    }
    byTurn.push(called);
  }

  const reply = [...messages].reverse().find((m) => m.role === 'assistant' && m.content)?.content ?? '';
  return { byTurn, reply, all: byTurn.flat() };
}

const scenarios = [
  {
    name: 'new chassis: look up, ask for basics, do not book',
    turns: [{
      user: 'Hi, I want to book a shipment. Chassis W1T96340310484233',
      results: { lookup_vehicle: { verdict: 'new', known: false, next_step: 'This unit is new to us. Ask for make and model, the customer name, and the route.' } },
    }],
    check: ({ all }) => {
      if (!all.some((c) => c.name === 'lookup_vehicle')) return 'did not call lookup_vehicle';
      if (all.some((c) => c.name === 'create_booking')) return 'booked before collecting anything';
      return true;
    },
  },
  {
    name: 'already booked: give the existing reference and stop',
    turns: [{
      user: 'I want to book chassis W1T96340310484233',
      results: {
        lookup_vehicle: {
          verdict: 'already_booked',
          existing_booking: { booking_ref: 'MKY-BKG-260904-9XKQ', status: 'pending_review', origin_port: 'Vilnius', destination_port: 'Alexandria Port (incl. El Dekheila)' },
          next_step: 'This unit is ALREADY BOOKED under MKY-BKG-260904-9XKQ (Vilnius to Alexandria Port, status pending_review). Tell the customer, give the reference, and do not start a new booking.',
        },
      },
    }],
    check: ({ all, reply }) => {
      if (all.some((c) => c.name === 'create_booking')) return 'created a duplicate for an already-booked unit';
      if (!/9XKQ/i.test(reply)) return 'did not give the existing reference';
      return true;
    },
  },
  {
    name: 'full flow: summarise, wait for agreement, then book',
    // create_booking here behaves exactly as the real tool does: the first call
    // in a turn only drafts, and only a call in a LATER turn actually books.
    turns: (() => {
      let draftedOnTurn = null;
      let currentTurn = 0;
      const booking = () => (args) => {
        if (draftedOnTurn === null || draftedOnTurn === currentTurn) {
          draftedOnTurn = currentTurn;
          return {
            ok: false,
            needs_confirmation: true,
            message:
              'NOT booked yet. Read this summary back to the customer and ask them to confirm: ' +
              `Chassis ${String(args.vin).toUpperCase()}; vehicle ${[args.make, args.model].filter(Boolean).join(' ')}; ` +
              `route ${args.origin_port} to ${args.destination_port}; customer ${args.customer_name}. ` +
              'When they reply agreeing, call create_booking again with the same details.',
          };
        }
        return { ok: true, booking_ref: 'MKY-BKG-260904-AB12', status: 'pending_review' };
      };
      return [
        {
          user: 'Book chassis W1T96340310484233',
          onTurn: () => { currentTurn = 0; },
          results: { lookup_vehicle: { verdict: 'new', known: false, next_step: 'New unit. Ask for make and model, customer name, and route.' } },
        },
        {
          user: 'Mercedes-Benz Actros 1845, I am Arif Rahman, from Vilnius to Alexandria. The engine is damaged.',
          onTurn: () => { currentTurn = 1; },
          results: { create_booking: booking() },
        },
        {
          user: 'Yes that is correct, please book it',
          onTurn: () => { currentTurn = 2; },
          results: { create_booking: booking() },
        },
      ];
    })(),
    check: ({ byTurn, all, reply }) => {
      if (!all.some((c) => c.name === 'create_booking')) return 'never booked';
      if (byTurn[2].every((c) => c.name !== 'create_booking')) return 'did not book after the customer agreed';
      const final = byTurn[2].find((c) => c.name === 'create_booking').args;
      if (String(final.vin).toUpperCase().replace(/\s/g, '') !== 'W1T96340310484233') return `wrong VIN: ${final.vin}`;
      if (!/mercedes/i.test(final.make ?? '')) return `wrong make: ${final.make}`;
      if (!/alexandria/i.test(final.destination_port ?? '')) return `wrong destination: ${final.destination_port}`;
      if (!/AB12/i.test(reply)) return 'did not give the customer the reference';
      return true;
    },
  },
  {
    name: 'turn 2 reply must not claim a booking exists',
    turns: [
      {
        user: 'Book chassis W1T96340310484233, Mercedes Actros, Arif Rahman, Vilnius to Alexandria',
        results: {
          lookup_vehicle: { verdict: 'new', known: false, next_step: 'New unit.' },
          create_booking: {
            ok: false,
            needs_confirmation: true,
            message:
              'NOT booked yet. Read this summary back to the customer and ask them to confirm: ' +
              'Chassis W1T96340310484233; vehicle Mercedes-Benz Actros; route Vilnius to Alexandria Port; ' +
              'customer Arif Rahman. When they reply agreeing, call create_booking again.',
          },
        },
      },
    ],
    check: ({ reply }) => {
      if (/\b(is booked|has been booked|booking (is )?(created|confirmed)|successfully booked)\b/i.test(reply)) {
        return 'told the customer a booking exists when the tool refused: ' + reply.slice(0, 120);
      }
      if (!/confirm|correct\?|is that right/i.test(reply)) return 'did not ask the customer to confirm';
      return true;
    },
  },
];

let passed = 0;
for (const s of scenarios) {
  const result = await converse(s.turns);
  const verdict = s.check(result);
  const ok = verdict === true;
  if (ok) passed++;
  console.log(`\n=== ${s.name}`);
  console.log('  turns  :', result.byTurn.map((t) => t.map((c) => c.name).join('+') || '-').join(' | '));
  console.log('  reply  :', result.reply.replace(/\s+/g, ' ').slice(0, 160));
  console.log('  ' + (ok ? 'PASS' : 'FAIL: ' + verdict));
}

console.log(`\n${passed}/${scenarios.length} scenarios pass`);
process.exit(passed === scenarios.length ? 0 : 1);
