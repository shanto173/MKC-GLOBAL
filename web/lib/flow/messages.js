/**
 * Every word the flow says to a client.
 *
 * All of it lives here rather than inside the handlers, for three reasons: the
 * wording is a business decision and should be reviewable in one place; every
 * message has to exist in both languages and a missing half is obvious in a
 * table and invisible in a handler; and the state machine's tests assert on
 * these strings, so they cannot drift from what the specification asks for.
 *
 * The house style, unchanged from the rest of the bot: Egyptian colloquial
 * Arabic first, a divider, then the same message in English. References,
 * chassis numbers, ports and Incoterms are identical in both halves because
 * they have to match the paperwork.
 */

const RULE = '━━━━━━━━━━━━';

/** Renders one bilingual message as the two stacked blocks Telegram can show. */
export function both(ar, en) {
  const top = String(ar ?? '').trim();
  const bottom = String(en ?? '').trim();
  if (!top) return bottom;
  if (!bottom) return top;
  return `${top}\n${RULE}\n${bottom}`;
}

/** A value we do not have. Never invented, never blank. */
export const NOT_AVAILABLE = { ar: 'لسه مش متاح', en: 'Not available yet' };
export const NOT_ASSIGNED = { ar: 'لسه مش متحدد', en: 'Not assigned yet' };

export const M = {
  // -- menu ----------------------------------------------------------------
  welcome: (name) => both(
    `👋 أهلاً${name ? ' ' + name : ''} بيك في MKY Forwarding!\n\nنقدر نساعدك في إيه النهاردة؟`,
    `👋 Welcome${name ? ' ' + name : ''} to MKY Forwarding!\n\nHow can we help you today?`,
  ),

  menu: () => both('نقدر نساعدك في إيه؟', 'How can we help you today?'),

  help: () => both(
    'الأوامر المتاحة:\n' +
    '/start أو /menu - القائمة الرئيسية\n' +
    '/cancel - إلغاء الطلب اللي شغال دلوقتي\n' +
    '/help - الرسالة دي\n\n' +
    'تقدر كمان تكتب اللي عايزه بلغتك العادية.',
    'What you can do:\n' +
    '/start or /menu - the main menu\n' +
    '/cancel - stop whatever we are in the middle of\n' +
    '/help - this message\n\n' +
    'You can also just tell me what you need in your own words.',
  ),

  // -- booking, step 1: who is booking ---------------------------------------
  // The opening and the first question are one message, not two: a second
  // message is a second round trip to Telegram before the client sees anything.
  bookingStartAskName: (suggestion) => both(
    '📦 تمام، يلا نبدأ الحجز.\n\n1️⃣ الخطوة الأولى من 3 - بياناتك.\n\n' + askNameAr(suggestion),
    '📦 Let us start your booking.\n\nStep 1 of 3 — your details.\n\n' + askNameEn(suggestion),
  ),

  askClientName: (suggestion) => both(askNameAr(suggestion), askNameEn(suggestion)),

  // Telegram hands over a verified number through the reply-keyboard button;
  // typing works too, and so does saying yes to the number we already hold.
  askPhone: (suggestion) => both(
    '📱 ورقم الموبايل اللي نكلمك عليه؟\n' +
    'اضغط "شارك رقمي"، أو اكتبه بكود الدولة - مثلاً +20 100 555 1234.' +
    (suggestion ? `\n(لو ${suggestion} لسه رقمك ابعت "تمام")` : ''),
    '📱 And a mobile number we can reach you on?\n' +
    'Tap "Share my number", or type it with the country code — for example +20 100 555 1234.' +
    (suggestion ? `\n(If ${suggestion} is still your number, reply "yes".)` : ''),
  ),

  phoneInvalid: () => both(
    '⚠️ الرقم ده شكله مش رقم موبايل. ابعته بكود الدولة، مثلاً +20 100 555 1234.',
    '⚠️ That does not look like a phone number. Please send it with the country code — for example +20 100 555 1234.',
  ),

  phoneTypeIt: () => both(
    'تمام، اكتب رقمك بكود الدولة.',
    'Sure — type your number, with the country code.',
  ),

  phoneNoted: (phone) => both(
    `تمام، سجلت رقمك ${phone}.`,
    `Noted — ${phone} is your number.`,
  ),

  emailNotedNeedPhone: (email) => both(
    `تمام، سجلت الإيميل ${email}.\n\nبس لسه محتاج رقم موبايل نكلمك عليه.`,
    `Noted — I have ${email} as your email.\n\nI still need a mobile number we can call you on.`,
  ),

  // Step 2 opens with the choice MKY wants the client to have: everything in
  // one message with the papers attached, or one question at a time. One
  // message, ending in the first question.
  detailsCompleteAskVin: (name, phone = null) => both(
    `✅ تمام${name ? ` يا ${name}` : ''}${phone ? `، وسجلت رقمك ${phone}` : ''}.\n\n` +
    '2️⃣ الخطوة التانية من 3 - العربية وأوراقها.\n\n' +
    'تقدر تبعت كل حاجة في رسالة واحدة: رقم الشاسيه والماركة وميناء الشحن وميناء الوصول - ' +
    'وارفق المستندات (الفاتورة، مستند النقل، الـ MRN) مع نفس الرسالة. أو واحدة واحدة، نبدأ من هنا:\n\n' +
    ASK_VIN_AR,
    `✅ Thank you${name ? `, ${name}` : ''}${phone ? ` — I have ${phone} as your number` : ''}.\n\n` +
    'Step 2 of 3 — the vehicle and its papers.\n\n' +
    'You can send it all in one message: the chassis number, make, loading port and destination — ' +
    'and attach the documents (invoice, transport document, MRN) to the same message. ' +
    'Or one at a time, starting here:\n\n' +
    ASK_VIN_EN,
  ),

  // -- booking, step 2: the vehicle -------------------------------------------
  askVin: () => both(ASK_VIN_AR, ASK_VIN_EN),

  vinTooShort: () => both(
    '⚠️ الرقم ده شكله مش رقم شاسيه كامل. ابعته تاني من فضلك، زي W1T96340310484233.',
    '⚠️ That does not look like a full chassis number. Please send it again — for example W1T96340310484233.',
  ),

  vinNew: () => both(
    '✅ تمام! الوحدة دي جديدة عندنا. يلا نكمل. 🚀',
    '✅ Great! This unit is new. Let us continue. 🚀',
  ),

  vinKnown: () => both(
    'الوحدة دي موجودة عندنا بالفعل. هشوفلك الحجز القديم بتاعها.',
    'This unit is already in our system. Let me check the existing booking for you.',
  ),

  vinKnownContinue: () => both(
    '✅ تمام، مفيش حجز شغال عليها. يلا نكمل. 🚀',
    '✅ Great! Nothing is blocking it. Let us continue. 🚀',
  ),

  vinAlreadyBooked: (b) => both(
    `✅ الوحدة دي محجوزة بالفعل.\n\n` +
    `رقم الحجز: ${b.booking_ref}\n` +
    `خط الشحن: ${b.origin_port} ← ${b.destination_port}\n\n` +
    'مش محتاج تبعت طلب تاني.',
    `✅ This unit is already booked.\n\n` +
    `Booking Ref: ${b.booking_ref}\n` +
    `Route: ${b.origin_port} → ${b.destination_port}\n\n` +
    'No need to submit another request.',
  ),

  askMake: () => both('🚗 الماركة إيه؟ (مرسيدس، فولفو، سكانيا…)', '🚗 What is the vehicle Make / Brand?'),
  askPol: () => both(
    '🌍 هتشحن من فين؟ اكتب المدينة أو ميناء الشحن (فيلنيوس، كلايبيدا، أنتويرب…).',
    '🌍 Where does it ship from? The city or port of loading (Vilnius, Klaipeda, Antwerp…).',
  ),
  askDestination: (ports) => both(
    `🇪🇬 وميناء الوصول في مصر؟\n${ports.map((p) => `• ${p}`).join('\n')}`,
    `🇪🇬 And the Egyptian destination port?\n${ports.map((p) => `• ${p}`).join('\n')}`,
  ),
  destinationNotServed: (value, ports) => both(
    `⚠️ "${value}" مش من الموانئ اللي بنخدمها. اختار من دول:\n${ports.map((p) => `• ${p}`).join('\n')}`,
    `⚠️ "${value}" is not a port we serve. Please choose one of:\n${ports.map((p) => `• ${p}`).join('\n')}`,
  ),

  missingBasics: (labelsAr, labelsEn) => both(
    `⚠️ ناقص شوية بيانات.\n\nمحتاجين منك:\n${labelsAr.map((l) => `• ${l}`).join('\n')}`,
    `⚠️ We are missing some information.\n\nPlease provide:\n${labelsEn.map((l) => `• ${l}`).join('\n')}`,
  ),

  // When the client answers a different question than the one asked. What they
  // gave is kept and said back, so they can see it landed, and then the
  // original question is repeated - rather than silently dropping it.
  notedNowNeed: (gotAr, gotEn, needAr, needEn) => both(
    `تمام، سجلت ${gotAr}.

لسه محتاج ${needAr}.`,
    `Noted — ${gotEn}.

I still need ${needEn}.`,
  ),

  contactNoted: (value, needAr, needEn) => both(
    `تمام، سجلت وسيلة التواصل ${value}.

بس اللي محتاجه دلوقتي هو ${needAr}.`,
    `Noted, I have ${value} as your contact.

What I need right now is ${needEn}.`,
  ),

  cannotSkip: (needAr, needEn) => both(
    `مفهوم. للأسف مش هينفع نكمل الحجز من غير ${needAr} - هو اللي بنعرف بيه الوحدة. ` +
    'لو مش معاك دلوقتي تقدر ترجع في أي وقت، أو اضغط "تواصل مع فريقنا".',
    `Understood. We cannot go further without ${needEn} — it is how the unit is identified. ` +
    'Come back whenever you have it, or choose "Contact our team".',
  ),

  basicsComplete: () => both('✅ تمام! يلا نكمل. 🚀', '✅ Perfect! Let us continue. 🚀'),

  // -- booking, step 3: MRN + documents -------------------------------------
  askMrnChoice: () => both(
    '📄 عندك رقم MRN بالفعل؟',
    '📄 Do you already have an MRN?',
  ),

  mrnExistingChosen: (labelsAr, labelsEn) => both(
    `تمام. ابعتلي المستندات دي - ملف أو صورة:\n${labelsAr.map((l) => `• ${l}`).join('\n')}`,
    `Good. Please upload these documents — a file or a photo:\n${labelsEn.map((l) => `• ${l}`).join('\n')}`,
  ),

  mrnMkyChosen: () => both(
    'تمام، إحنا هنستخرج الـ MRN نيابة عنك. فريق المستندات الجمركية هيراجع الطلب ويكلمك لو محتاج حاجة.',
    'Understood — MKY will obtain the MRN for you. Our Customs Documentation team will review the request and contact you if they need anything.',
  ),

  mrnMkyNeedsInfo: () => both(
    '📝 اكتبلي في رسالة واحدة أي تفاصيل عندك عن التصدير (بلد التصدير، اسم المصدّر، رقم الفاتورة) عشان نبدأ إجراءات الـ MRN.',
    '📝 In one message, tell us what you know about the export (country of export, exporter name, invoice number) so we can start the MRN application.',
  ),

  mrnRequestOpened: (ref) => both(
    `✅ اتسجل طلب استخراج MRN برقم ${ref}. الفريق هيراجعه.`,
    `✅ Your MRN request ${ref} has been logged. The team will review it.`,
  ),

  documentReceived: (labelAr, labelEn) => both(
    `✅ وصلنا ${labelAr}.`,
    `✅ ${labelEn} received.`,
  ),

  // Several files sent together are acknowledged together, once they have all
  // been read - not one at a time with a shrinking list after each.
  documentsReceived: (labelsAr, labelsEn) => both(
    `✅ وصلنا: ${labelsAr.join('، ')}.`,
    `✅ Received: ${labelsEn.join(', ')}.`,
  ),

  documentReading: (fileName) => both(
    `استلمت ${fileName}، بقرأه دلوقتي…`,
    `Got ${fileName} — reading it now…`,
  ),

  documentUnknownType: (fileName = null) => both(
    fileName
      ? `📄 وصلني ${fileName} بس مش متأكد نوعه. هو إيه؟`
      : '📄 وصلني الملف بس مش متأكد نوعه. هو إيه؟',
    fileName
      ? `📄 I have ${fileName}, but I am not sure what it is. Which document is it?`
      : '📄 I have the file, but I am not sure what it is. Which document is it?',
  ),

  documentRejectedType: (mime, allowed) => both(
    `⚠️ النوع ده (${mime}) مش مقبول. ابعت PDF أو صورة.\nالمقبول: ${allowed.join('، ')}`,
    `⚠️ That file type (${mime}) is not accepted. Please send a PDF or a photo.\nAccepted: ${allowed.join(', ')}`,
  ),

  documentTooBig: (mb) => both(
    `⚠️ الملف كبير أوي. الحد الأقصى ${mb} ميجا.`,
    `⚠️ That file is too large. The maximum is ${mb} MB.`,
  ),

  documentSaveFailed: () => both(
    '⚠️ معلش، مقدرتش أحفظ الملف. جرب تبعته تاني.',
    '⚠️ Sorry, I could not save that file. Please try sending it again.',
  ),

  // The specification asks for two different sentences here - one for several
  // missing documents, one for the last remaining document. They are not
  // interchangeable: "Almost there" after four uploads is what makes a client
  // send the fifth.
  documentsStillMissing: (labelsAr, labelsEn) => both(
    `⚠️ فاضل شوية!\n\nلسه محتاجين:\n${labelsAr.map((l) => `• ${l}`).join('\n')}`,
    `⚠️ Just a little more!\n\nWe still need:\n${labelsEn.map((l) => `• ${l}`).join('\n')}`,
  ),

  documentsOneMissing: (labelAr, labelEn) => both(
    `⚠️ قربنا نخلص!\n\nمحتاجين بس ${labelAr}.`,
    `⚠️ Almost there!\n\nWe just need your ${labelEn}.`,
  ),

  documentsComplete: () => both(
    '✅ تمام! وصلنا كل اللي محتاجينه.\n\n3️⃣ الخطوة التالتة من 3 - الحجز.',
    '✅ Perfect! We have everything we need.\n\nStep 3 of 3 — your booking.',
  ),

  documentWrongChassis: (docVin, bookingVin) => both(
    `⚠️ المستند ده مكتوب عليه شاسيه ${docVin}، والحجز على ${bookingVin}. ` +
    'الجمارك بترفض البيان لو الرقمين مختلفين - راجع المستند من فضلك.',
    `⚠️ That document shows chassis ${docVin}, but this booking is for ${bookingVin}. ` +
    'Customs will reject a declaration where those disagree — please check the document.',
  ),

  // -- booking, step 4: confirmation ---------------------------------------
  confirmHeaderAr: '📋 راجع بيانات الحجز من فضلك',
  confirmHeaderEn: '📋 Please confirm your booking details',

  confirmAsk: () => both(
    'كله مظبوط؟',
    'Is everything correct?',
  ),

  askWhatToEdit: () => both(
    'عايز تعدل إيه؟',
    'Which information would you like to edit?',
  ),

  editSaved: () => both(
    '✅ اتعدلت البيانات!\n\nيلا نراجع تاني.',
    '✅ Information updated successfully!\n\nLet us confirm again.',
  ),

  editNothingChanged: () => both(
    'القيمة دي زي ما هي، فمفيش حاجة اتغيرت.',
    'That is the same as what we already have, so nothing changed.',
  ),

  // The reference is the thing the client keeps. It is said here, in the one
  // message that answers the yes, and repeated on the PDF that follows.
  submitted: (ref) => both(
    '🎉 اتأكد طلب الحجز!\n\n' +
    (ref ? `📋 رقم الحجز بتاعك: ${ref}\nاحتفظ بيه - هتتتبع الشحنة بيه.\n\n` : '') +
    'ببعت الطلب لفريق العمليات دلوقتي، ونسختك PDF جاية حالاً. 😊',
    '🎉 Booking request confirmed!\n\n' +
    (ref ? `📋 Your booking reference: ${ref}\nKeep it — it is how you track the shipment.\n\n` : '') +
    'I am sending your request to our Operations Team now, and your PDF copy follows. 😊',
  ),

  submittedAlready: (ref) => both(
    `الطلب ${ref} اتبعت لفريق العمليات بالفعل. مش محتاج تبعته تاني.`,
    `Request ${ref} is already with our Operations Team. There is no need to send it again.`,
  ),

  submitBlockedDocuments: (labelsAr, labelsEn) => both(
    `⚠️ مقدرش أبعت الطلب لفريق العمليات ولسه ناقص:\n${labelsAr.map((l) => `• ${l}`).join('\n')}`,
    `⚠️ I cannot send this to Operations while these are still missing:\n${labelsEn.map((l) => `• ${l}`).join('\n')}`,
  ),

  submitBlockedDuplicate: (ref) => both(
    `⚠️ الشاسيه ده اتحجز في الطلب ${ref}. مش هنبعت طلب تاني لنفس الوحدة.`,
    `⚠️ This chassis is already booked under ${ref}. We will not send a second request for the same unit.`,
  ),

  // -- booking, confirmed by Operations ------------------------------------
  bookingConfirmed: (b) => both(
    `🎉 حجزك اتأكد!\n\n` +
    `رقم الحجز: ${b.booking_ref}\n` +
    `الشاسيه: ${b.vin}\n` +
    `الماركة: ${b.make}\n` +
    `خط الشحن: ${b.origin_port} ← ${b.destination_port}\n\n` +
    'شكراً لاختيارك MKY Forwarding! 😊',
    `🎉 Your booking is confirmed!\n\n` +
    `Booking Ref: ${b.booking_ref}\n` +
    `Chassis: ${b.vin}\n` +
    `Make: ${b.make}\n` +
    `Route: ${b.origin_port} → ${b.destination_port}\n\n` +
    'Thank you for choosing MKY Forwarding! 😊',
  ),

  bookingRejected: (ref, reason) => both(
    `للأسف ما قدرناش نأكد الطلب ${ref}.` + (reason ? `\nالسبب: ${reason}` : '') +
    '\nلو حابب نراجعه مع حضرتك، اضغط "تواصل مع فريقنا".',
    `We were not able to confirm request ${ref}.` + (reason ? `\nReason: ${reason}` : '') +
    '\nIf you would like us to look at it with you, choose "Contact our team".',
  ),

  needsClientAction: (ref, whatAr, whatEn) => both(
    `⚠️ محتاجين شوية معلومات زيادة عشان نكمل الحجز ${ref}.\n\nمن فضلك ابعتلنا:\n${whatAr}`,
    `⚠️ We need a little more information to continue your booking ${ref}.\n\nPlease provide:\n${whatEn}`,
  ),

  // -- cancel / drafts -----------------------------------------------------
  draftFound: (ref, vin) => both(
    `عندك طلب حجز لسه ما اتبعتش، رقمه ${ref}${vin ? ` (شاسيه ${vin})` : ''}. تحب تعمل إيه؟`,
    `You have an unfinished booking request, ${ref}${vin ? ` (chassis ${vin})` : ''}. What would you like to do?`,
  ),

  cancelConfirmAsk: (ref) => both(
    `تحب ألغي طلب الحجز ${ref} اللي لسه ما اتبعتش؟`,
    `Shall I cancel your unfinished booking request ${ref}?`,
  ),

  cancelled: (ref) => both(
    `تمام، لغيت الطلب ${ref}. حجوزاتك المؤكدة زي ما هي.`,
    `Done — request ${ref} has been cancelled. Your confirmed bookings are untouched.`,
  ),

  nothingToCancel: () => both(
    'مفيش حاجة شغالة دلوقتي عشان نلغيها.',
    'There is nothing in progress to cancel.',
  ),

  // -- tracking ------------------------------------------------------------
  askTrackingId: () => both(
    '🚚 ابعتلي رقم الشاسيه / VIN أو رقم الحجز.',
    '🚚 Please enter your VIN / Chassis number or Booking Reference.',
  ),

  trackingNotFound: () => both(
    '⚠️ مالقيناش شحنة بالرقم ده.',
    '⚠️ We could not find a shipment with this VIN / Booking Ref.',
  ),

  trackingFound: () => both('🔎 لقيناها!', '🔎 Found it!'),

  trackingLatest: () => both('✅ آخر تحديث', '✅ Latest status'),

  // -- contact -------------------------------------------------------------
  contactMenu: () => both(
    'طبعاً! محتاج مساعدة في إيه؟',
    'Of course! What do you need help with?',
  ),

  contactAskBookingId: () => both(
    'ابعتلي رقم الشاسيه أو رقم الحجز.',
    'Please enter your VIN / Booking Reference.',
  ),

  contactDocumentsMenu: () => both(
    'محتاج مساعدة في إيه بالظبط؟',
    'What do you need help with?',
  ),

  contactOperations: () => both(
    'بوصلك بفريق العمليات، لحظة من فضلك.',
    'Connecting you with our Operations Team. Please wait a moment.',
  ),

  operationsContact: (c) => both(
    '☎️ فريق العمليات:\n' +
    (c.phone ? `تليفون: ${c.phone}\n` : '') +
    (c.email ? `إيميل: ${c.email}\n` : '') +
    (c.hours ? `مواعيد العمل: ${c.hours}` : ''),
    '☎️ Operations Team:\n' +
    (c.phone ? `Phone: ${c.phone}\n` : '') +
    (c.email ? `Email: ${c.email}\n` : '') +
    (c.hours ? `Hours: ${c.hours}` : ''),
  ),

  // Said when nobody has configured a real number. Inventing one is the single
  // worst thing this bot could do, so it says what it can actually do instead.
  operationsContactUnknown: () => both(
    'سجلت طلبك وفريق العمليات هيتواصل معاك. لسه ما اتسجلش عندنا رقم مباشر للعرض هنا.',
    'I have logged your request and our Operations Team will get in touch. A direct contact number has not been configured for me to give out.',
  ),

  // After 7 PM. The rule MKY gave: say the desk is closed, say when it opens,
  // and leave the direct number so a client with something urgent is not left
  // talking to a bot. The number is only ever the configured one.
  agentAfterHours: ({ start, end, tomorrow, directPhone }) => both(
    `🌙 فريقنا بيرد من ${hourAr(start)} لحد ${hourAr(end)} بتوقيت القاهرة، ودلوقتي برة مواعيد العمل.\n` +
    `سجلت طلبك، وموظف هيتواصل معاك ${tomorrow ? 'بكرة' : 'النهاردة'} من الساعة ${hourAr(start)}.` +
    (directPhone ? `\n\n☎️ لو الموضوع مستعجل، اتصل بينا مباشرة على ${directPhone}.` : ''),
    `🌙 Our agents are available from ${hourEn(start)} to ${hourEn(end)} Cairo time, and it is outside those hours now.\n` +
    `I have logged your request — an agent will get back to you ${tomorrow ? 'tomorrow' : 'today'} from ${hourEn(start)}.` +
    (directPhone ? `\n\n☎️ If it is urgent, call us directly on ${directPhone}.` : ''),
  ),

  // The number is already on file, so the only thing left to ask is the question.
  agentAskProblem: (phone) => both(
    `📝 عندي رقمك ${phone}. قولي محتاج مساعدة في إيه - جملة أو اتنين كفاية.`,
    `📝 I have your number (${phone}). What do you need help with? A sentence or two is enough.`,
  ),

  // Asked separately, because the two arrive in either order: some clients tap
  // "share my number" first, some describe the problem first. Asking for both
  // again once one is in hand reads as not having listened.
  askProblemOnly: () => both(
    'تمام، وصلني رقمك. المشكلة إيه بالظبط؟ اكتبها في جملة أو اتنين.',
    'Thanks, I have your number. What is the problem? A sentence or two is enough.',
  ),

  askPhoneOnly: () => both(
    'تمام. وابعتلي رقم موبايل نكلمك عليه.',
    'Noted. And a phone number we can call you on?',
  ),

  ticketNeedsProblem: () => both(
    'محتاج أعرف المشكلة الأول عشان أفتح الطلب للفريق الصح.',
    'I need to know what the problem is first, so it reaches the right team.',
  ),

  askProblemAndPhone: () => both(
    'عشان نفتح الطلب للفريق، ابعت في رسالة واحدة:\n• المشكلة بالظبط\n• رقم موبايل نكلمك عليه',
    'To open this with the team, send in one message:\n• What the problem is\n• A phone number we can call you on',
  ),

  ticketOpened: (ref, department) => both(
    `🎫 اتفتح طلب رقم ${ref} مع قسم ${department}. الفريق هيكلمك في مواعيد العمل.`,
    `🎫 Ticket ${ref} has been opened with ${department}. The team will call you during business hours.`,
  ),

  // -- errors --------------------------------------------------------------
  recoverableError: (ref) => both(
    `حصل خطأ عندنا وإحنا بنراجع البيانات. جرب تاني من فضلك.${ref ? ` (${ref})` : ''}`,
    `Something went wrong while checking that information. Please try again.${ref ? ` (${ref})` : ''}`,
  ),

  notUnderstood: () => both(
    'معلش، مش فاهم قصدك. اختار من الأزرار تحت أو اكتب /menu.',
    'Sorry, I did not follow that. Use the buttons below, or send /menu.',
  ),

  blocked: () => both(
    'الحساب ده متوقف عندنا. كلم فريق العمليات من فضلك.',
    'This account is on hold with us. Please contact our Operations Team.',
  ),
};

const ASK_VIN_AR = '🚘 ابعتلي رقم الشاسيه / VIN بتاع الوحدة.';
const ASK_VIN_EN = '🚘 Please send your VIN / Chassis number.';

function askNameAr(suggestion) {
  return `👤 الحجز هيتسجل باسم مين؟${suggestion ? `\n(لو "${suggestion}" مظبوط ابعت "تمام")` : ''}`;
}

function askNameEn(suggestion) {
  return `👤 What client name should we use for this booking?${suggestion ? `\n(If "${suggestion}" is right, reply "yes".)` : ''}`;
}

/** "9 AM", "7 PM" - the hours the desk keeps, said the way people say them. */
function hourEn(h) {
  const n = Number(h) % 24;
  if (n === 0) return '12 AM';
  if (n === 12) return '12 PM';
  return n < 12 ? `${n} AM` : `${n - 12} PM`;
}

function hourAr(h) {
  const n = Number(h) % 24;
  if (n === 0) return '12 بالليل';
  if (n === 12) return '12 الظهر';
  return n < 12 ? `${n} الصبح` : `${n - 12} ${n < 18 ? 'العصر' : 'بالليل'}`;
}

/** Bilingual labels for the fields the booking flow collects. */
export const FIELD_LABELS = {
  customer_name: ['اسم العميل', 'Client name'],
  customer_contact: ['رقم الموبايل', 'Mobile number'],
  vin: ['رقم الشاسيه / VIN', 'Chassis / VIN'],
  make: ['الماركة', 'Make / Brand'],
  origin_port: ['ميناء أو مدينة الشحن', 'Port of loading'],
  destination_port: ['ميناء الوصول', 'Destination'],
};

/** Bilingual labels for document types. */
export const DOC_LABELS = {
  invoice: ['الفاتورة التجارية', 'Invoice'],
  brief: ['مستند النقل / Brief', 'Brief'],
  mrn: ['رقم MRN', 'MRN'],
  acid: ['رقم ACID (نافذة)', 'ACID'],
  eur1: ['شهادة المنشأ EUR.1', 'EUR.1'],
  other: ['مستند', 'Document'],
};

export const docLabel = (type, lang = 'en') =>
  (DOC_LABELS[type] ?? DOC_LABELS.other)[lang === 'ar' ? 0 : 1];
