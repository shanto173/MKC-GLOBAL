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

  // -- booking, step 1 ------------------------------------------------------
  askVin: () => both(
    '📦 تمام، يلا نبدأ الحجز.\n\nابعتلي رقم الشاسيه / VIN بتاع الوحدة.',
    '📦 Let us start your booking.\n\nPlease send your VIN / Chassis number.',
  ),

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

  // -- booking, step 2 ------------------------------------------------------
  askMake: () => both('🚗 الماركة إيه؟ (مرسيدس، فولفو، سكانيا…)', '🚗 What is the vehicle Make / Brand?'),
  askClientName: (suggestion) => both(
    `👤 الحجز هيتسجل باسم مين؟${suggestion ? `\n(لو "${suggestion}" مظبوط ابعت "تمام")` : ''}`,
    `👤 What client name should we use for this booking?${suggestion ? `\n(If "${suggestion}" is right, reply "yes".)` : ''}`,
  ),
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

  documentReading: (fileName) => both(
    `استلمت ${fileName}، بقرأه دلوقتي…`,
    `Got ${fileName} — reading it now…`,
  ),

  documentUnknownType: () => both(
    '📄 وصلني الملف بس مش متأكد نوعه. هو إيه؟',
    '📄 I have the file, but I am not sure what it is. Which document is it?',
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
    '✅ تمام! وصلنا كل اللي محتاجينه.',
    '✅ Perfect! We have everything we need.',
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

  submitted: () => both(
    '🎉 اتأكد طلب الحجز!\n\nببعته لفريق العمليات دلوقتي.\nوصلنا الطلب! 😊',
    '🎉 Booking request confirmed!\n\nI am sending your request to our Operations Team now.\nWe have got it! 😊',
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

/** Bilingual labels for the fields the booking flow collects. */
export const FIELD_LABELS = {
  vin: ['رقم الشاسيه / VIN', 'Chassis / VIN'],
  make: ['الماركة', 'Make / Brand'],
  customer_name: ['اسم العميل', 'Client name'],
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
