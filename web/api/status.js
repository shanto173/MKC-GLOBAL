/**
 * What this visitor has in flight, for the strip above the web chat.
 *
 *   GET /api/status?sessionId=...
 *
 * The same thing the pinned card shows on Telegram: a customer should be able
 * to see where their vehicle is without asking for it again.
 *
 * The session id is the random one the browser made for itself and keeps in
 * localStorage - the same key /api/chat is trusted with. It only ever returns
 * rows created from that session.
 */

import { config } from '../lib/config.js';
import { activeItems } from '../lib/pinned.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const sessionId = String(req.query.sessionId ?? '').trim();
  if (!sessionId || sessionId.length > 100) {
    return res.status(400).json({ error: 'A sessionId is required.' });
  }

  try {
    const items = await activeItems(sessionId);
    // Never cached: a status the customer is watching must not be a stale copy.
    res.setHeader('cache-control', 'no-store');
    return res.status(200).json({ company: config.companyName, count: items.length, items });
  } catch (err) {
    console.error('status failed:', err.message);
    return res.status(200).json({ company: config.companyName, count: 0, items: [] });
  }
}
