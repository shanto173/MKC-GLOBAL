/**
 * Sends whatever is waiting in the notification outbox, from the terminal.
 *
 *   npm run outbox            send what is due
 *   npm run outbox -- --list  show the queue without sending anything
 *
 * In production the Vercel cron in vercel.json does this every five minutes,
 * and the flows drain inline after they queue something. This is for when you
 * want to see the queue, or push it along after fixing whatever was broken.
 */

import 'dotenv/config';
import { db } from '../lib/supabase.js';
import { drain } from '../lib/outbox.js';

const listOnly = process.argv.includes('--list');

if (listOnly) {
  const { data, error } = await db()
    .from('notification_outbox')
    .select('id, event_type, entity_id, status, attempt_count, available_at, last_error')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('could not read the outbox:', error.message);
    process.exit(1);
  }
  if (!data.length) {
    console.log('The outbox is empty.');
    process.exit(0);
  }

  for (const row of data) {
    const when = row.status === 'pending' ? ` due ${row.available_at}` : '';
    console.log(
      `${row.status.padEnd(8)} ${String(row.event_type).padEnd(32)} ${row.entity_id ?? ''}` +
      ` attempts=${row.attempt_count}${when}` +
      (row.last_error ? `\n         last error: ${row.last_error}` : ''),
    );
  }
  process.exit(0);
}

const result = await drain({ limit: 100 });
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
