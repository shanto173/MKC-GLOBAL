/**
 * Wording for the booking confirmation, in English and Arabic.
 *
 * Note on register: the CHAT should answer in Egyptian colloquial Arabic,
 * because that is how customers actually write. A booking document is the
 * opposite - Egyptian businesses expect formal Modern Standard Arabic on
 * paperwork, so these strings are deliberately formal.
 *
 * Trade terms (ACID, MRN, Incoterm codes, port names, the booking reference)
 * stay in Latin script in BOTH languages, because that is how they appear on
 * the bill of lading and on the Nafeza platform. Translating them would make
 * the document harder to use, not easier.
 */

export const LANGUAGES = ['en', 'ar'];

const STRINGS = {
  en: {
    dir: 'ltr',
    tagline: 'Freight forwarding and customs clearance into Egypt',
    docTitle: 'BOOKING REQUEST',
    statusBanner: 'STATUS: AWAITING CONFIRMATION',
    statusNote:
      'This is a request, not a confirmed booking. Space and pricing are confirmed by Booking Operations.',

    customer: 'CUSTOMER',
    name: 'Name',
    company: 'Company',
    contact: 'Contact',

    route: 'ROUTE',
    originCountry: 'Origin country',
    originPort: 'Port of loading',
    destinationPort: 'Destination port',
    incoterm: 'Incoterm',

    cargo: 'CARGO',
    description: 'Description',
    grossWeight: 'Gross weight',
    volume: 'Volume',
    readyDate: 'Cargo ready date',
    notes: 'Notes',

    documents: 'DOCUMENTS TO PREPARE',
    docList: [
      'Commercial invoice',
      'Packing list',
      'ACID number, registered on the Nafeza platform before shipping',
      'MRN from the export country',
      'Bill of Lading or Air Waybill',
      'Certificate of origin',
    ],

    next: 'WHAT HAPPENS NEXT',
    nextBody:
      'Booking Operations will review this request and confirm space, schedule and pricing by email ' +
      'within one business day. Please have the documents above ready. The ACID number must be issued ' +
      'before the goods are shipped; cargo arriving without a valid ACID cannot be cleared.',

    kg: 'kg',
    cbm: 'cbm',
    receivedVia: (when, channel) => `Received ${when} via ${channel}`,
    reference: 'Reference',

    emailSubjectCustomer: (ref) => `Booking request received - ${ref}`,
    emailHeadingCustomer: 'Thank you — we have your booking request',
    emailIntroCustomer: (ref) =>
      `Reference <strong>${ref}</strong>. This is a request, not yet a confirmed booking. ` +
      'Our Booking Operations team will confirm space, schedule and pricing by email within one business day.',
    emailPrepare:
      '<strong>Please prepare:</strong> commercial invoice, packing list, ACID number, MRN, ' +
      'Bill of Lading or Air Waybill, and certificate of origin.<br><br>' +
      'The ACID must be issued <strong>before</strong> the goods are shipped — cargo arriving without a ' +
      'valid ACID cannot be cleared.',
    emailAttachmentNote:
      'The attached PDF is your copy of this request. Reply to this email if anything is wrong.',
    emailFooter: (company) => `This message was generated automatically by the ${company} assistant.`,
  },

  ar: {
    dir: 'rtl',
    tagline: 'الشحن الدولي والتخليص الجمركي إلى مصر',
    docTitle: 'طلب حجز',
    statusBanner: 'الحالة: في انتظار التأكيد',
    statusNote:
      'هذا طلب وليس حجزاً مؤكداً. يتم تأكيد المساحة والسعر من قسم عمليات الحجز.',

    customer: 'بيانات العميل',
    name: 'الاسم',
    company: 'الشركة',
    contact: 'وسيلة الاتصال',

    route: 'خط الشحن',
    originCountry: 'بلد المنشأ',
    originPort: 'ميناء الشحن',
    destinationPort: 'ميناء الوصول',
    incoterm: 'شرط التسليم',

    cargo: 'بيانات البضاعة',
    description: 'وصف البضاعة',
    grossWeight: 'الوزن الإجمالي',
    volume: 'الحجم',
    readyDate: 'تاريخ جاهزية البضاعة',
    notes: 'ملاحظات',

    documents: 'المستندات المطلوبة',
    docList: [
      'الفاتورة التجارية',
      'قائمة التعبئة',
      'رقم ACID مسجل على منصة نافذة قبل الشحن',
      'رقم MRN من بلد التصدير',
      'بوليصة الشحن البحري أو الجوي',
      'شهادة المنشأ',
    ],

    next: 'الخطوات التالية',
    nextBody:
      'سيقوم قسم عمليات الحجز بمراجعة هذا الطلب وتأكيد المساحة والجدول الزمني والسعر عبر البريد ' +
      'الإلكتروني خلال يوم عمل واحد. برجاء تجهيز المستندات المذكورة أعلاه. يجب إصدار رقم ACID قبل ' +
      'شحن البضاعة، حيث لا يمكن تخليص البضائع التي تصل بدون رقم ACID صالح.',

    kg: 'كجم',
    cbm: 'متر مكعب',
    receivedVia: (when, channel) => `تم الاستلام ${when} عبر ${channel}`,
    reference: 'رقم الطلب',

    emailSubjectCustomer: (ref) => `تم استلام طلب الحجز - ${ref}`,
    emailHeadingCustomer: 'شكراً لك — تم استلام طلب الحجز',
    emailIntroCustomer: (ref) =>
      `رقم الطلب <strong>${ref}</strong>. هذا طلب وليس حجزاً مؤكداً بعد. ` +
      'سيقوم قسم عمليات الحجز بتأكيد المساحة والجدول الزمني والسعر عبر البريد الإلكتروني خلال يوم عمل واحد.',
    emailPrepare:
      '<strong>برجاء تجهيز:</strong> الفاتورة التجارية، قائمة التعبئة، رقم ACID، رقم MRN، ' +
      'بوليصة الشحن البحري أو الجوي، وشهادة المنشأ.<br><br>' +
      'يجب إصدار رقم ACID <strong>قبل</strong> شحن البضاعة — لا يمكن تخليص البضائع التي تصل بدون رقم ACID صالح.',
    emailAttachmentNote:
      'الملف المرفق هو نسختك من هذا الطلب. برجاء الرد على هذه الرسالة إذا كان هناك أي خطأ.',
    emailFooter: (company) => `تم إنشاء هذه الرسالة تلقائياً بواسطة مساعد ${company}.`,
  },
};

/** Returns the string table for a language, falling back to English. */
export function t(lang) {
  return STRINGS[normalizeLang(lang)] ?? STRINGS.en;
}

export function normalizeLang(lang) {
  const l = String(lang ?? '').toLowerCase().slice(0, 2);
  return LANGUAGES.includes(l) ? l : 'en';
}

/**
 * Which language should this booking's paperwork be in?
 * The model records the conversation language on the booking; if that is
 * missing we fall back to looking for Arabic script in what the customer typed.
 */
export function bookingLanguage(booking) {
  const declared = booking?.raw?.language ?? booking?.language;
  if (declared) return normalizeLang(declared);

  const typed = [booking?.customer_name, booking?.cargo_description, booking?.notes, booking?.company]
    .filter(Boolean)
    .join(' ');
  return /[؀-ۿ]/.test(typed) ? 'ar' : 'en';
}
