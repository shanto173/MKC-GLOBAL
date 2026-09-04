/**
 * Checks that the bot understands Egyptian Arabic and Franco-Arabic, replies in
 * the same language, and leaves customs identifiers in Latin script.
 *
 *   npm run artest
 *   npm run artest -- --model gpt-4.1-mini    compare a different model
 */

import 'dotenv/config';
import { respond } from '../lib/agent.js';
import { clearHistory } from '../lib/session.js';

const modelArg = process.argv.indexOf('--model');
if (modelArg > -1) process.env.OPENAI_MODEL = process.argv[modelArg + 1];

const ARABIC = /[؀-ۿ]/;
const LATIN_WORDS = /[A-Za-z]{3,}/g;
const ARABIC_INDIC = /[٠-٩]/;

/** Words that are fine in Latin inside an Arabic reply - they are identifiers. */
const ALLOWED_LATIN = /^(ACID|MRN|EUR|VIN|MKC|MKY|BKG|TKT|SHP|FOB|EXW|CIF|DAP|LCL|FCL|ETA|ETD|MSC|CMA|CGM|ONE|Maersk|Hapag|Alexandria|Port|Said|Damietta|Ain|Sokhna|Suez|Rotterdam|Felixstowe|Antwerp|Hamburg|Valencia|Genoa|Savannah|Vilnius|Barcelona|Angeles|Los|New|York|Jersey|Gateway|London|Aurora|Nile|Express|Meridian|Thames|Genova|Pacific|Hamburg|Mercedes|Benz|Actros|Volvo|Scania|Nafeza|El|Dekheila|incl|Egypt|Global|Forwarding|Logistics|Booking|Operations|Accounts|Payments|Tracking|Desk|Customs|Documentation|Customer|Care|kg|cbm|LKW|UAB|SS)$/i;

const cases = [
  {
    name: 'Egyptian Arabic - tracking',
    ask: 'الشحنة بتاعتي فين؟ الرقم MKC-24001',
    expect: (r) => (/MKC-24001/.test(r) ? true : 'lost the shipment reference'),
  },
  {
    name: 'Egyptian Arabic - documents question',
    ask: 'محتاج ورق ايه عشان اعمل حجز جديد؟',
    expect: (r) => (/ACID/i.test(r) ? true : 'did not mention ACID, so it probably did not search the knowledge base'),
  },
  {
    name: 'Franco-Arabic - tracking',
    ask: 'el sha7na bta3ty fen? el number MKC-24004',
    expect: (r) => {
      if (!ARABIC.test(r)) return 'replied in Latin script instead of Arabic';
      if (!/MKC-24004/.test(r)) return 'lost the shipment reference';
      return true;
    },
  },
  {
    name: 'Franco-Arabic - booking intent',
    ask: '3ayez a7gez shehn 3araba men Rotterdam le Alexandria',
    expect: (r) => (ARABIC.test(r) ? true : 'replied in Latin script instead of Arabic'),
  },
  {
    name: 'English stays English',
    ask: 'Where is shipment MKC-24005?',
    expect: (r) => (ARABIC.test(r) ? 'replied in Arabic to an English question' : true),
  },
];

let pass = 0;
console.log(`model: ${process.env.OPENAI_MODEL}\n`);

for (const c of cases) {
  const ctx = { channel: 'web', chatId: `ar-${Math.random().toString(36).slice(2, 8)}` };
  const started = Date.now();
  const { reply, toolsUsed } = await respond(c.ask, ctx);
  await clearHistory(ctx.channel, ctx.chatId);

  const problems = [];
  const verdict = c.expect(reply);
  if (verdict !== true) problems.push(verdict);

  // Arabic replies carry the English translation after a single bar, so each
  // half is judged separately: Arabic on the left, English on the right.
  if (ARABIC.test(reply)) {
    const bars = (reply.match(/\|/g) || []).length;
    if (bars !== 1) problems.push(`expected exactly one | separating the languages, found ${bars}`);

    // A bracketed gloss is deliberate on both sides - "الفاتورة التجارية
    // (commercial invoice)" and "Alexandria Port (الإسكندرية)" are both wanted -
    // so parentheses are stripped before judging which language a half is in.
    const unglossed = (s) => s.replace(/\([^)]*\)/g, ' ');
    const [rawArabic = '', rawEnglish = ''] = reply.split('|');
    const arabicHalf = unglossed(rawArabic);
    const englishHalf = unglossed(rawEnglish);

    // Words no Egyptian uses in speech. الآن is deliberately not here - it is
    // ordinary in Egyptian business Arabic, unlike أين or أريد.
    const msa = ['أين', 'أريد', 'كيف حالك', 'ماذا', 'هل يمكن'].filter((w) => arabicHalf.includes(w));
    if (msa.length) problems.push(`formal MSA wording: ${msa.join(', ')}`);

    // Stray English is only a fault on the ARABIC side of the bar.
    const stray = [...(arabicHalf.match(LATIN_WORDS) || [])].filter((w) => !ALLOWED_LATIN.test(w));
    if (stray.length) problems.push(`untranslated English in the Arabic half: ${[...new Set(stray)].slice(0, 5).join(', ')}`);

    if (ARABIC_INDIC.test(arabicHalf)) problems.push('used Arabic-Indic digits');
    if (englishHalf && ARABIC.test(englishHalf)) problems.push('Arabic left in the English half');
    if (englishHalf && !/[A-Za-z]{3}/.test(englishHalf)) problems.push('English half has no English');
  }

  const ok = problems.length === 0;
  if (ok) pass++;
  console.log(`=== ${c.name}`);
  console.log(`  ask   : ${c.ask}`);
  console.log(`  reply : ${reply.replace(/\s+/g, ' ').slice(0, 190)}`);
  console.log(`  tools : ${toolsUsed.join(', ') || '-'}  [${((Date.now() - started) / 1000).toFixed(1)}s]`);
  console.log(`  ${ok ? 'PASS' : 'FAIL: ' + problems.join(' | ')}\n`);
}

console.log(`${pass}/${cases.length} pass`);
