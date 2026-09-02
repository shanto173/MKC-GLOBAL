/**
 * Talks to the agent from your terminal - no Telegram, no deploy needed.
 *
 *   npm run smoke                      run the standard question set
 *   npm run smoke -- "where is MKC-24001?"   ask one question
 *   npm run smoke -- --chat            interactive REPL
 */

import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { respond } from '../lib/agent.js';
import { clearHistory } from '../lib/session.js';

const ctx = { channel: 'web', chatId: `smoke-${Date.now()}`, userName: 'Tester' };

const DEFAULT_QUESTIONS = [
  'hi',
  'Where is my shipment MKC-24001?',
  'What documents do I need for an import booking?',
  'What is the ACID number and why was MKC-24006 put on hold?',
  'How long does it take from Rotterdam to Alexandria?',
  'I want to book a shipment of 2 pallets of olive oil from Barcelona to Port Said, 900 kg, ready next Monday. I am Sara Aziz, sara@example.com.',
];

const args = process.argv.slice(2);

if (args.includes('--chat')) {
  const rl = readline.createInterface({ input, output });
  console.log('Type a message, or "exit" to quit.\n');
  while (true) {
    const line = (await rl.question('you  > ')).trim();
    if (!line || line === 'exit') break;
    const { reply, toolsUsed } = await respond(line, ctx);
    console.log(`bot  > ${reply}`);
    if (toolsUsed.length) console.log(`       [tools: ${toolsUsed.join(', ')}]`);
    console.log();
  }
  rl.close();
} else {
  const questions = args.length ? [args.join(' ')] : DEFAULT_QUESTIONS;
  for (const q of questions) {
    console.log(`\n──────────────────────────────────────────────\nyou  > ${q}`);
    const start = Date.now();
    const { reply, toolsUsed } = await respond(q, ctx);
    console.log(`bot  > ${reply}`);
    console.log(`       [${((Date.now() - start) / 1000).toFixed(1)}s${toolsUsed.length ? ', tools: ' + toolsUsed.join(', ') : ''}]`);
  }
}

await clearHistory(ctx.channel, ctx.chatId);
