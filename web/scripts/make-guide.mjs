/**
 * The customer booking guide, as a PDF you can send to anybody.
 *
 *   npm run guide
 *
 * One file, both languages: Arabic first because that is who reads it, then the
 * same guide in English. It is generated rather than written by hand so that
 * when the flow changes, the guide changes with it - a printed guide that has
 * drifted from the bot is worse than none.
 *
 * Uses the same machinery as the booking confirmation: PDFKit, the Amiri font,
 * and the run-level bidi reordering in lib/rtl.js.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import PDFDocument from 'pdfkit';
import { config } from '../lib/config.js';
import { DESTINATION_PORTS } from '../lib/config.js';
import { drawBidiLine, drawBidiParagraph, ARABIC_WORD_SPACING } from '../lib/rtl.js';

const FONT_DIR = fileURLToPath(new URL('../assets/fonts/', import.meta.url));
const AMIRI = path.join(FONT_DIR, 'Amiri-Regular.ttf');
const AMIRI_BOLD = path.join(FONT_DIR, 'Amiri-Bold.ttf');

const INK = '#12202e';
const MUTED = '#5b6b7c';
const BRAND = '#0b4a6f';
const ACCENT = '#1f7ab0';
const LINE = '#d8e0e8';
const SOFT = '#eef4f9';

const LEFT = 50;
const RIGHT = 545;
const WIDTH = RIGHT - LEFT;
const TOP = 62;
const BOTTOM = 748;

const BOT = process.env.TELEGRAM_BOT_USERNAME || 'MKC_Global_bot';
const SITE = (config.publicBaseUrl || 'https://mkc-global.vercel.app').replace(/^https?:\/\//, '');
const COMPANY = config.companyName;

// ---------------------------------------------------------------------------
// What the guide says. One shape, two languages, so they cannot drift apart.
// ---------------------------------------------------------------------------

const GUIDE = {
  title: {
    en: 'How to book your shipment',
    ar: 'إزاي تحجز شحنتك',
  },
  subtitle: {
    en: 'A step-by-step guide for customers',
    ar: 'دليل خطوة بخطوة للعملاء',
  },
  intro: {
    en: `You can book a vehicle with ${COMPANY} in a few minutes, at any hour, from your phone. `
      + 'Our assistant takes the details, reads your documents, and gives you a booking reference '
      + 'and a PDF copy straight away. Write to it in Arabic or in English - it answers in whichever '
      + 'you use.',
    ar: `تقدر تحجز عربيتك مع ${COMPANY} في دقايق، في أي وقت، من موبايلك. `
      + 'المساعد بتاعنا هياخد منك البيانات، يقرا مستنداتك، ويديك رقم حجز ونسخة PDF على طول. '
      + 'اكتبله بالعربي أو بالإنجليزي - هيرد عليك بنفس اللغة.',
  },

  whereTitle: { en: 'Where to start', ar: 'تبدأ منين' },
  where: {
    en: [
      `On Telegram: search for @${BOT}, open it and press Start.`,
      `On the web: open ${SITE} in any browser - no app needed.`,
      'Either one works the same way, and both are open 24 hours.',
    ],
    ar: [
      `على تليجرام: دور على @${BOT}، افتحه واضغط Start.`,
      `على الموقع: افتح ${SITE} من أي متصفح - من غير أي تطبيق.`,
      'الاتنين بيشتغلوا بنفس الطريقة، ومتاحين 24 ساعة.',
    ],
  },

  menuTitle: { en: 'The menu', ar: 'القائمة' },
  menuIntro: {
    en: 'The first message gives you three choices. Reply with the number alone:',
    ar: 'أول رسالة هتديك ٣ اختيارات. رد بالرقم لوحده:',
  },
  menu: {
    en: [
      ['1', 'Book my shipment - start a new booking'],
      ['2', 'Track my shipment - where is my vehicle now'],
      ['3', 'Contact our team - a person will reply'],
    ],
    ar: [
      ['1', 'احجز شحنة - تبدأ حجز جديد'],
      ['2', 'تتبع شحنتي - عربيتك فين دلوقتي'],
      ['3', 'تواصل مع فريقنا - حد من الفريق هيرد عليك'],
    ],
  },

  steps: [
    {
      n: 1,
      title: { en: 'Send the chassis number', ar: 'ابعت رقم الشاسيه' },
      body: {
        en: 'This is the first thing we ask for, and everything else hangs off it. It is the 17-character '
          + 'number on the chassis plate and on your invoice - the VIN. Send it on its own line, exactly as '
          + 'it is written. We check it against our records and tell you whether the unit is new to us, '
          + 'already on file, or already booked.',
        ar: 'ده أول حاجة بنطلبها، وكل حاجة تانية بتترتب عليه. هو الرقم المكون من 17 خانة الموجود على '
          + 'لوحة الشاسيه وعلى الفاتورة - VIN. ابعته لوحده بالظبط زي ما هو مكتوب. إحنا بنراجعه عندنا '
          + 'ونقولك الوحدة جديدة علينا، ولا مسجلة، ولا محجوزة قبل كده.',
      },
      example: { en: 'W1T96340310484233', ar: 'W1T96340310484233' },
    },
    {
      n: 2,
      title: { en: 'Give the basic details', ar: 'اكتب البيانات الأساسية' },
      body: {
        en: 'We ask one or two things at a time so it stays easy on a phone, but you can send everything '
          + 'in one message if you prefer. If the vehicle has any damage - engine, gearbox, accident, not '
          + 'running - say so. It changes how the unit is cleared, and hiding it causes trouble at the port, '
          + 'not before.',
        ar: 'بنسأل حاجة أو اتنين في المرة عشان يبقى سهل على الموبايل، بس تقدر تبعت كل حاجة في رسالة '
          + 'واحدة لو تحب. لو في أي تلف في العربية - موتور، فتيس، حادثة، مش بتمشي - قول. ده بيغير طريقة '
          + 'التخليص، وإخفاؤه بيعمل مشاكل في الميناء مش قبل كده.',
      },
    },
    {
      n: 3,
      title: { en: 'Send your documents', ar: 'ابعت المستندات' },
      body: {
        en: 'Send them as files or just photograph them with your phone - we read scans and photos the same '
          + 'way, in Arabic, English, German or Polish. We check that the chassis number matches across all '
          + 'of them, because a mismatch is what gets a customs declaration rejected.',
        ar: 'ابعتهم ملفات أو صورهم بموبايلك - بنقرا الاسكان والصور بنفس الطريقة، بالعربي أو الإنجليزي '
          + 'أو الألماني أو البولندي. وبنتأكد إن رقم الشاسيه واحد في كل المستندات، لأن الاختلاف ده هو '
          + 'اللي بيرفض البيان الجمركي.',
      },
    },
    {
      n: 4,
      title: { en: 'Check the summary', ar: 'راجع الملخص' },
      body: {
        en: 'We show you a summary card built from exactly what you told us - never from what we assumed. '
          + 'Read it. Nothing is booked while that card is on the screen. If something is wrong, say what to '
          + 'change in plain words and a corrected card comes back. When it is right, say yes.',
        ar: 'هنوريك كارت ملخص مبني بالظبط على اللي قولته - مش على أي حاجة إحنا افترضناها. اقراه كويس. '
          + 'مفيش أي حجز بيتم والكارت ده على الشاشة. لو في حاجة غلط، قول عايز تغير إيه بكلام عادي '
          + 'وهيرجعلك كارت متصحح. لما يبقى مظبوط، قول أيوه.',
      },
    },
    {
      n: 5,
      title: { en: 'You are booked', ar: 'تم الحجز' },
      body: {
        en: 'You get a booking reference like MKY-BKG-260907-AB12 and a PDF copy in the chat. Booking '
          + 'Operations reviews it and confirms space and price - normally within one business day. After '
          + 'that a status card is pinned to the top of your chat and follows your vehicle until it is '
          + 'delivered, so you never have to ask where it is.',
        ar: 'هتاخد رقم حجز زي MKY-BKG-260907-AB12 ونسخة PDF في المحادثة. قسم عمليات الحجز هيراجعه '
          + 'ويأكد المساحة والسعر - عادةً خلال يوم عمل واحد. بعد كده هيتثبت كارت حالة فوق في المحادثة '
          + 'ويفضل يتابع عربيتك لحد ما توصل، فمش هتحتاج تسأل هي فين.',
      },
    },
  ],

  fieldsTitle: { en: 'What we need from you', ar: 'إحنا محتاجين منك إيه' },
  fieldsIntro: {
    en: 'The five marked "required" are the least we can book with. The rest can follow later.',
    ar: 'الخمسة المكتوب جنبهم "مطلوب" هما أقل حاجة نقدر نحجز بيها. الباقي ممكن يجي بعدين.',
  },
  fields: {
    en: [
      ['Chassis / VIN', 'required', 'W1T96340310484233'],
      ['Make and model', 'required', 'Mercedes-Benz Actros 1845'],
      ['Your name', 'required', 'Ariful Islam'],
      ['Port or city of loading', 'required', 'Vilnius'],
      ['Egyptian port', 'required', 'Alexandria Port'],
      ['Vehicle type', 'optional', 'tractor unit, truck, trailer, van'],
      ['Condition / damage', 'if any', 'engine damaged, does not run'],
      ['Gross weight', 'optional', '8,266 kg'],
      ['Incoterm', 'optional', 'EXW, FOB, CIF or DAP'],
      ['Cargo ready date', 'optional', '20 October 2026'],
      ['Company name', 'optional', 'Rahman Trading Co.'],
      ['Email or phone', 'optional', 'you@example.com'],
      ['MRN number', 'optional', 'if you already have one'],
      ['ACID number', 'optional', '19 digits from Nafeza'],
    ],
    ar: [
      ['رقم الشاسيه', 'مطلوب', 'W1T96340310484233'],
      ['الماركة والموديل', 'مطلوب', 'Mercedes-Benz Actros 1845'],
      ['اسمك', 'مطلوب', 'عارف إسلام'],
      ['ميناء أو مدينة الشحن', 'مطلوب', 'Vilnius'],
      ['الميناء المصري', 'مطلوب', 'ميناء الإسكندرية'],
      ['نوع المركبة', 'اختياري', 'جرار، لوري، مقطورة، فان'],
      ['حالة المركبة / التلف', 'لو في', 'الموتور تالف، مش بتمشي'],
      ['الوزن الإجمالي', 'اختياري', '8,266 كجم'],
      ['شرط التسليم', 'اختياري', 'EXW أو FOB أو CIF أو DAP'],
      ['تاريخ جاهزية البضاعة', 'اختياري', '20 أكتوبر 2026'],
      ['اسم الشركة', 'اختياري', 'شركة رحمن للتجارة'],
      ['إيميل أو تليفون', 'اختياري', 'you@example.com'],
      ['رقم MRN', 'اختياري', 'لو عندك واحد بالفعل'],
      ['رقم ACID', 'اختياري', '19 رقم من منصة نافذة'],
    ],
  },

  portsTitle: { en: 'The ports we deliver to', ar: 'الموانئ اللي بنشحن ليها' },
  portsNote: {
    en: 'We only book to these five. If you name anywhere else, we will say so rather than guess.',
    ar: 'إحنا بنحجز للخمسة دول بس. لو قولت مكان تاني، هنقولك بدل ما نخمن.',
  },

  docsTitle: { en: 'The documents, explained', ar: 'المستندات، بالتفصيل' },
  docs: {
    en: [
      ['Commercial invoice', 'The seller\'s invoice showing the vehicle, the price and the currency.'],
      ['Transport document or EUR.1', 'Proves where the vehicle comes from. EUR.1 can reduce duty on EU goods.'],
      ['MRN', 'The export declaration number from the country you are shipping from. If you do not have one, tell us - we can obtain it for you.'],
      ['ACID', 'A 19-digit number registered on the Egyptian Nafeza platform BEFORE the cargo ships. Without a valid ACID, cargo arriving in Egypt cannot be cleared and starts accruing demurrage. This one is not optional.'],
    ],
    ar: [
      ['الفاتورة التجارية', 'فاتورة البائع وفيها العربية والسعر والعملة.'],
      ['مستند النقل أو EUR.1', 'بيثبت العربية جاية منين. شهادة EUR.1 ممكن تقلل الجمارك على بضاعة الاتحاد الأوروبي.'],
      ['رقم MRN', 'رقم بيان التصدير من بلد الشحن. لو مش عندك، قولنا - إحنا نقدر نستخرجه لك.'],
      ['رقم ACID', 'رقم من 19 خانة بيتسجل على منصة نافذة المصرية قبل ما البضاعة تشحن. من غير ACID صالح، البضاعة اللي توصل مصر مش هتتخلص وهتبدأ أرضيات. ده مش اختياري.'],
    ],
  },
  docsNote: {
    en: 'You do not need any of these to make the booking. Book now, send them later - we will tell you what is still missing each time you send one.',
    ar: 'مش لازم أي حاجة من دي عشان تعمل الحجز. احجز دلوقتي وابعتهم بعدين - وإحنا هنقولك الناقص إيه في كل مرة تبعت فيها مستند.',
  },

  copyTitle: { en: 'One message that does it all', ar: 'رسالة واحدة تعمل كل ده' },
  copyIntro: {
    en: 'If you would rather not answer question by question, send something like this and we will do the rest:',
    ar: 'لو مش عايز تجاوب سؤال ورا سؤال، ابعت حاجة زي دي وإحنا نكمل الباقي:',
  },
  copyExample: {
    en: 'I want to book a shipment. Chassis W1T96340310484233, Mercedes-Benz Actros 1845 tractor unit, '
      + 'my name is Ariful Islam, from Vilnius to Alexandria Port, 8,266 kg, EXW, engine damaged, '
      + 'ready 20 October 2026.',
    ar: 'عايز أحجز شحنة. رقم الشاسيه W1T96340310484233، مرسيدس أكتروس 1845، اسمي عارف إسلام، '
      + 'من فيلنيوس لميناء الإسكندرية، الوزن 8266 كيلو، EXW، الموتور تالف، جاهزة 20 أكتوبر 2026',
  },

  changeTitle: { en: 'Changing something', ar: 'تغيير حاجة' },
  change: {
    en: [
      ['Before you say yes', 'Just say what is wrong - "change the Incoterm to FOB", "the weight is 9,100 kg". A corrected summary comes back for you to check. Nothing is booked until you agree.'],
      ['After you have the reference', 'Say what to change and quote the booking reference. We can still edit it while it is waiting for review.'],
      ['After Operations confirms it', 'Reply 3 and a person will pick it up - a confirmed booking is being worked on, so we do not change it silently.'],
    ],
    ar: [
      ['قبل ما تقول أيوه', 'قول الغلط إيه بس - "غير شرط التسليم لـ FOB"، "الوزن 9,100 كيلو". هيرجعلك ملخص متصحح تراجعه. مفيش حجز بيتم قبل ما توافق.'],
      ['بعد ما تاخد رقم الحجز', 'قول عايز تغير إيه واذكر رقم الحجز. لسه نقدر نعدله وهو في انتظار المراجعة.'],
      ['بعد ما العمليات تأكده', 'رد بـ 3 وحد من الفريق هيتابع - الحجز المؤكد بيبقى شغال عليه، فمابنغيرهوش من غير ما حد ياخد باله.'],
    ],
  },

  glossaryTitle: { en: 'Words you will see', ar: 'كلمات هتقابلك' },
  glossary: {
    en: [
      ['Chassis / VIN', '17 characters that identify one vehicle, like a fingerprint.'],
      ['Incoterm', 'Who pays for what, and where the risk passes from seller to buyer.'],
      ['EXW', 'You collect from the seller\'s yard. Everything after that is yours.'],
      ['FOB', 'The seller delivers it onto the ship. Sea freight onward is yours.'],
      ['CIF', 'Price includes sea freight and insurance to the Egyptian port.'],
      ['DAP', 'Delivered to an agreed place in Egypt, duty not paid.'],
      ['ETD / ETA', 'Estimated date the vessel sails / arrives.'],
      ['B/L', 'Bill of Lading - the shipping line\'s receipt and title document.'],
      ['Demurrage', 'What the port charges when cargo sits too long. Usually caused by paperwork.'],
    ],
    ar: [
      ['رقم الشاسيه', '17 خانة بتحدد عربية واحدة بالظبط، زي البصمة.'],
      ['شرط التسليم', 'مين بيدفع إيه، والمسؤولية بتنتقل من البائع للمشتري فين.'],
      ['EXW', 'إنت اللي بتستلم من ساحة البائع. وكل حاجة بعد كده عليك.'],
      ['FOB', 'البائع بيسلمها على المركب. الشحن البحري بعد كده عليك.'],
      ['CIF', 'السعر شامل الشحن البحري والتأمين لحد الميناء المصري.'],
      ['DAP', 'التسليم في مكان متفق عليه في مصر، من غير دفع الجمارك.'],
      ['ETD / ETA', 'التاريخ المتوقع لإبحار المركب / لوصولها.'],
      ['B/L', 'بوليصة الشحن - إيصال خط الملاحة ومستند الملكية.'],
      ['أرضيات', 'اللي الميناء بيحصله لما البضاعة تقعد كتير. غالباً بسبب الورق.'],
    ],
  },

  faqTitle: { en: 'Common questions', ar: 'أسئلة متكررة' },
  faq: {
    en: [
      ['Where is my vehicle?', 'Reply 2, or send your chassis number or booking reference. The pinned card at the top of the chat also shows it without asking.'],
      ['Is my booking confirmed?', 'A booking reference means we have your request. Confirmed means Operations has accepted it - you get a separate message for that.'],
      ['Can I book two vehicles?', 'Yes, one at a time. Each chassis number is its own booking, so each one can be tracked on its own.'],
      ['Do you quote prices?', 'Not through the assistant. Price and space are always confirmed by a person.'],
      ['I want to start over', 'Press the Start fresh button, or send /reset. Your confirmed bookings and shipments are never affected.'],
      ['I want a human', 'Reply 3, tell us which department, and somebody will come back to you in working hours.'],
    ],
    ar: [
      ['عربيتي فين؟', 'رد بـ 2، أو ابعت رقم الشاسيه أو رقم الحجز. كمان الكارت المثبت فوق في المحادثة بيوريك من غير ما تسأل.'],
      ['هل حجزي اتأكد؟', 'رقم الحجز معناه إن طلبك وصلنا. التأكيد معناه إن العمليات وافقت - وده بييجيلك في رسالة منفصلة.'],
      ['أقدر أحجز عربيتين؟', 'أيوه، واحدة ورا التانية. كل رقم شاسيه بيبقى حجز لوحده، وبالتالي بيتتبع لوحده.'],
      ['بتدوني سعر؟', 'مش من خلال المساعد. السعر والمساحة دايماً بيأكدهم موظف.'],
      ['عايز أبدأ من الأول', 'اضغط زرار "ابدأ من جديد" أو ابعت /reset. حجوزاتك المؤكدة وشحناتك مش بتتأثر خالص.'],
      ['عايز أكلم حد', 'رد بـ 3، قولنا أي قسم، وحد هيرجعلك في مواعيد العمل.'],
    ],
  },

  closing: {
    en: 'That is the whole process. If anything is unclear, reply 3 at any point and a colleague will take over from where you stopped.',
    ar: 'ودي كل الحكاية. لو في أي حاجة مش واضحة، رد بـ 3 في أي وقت وحد من الفريق هيكمل معاك من مكان ما وقفت.',
  },
};

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function renderGuide(doc, lang, { firstPage }) {
  const rtl = lang === 'ar';
  const REG = 'body';
  const BOLD = 'bodyBold';
  const dir = rtl ? 'rtl' : 'ltr';
  const align = rtl ? 'right' : 'left';
  const spacing = (text) => (rtl && /[؀-ۿ]/.test(text) ? ARABIC_WORD_SPACING : 0);

  if (!firstPage) doc.addPage();
  let y = 0;

  const newPage = () => {
    doc.addPage();
    return TOP;
  };
  const room = (needed) => {
    if (y + needed > BOTTOM) y = newPage();
  };

  const line = (text, x, yy, width, { size = 10, font = REG, color = INK, at = align } = {}) => {
    doc.font(font).fontSize(size).fillColor(color);
    drawBidiLine(doc, text, x, yy, width, { align: at, baseDir: dir, wordSpacing: spacing(text) });
  };

  const para = (text, x, yy, width, { size = 10, font = REG, color = INK, lineGap = 3.5 } = {}) => {
    doc.font(font).fontSize(size).fillColor(color);
    return drawBidiParagraph(doc, text, x, yy, width, {
      align, baseDir: dir, lineGap, wordSpacing: spacing(text), maxY: BOTTOM, onPageBreak: newPage,
    });
  };

  // ---- masthead ----------------------------------------------------------
  doc.rect(0, 0, 595, 128).fill(BRAND);
  line(COMPANY, LEFT, 26, WIDTH, { size: 19, font: BOLD, color: '#ffffff' });
  line(GUIDE.title[lang], LEFT, 58, WIDTH, { size: 25, font: BOLD, color: '#ffffff' });
  line(GUIDE.subtitle[lang], LEFT, 94, WIDTH, { size: 11, color: '#bfd8e8' });
  y = 152;

  y = para(GUIDE.intro[lang], LEFT, y, WIDTH, { size: 10.5, lineGap: 4 }) + 14;

  // ---- section heading ---------------------------------------------------
  const heading = (text) => {
    room(52);
    line(text, LEFT, y, WIDTH, { size: 13, font: BOLD, color: BRAND });
    y += 19;
    doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 10;
  };

  const bullet = (text, { size = 10 } = {}) => {
    room(20);
    const dotX = rtl ? RIGHT - 4 : LEFT + 4;
    doc.circle(dotX, y + 5.5, 1.8).fill(ACCENT);
    const end = para(text, rtl ? LEFT : LEFT + 14, y, WIDTH - 16, { size });
    y = Math.max(end, y + 13) + 2;
  };

  /** A two-column row: a label on one side, the explanation on the other. */
  const row = (label, value, { labelWidth = 150, size = 9.5, badge = null } = {}) => {
    room(22);
    const valueWidth = WIDTH - labelWidth - 14;
    if (rtl) {
      line(label, RIGHT - labelWidth, y, labelWidth, { size, font: BOLD, at: 'right' });
      if (badge) line(badge, RIGHT - labelWidth, y + 12, labelWidth, { size: 8, color: MUTED, at: 'right' });
      const end = para(value, LEFT, y, valueWidth, { size });
      y = Math.max(end, y + (badge ? 24 : 13));
    } else {
      line(label, LEFT, y, labelWidth, { size, font: BOLD, at: 'left' });
      if (badge) line(badge, LEFT, y + 12, labelWidth, { size: 8, color: MUTED, at: 'left' });
      const end = para(value, LEFT + labelWidth + 14, y, valueWidth, { size });
      y = Math.max(end, y + (badge ? 24 : 13));
    }
    y += 3;
  };

  /** The grey box that holds something to copy. */
  const box = (text, { size = 10, font = REG } = {}) => {
    doc.font(font).fontSize(size);
    const height = Math.ceil(doc.widthOfString(text) / (WIDTH - 28)) * (doc.currentLineHeight() + 3) + 22;
    room(height + 8);
    doc.roundedRect(LEFT, y, WIDTH, height, 6).fill(SOFT);
    const end = para(text, LEFT + 14, y + 11, WIDTH - 28, { size, font, color: BRAND, lineGap: 3 });
    y = Math.max(end + 11, y + height) + 12;
  };

  // ---- where to start ----------------------------------------------------
  heading(GUIDE.whereTitle[lang]);
  for (const item of GUIDE.where[lang]) bullet(item);
  y += 6;

  // ---- the menu ----------------------------------------------------------
  heading(GUIDE.menuTitle[lang]);
  y = para(GUIDE.menuIntro[lang], LEFT, y, WIDTH) + 8;
  for (const [digit, text] of GUIDE.menu[lang]) {
    room(24);
    const cx = rtl ? RIGHT - 11 : LEFT + 11;
    doc.circle(cx, y + 7, 10.5).fill(ACCENT);
    doc.font(BOLD).fontSize(11).fillColor('#ffffff');
    doc.text(digit, cx - 8, y + 1, { width: 16, align: 'center', lineBreak: false });
    const end = para(text, rtl ? LEFT : LEFT + 28, y, WIDTH - 30, { size: 10 });
    y = Math.max(end, y + 16) + 5;
  }
  y += 6;

  // ---- the five steps ----------------------------------------------------
  for (const step of GUIDE.steps) {
    room(96);
    const cx = rtl ? RIGHT - 13 : LEFT + 13;
    doc.circle(cx, y + 12, 13).fill(BRAND);
    doc.font(BOLD).fontSize(13).fillColor('#ffffff');
    doc.text(String(step.n), cx - 9, y + 4, { width: 18, align: 'center', lineBreak: false });

    const textX = rtl ? LEFT : LEFT + 34;
    const textW = WIDTH - 34;
    line(step.title[lang], textX, y + 4, textW, { size: 12.5, font: BOLD, color: BRAND });
    y += 26;
    y = para(step.body[lang], textX, y, textW, { size: 10, lineGap: 3.5 }) + 6;

    if (step.example) {
      room(30);
      doc.roundedRect(rtl ? RIGHT - 220 : LEFT + 34, y, 220, 22, 4).fill(SOFT);
      doc.font(BOLD).fontSize(12).fillColor(BRAND);
      doc.text(step.example[lang], (rtl ? RIGHT - 220 : LEFT + 34) + 12, y + 6, { width: 200, lineBreak: false });
      y += 30;
    }
    y += 8;
  }

  // ---- what we need ------------------------------------------------------
  heading(GUIDE.fieldsTitle[lang]);
  y = para(GUIDE.fieldsIntro[lang], LEFT, y, WIDTH) + 8;
  for (const [label, need, example] of GUIDE.fields[lang]) {
    row(label, example, { labelWidth: 170, badge: need });
  }
  y += 8;

  // ---- ports -------------------------------------------------------------
  // A five-item list split across a page break reads as though we serve four
  // ports and then some, so it is kept whole.
  room(DESTINATION_PORTS.length * 17 + 76);
  heading(GUIDE.portsTitle[lang]);
  for (const port of DESTINATION_PORTS) bullet(port, { size: 10 });
  y += 2;
  y = para(GUIDE.portsNote[lang], LEFT, y, WIDTH, { size: 9.5, color: MUTED }) + 14;

  // ---- documents ---------------------------------------------------------
  heading(GUIDE.docsTitle[lang]);
  for (const [name, what] of GUIDE.docs[lang]) row(name, what, { labelWidth: 165, size: 10 });
  y += 4;
  y = para(GUIDE.docsNote[lang], LEFT, y, WIDTH, { size: 9.5, color: MUTED }) + 14;

  // ---- copy and paste ----------------------------------------------------
  heading(GUIDE.copyTitle[lang]);
  y = para(GUIDE.copyIntro[lang], LEFT, y, WIDTH) + 8;
  box(GUIDE.copyExample[lang], { size: 10.5 });

  // ---- changing something ------------------------------------------------
  heading(GUIDE.changeTitle[lang]);
  for (const [when, what] of GUIDE.change[lang]) row(when, what, { labelWidth: 165, size: 10 });
  y += 8;

  // ---- glossary ----------------------------------------------------------
  heading(GUIDE.glossaryTitle[lang]);
  for (const [term, meaning] of GUIDE.glossary[lang]) row(term, meaning, { labelWidth: 120, size: 9.5 });
  y += 8;

  // ---- questions ---------------------------------------------------------
  heading(GUIDE.faqTitle[lang]);
  for (const [q, a] of GUIDE.faq[lang]) row(q, a, { labelWidth: 175, size: 9.5 });
  y += 6;

  y = para(GUIDE.closing[lang], LEFT, y, WIDTH, { size: 10, color: MUTED }) + 10;

  // ---- contact strip -----------------------------------------------------
  room(60);
  doc.roundedRect(LEFT, y, WIDTH, 46, 6).fill(BRAND);
  line(COMPANY, LEFT + 16, y + 10, WIDTH - 32, { size: 11, font: BOLD, color: '#ffffff' });
  line(`${config.companyEmail}  ·  ${config.companyPhone}  ·  @${BOT}  ·  ${SITE}`,
    LEFT + 16, y + 27, WIDTH - 32, { size: 9, color: '#bfd8e8' });
  y += 58;
}

// ---------------------------------------------------------------------------

const out = fileURLToPath(new URL('../data/MKY-booking-guide.pdf', import.meta.url));
const doc = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: true, bufferPages: true });
doc.registerFont('body', AMIRI);
doc.registerFont('bodyBold', AMIRI_BOLD);

const chunks = [];
doc.on('data', (c) => chunks.push(c));
const finished = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

// Arabic first: it is who reads it. English after, for the same guide.
renderGuide(doc, 'ar', { firstPage: true });
renderGuide(doc, 'en', { firstPage: false });

// Page numbers, added at the end when the count is known.
const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(range.start + i);
  doc.font('body').fontSize(8.5).fillColor(MUTED);
  // Inside the bottom margin on purpose: text placed below it makes PDFKit add
  // a page to hold it, which doubled the length of this guide once already.
  doc.text(`${i + 1} / ${range.count}`, LEFT, 772, { width: WIDTH, align: 'center', lineBreak: false });
}

doc.end();
fs.writeFileSync(out, await finished);
console.log(`guide written: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${range.count} pages)`);
