/**
 * Seed content for the demo PDF and Excel workbook.
 *
 * This file exists only to GENERATE those two files. Once you have real data,
 * replace data/*.xlsx and data/*.pdf and re-run `npm run seed` / `npm run ingest`.
 * Nothing at runtime reads this file.
 */

export const COMPANY = {
  name: 'MKC Global Logistics',
  tagline: 'Freight forwarding and customs clearance into Egypt',
  founded: '2014',
  hq: '14 El Horreya Road, Alexandria, Egypt',
  branches: ['Alexandria (HQ)', 'Cairo', 'Port Said', 'Rotterdam (agent)', 'Felixstowe (agent)'],
  hours: 'Sunday to Thursday, 09:00 to 18:00 EET. Closed Friday and Saturday.',
  email: 'info@mkcglobal.example',
  phone: '+20 3 555 0142',
  website: 'https://mkcglobal.example',
};

export const DEPARTMENT_CONTACTS = [
  ['Booking Operations', 'bookings@mkcglobal.example', '+20 3 555 0143', 'New bookings, space confirmation, cargo ready dates'],
  ['Accounts & Payments', 'accounts@mkcglobal.example', '+20 3 555 0144', 'Invoices, proof of payment, credit terms'],
  ['Tracking Desk', 'tracking@mkcglobal.example', '+20 3 555 0145', 'Vessel schedules, ETA changes, container status'],
  ['Customs Documentation', 'customs@mkcglobal.example', '+20 3 555 0146', 'ACID, MRN, HS codes, inspection support'],
  ['Customer Care', 'care@mkcglobal.example', '+20 3 555 0147', 'Complaints, general questions, anything else'],
];

export const SHIPMENTS = [
  {
    shipment_id: 'MKC-24001', acid_id: 'ACID-908341', bl_number: 'MAEU2401881', container_no: 'MSKU7741230',
    customer_name: 'Amelia Carter', customer_email: 'amelia.carter@northwind.example', customer_phone: '+44 20 7946 0101',
    origin_port: 'Rotterdam', destination_port: 'Alexandria Port (incl. El Dekheila)', mode: 'Sea FCL',
    status: 'Vessel departed Rotterdam', mrn_status: 'Approved', payment_status: 'Paid', delivery_status: 'Not yet',
    cargo_description: 'Industrial pumps and spare parts', gross_weight_kg: 18400, volume_cbm: 42.5,
    vessel: 'MSC Aurora V.238W', etd: '2026-08-27', eta: '2026-09-08',
    events: [
      ['2026-08-21', 'Rotterdam', 'Booking confirmed, empty container released'],
      ['2026-08-24', 'Rotterdam', 'Container gated in at terminal'],
      ['2026-08-26', 'Rotterdam', 'Export customs cleared, MRN approved'],
      ['2026-08-27', 'Rotterdam', 'Loaded on MSC Aurora V.238W, vessel departed'],
    ],
  },
  {
    shipment_id: 'MKC-24002', acid_id: 'ACID-908342', bl_number: 'MAEU2401902', container_no: 'TGHU5512087',
    customer_name: 'Oliver Bennett', customer_email: 'o.bennett@bennetttrading.example', customer_phone: '+44 20 7946 0102',
    origin_port: 'Felixstowe', destination_port: 'Port Said', mode: 'Sea FCL',
    status: 'Customs clearance in progress', mrn_status: 'Approved', payment_status: 'Paid', delivery_status: 'Not yet',
    cargo_description: 'Packaged food ingredients', gross_weight_kg: 15100, volume_cbm: 38.0,
    vessel: 'CMA CGM Nile V.114E', etd: '2026-08-18', eta: '2026-08-31',
    events: [
      ['2026-08-18', 'Felixstowe', 'Vessel departed'],
      ['2026-08-30', 'Port Said', 'Vessel arrived, container discharged'],
      ['2026-08-31', 'Port Said', 'Documents lodged with Egyptian customs'],
      ['2026-09-01', 'Port Said', 'Customs inspection scheduled'],
    ],
  },
  {
    shipment_id: 'MKC-24003', acid_id: 'ACID-908343', bl_number: 'HLCU2401773', container_no: 'HLXU3390442',
    customer_name: 'Sophia Martinez', customer_email: 'sophia@martinezindustrial.example', customer_phone: '+34 96 555 0103',
    origin_port: 'Valencia', destination_port: 'Damietta Port', mode: 'Sea FCL',
    status: 'On hold - documents under review', mrn_status: 'Pending', payment_status: 'Pending', delivery_status: 'Not yet',
    cargo_description: 'Ceramic tiles, 2 x 40ft', gross_weight_kg: 21300, volume_cbm: 61.2,
    vessel: 'Hapag Valencia Express V.077', etd: '2026-09-04', eta: '2026-09-14',
    events: [
      ['2026-08-28', 'Valencia', 'Booking received'],
      ['2026-08-31', 'Valencia', 'Commercial invoice rejected, HS code mismatch'],
      ['2026-09-01', 'Valencia', 'Awaiting corrected invoice from shipper'],
    ],
  },
  {
    shipment_id: 'MKC-24004', acid_id: 'ACID-908344', bl_number: 'MSCU2401664', container_no: 'MSCU8823119',
    customer_name: 'Noah Wilson', customer_email: 'noah.wilson@wilsonauto.example', customer_phone: '+49 40 555 0104',
    origin_port: 'Hamburg', destination_port: 'Ain Sokhna Port', mode: 'Sea FCL',
    status: 'Arrived at destination terminal', mrn_status: 'Approved', payment_status: 'Paid', delivery_status: 'Not yet',
    cargo_description: 'Automotive components', gross_weight_kg: 17800, volume_cbm: 44.1,
    vessel: 'MSC Hamburg V.312S', etd: '2026-08-15', eta: '2026-08-29',
    events: [
      ['2026-08-15', 'Hamburg', 'Vessel departed'],
      ['2026-08-29', 'Ain Sokhna', 'Vessel arrived'],
      ['2026-08-30', 'Ain Sokhna', 'Container discharged, customs released'],
      ['2026-09-01', 'Ain Sokhna', 'Awaiting inland trucking, delivery slot 4 September'],
    ],
  },
  {
    shipment_id: 'MKC-24005', acid_id: 'ACID-908345', bl_number: 'ONEY2401555', container_no: 'ONEU4471028',
    customer_name: 'Emma Johnson', customer_email: 'emma.j@savannahexports.example', customer_phone: '+1 912 555 0105',
    origin_port: 'Savannah', destination_port: 'Suez Port', mode: 'Sea FCL',
    status: 'Delivered', mrn_status: 'Approved', payment_status: 'Paid', delivery_status: 'Complete',
    cargo_description: 'Cotton textiles', gross_weight_kg: 13600, volume_cbm: 55.8,
    vessel: 'ONE Meridian V.089', etd: '2026-07-28', eta: '2026-08-19',
    events: [
      ['2026-07-28', 'Savannah', 'Vessel departed'],
      ['2026-08-19', 'Suez', 'Vessel arrived'],
      ['2026-08-21', 'Suez', 'Customs cleared'],
      ['2026-08-23', 'Cairo', 'Delivered to consignee warehouse, POD signed'],
    ],
  },
  {
    shipment_id: 'MKC-24006', acid_id: 'ACID-908346', bl_number: 'MAEU2401446', container_no: 'MRKU6612884',
    customer_name: 'Liam Thompson', customer_email: 'liam@thompsonmachinery.example', customer_phone: '+32 3 555 0106',
    origin_port: 'Antwerp', destination_port: 'Alexandria Port (incl. El Dekheila)', mode: 'Sea FCL',
    status: 'On hold - MRN correction required', mrn_status: 'Rejected', payment_status: 'Pending', delivery_status: 'Not yet',
    cargo_description: 'CNC machinery, 1 x 40ft HC', gross_weight_kg: 20000, volume_cbm: 63.4,
    vessel: 'Maersk Antwerp V.401W', etd: '2026-09-06', eta: '2026-09-17',
    events: [
      ['2026-08-29', 'Antwerp', 'Booking confirmed'],
      ['2026-09-01', 'Antwerp', 'MRN rejected by customs, consignee details do not match ACID'],
    ],
  },
  {
    shipment_id: 'MKC-24007', acid_id: 'ACID-908347', bl_number: 'CMAU2401337', container_no: 'CMAU2218765',
    customer_name: 'Mia Anderson', customer_email: 'mia.anderson@londongoods.example', customer_phone: '+44 20 7946 0107',
    origin_port: 'London Gateway', destination_port: 'Port Said', mode: 'Sea FCL',
    status: 'Loaded on vessel', mrn_status: 'Approved', payment_status: 'Paid', delivery_status: 'Not yet',
    cargo_description: 'Retail consumer goods', gross_weight_kg: 16200, volume_cbm: 47.9,
    vessel: 'CMA CGM Thames V.220E', etd: '2026-09-01', eta: '2026-09-12',
    events: [
      ['2026-08-30', 'London Gateway', 'Container gated in'],
      ['2026-09-01', 'London Gateway', 'Loaded on vessel, sailing confirmed'],
    ],
  },
  {
    shipment_id: 'MKC-24008', acid_id: 'ACID-908348', bl_number: 'HLCU2401228', container_no: 'HLBU9903471',
    customer_name: 'James Walker', customer_email: 'jwalker@walkerlogistics.example', customer_phone: '+1 201 555 0108',
    origin_port: 'New York / New Jersey', destination_port: 'Damietta Port', mode: 'Sea FCL',
    status: 'Awaiting pickup at origin', mrn_status: 'Approved', payment_status: 'Pending', delivery_status: 'Not yet',
    cargo_description: 'Medical equipment', gross_weight_kg: 22100, volume_cbm: 58.3,
    vessel: 'To be nominated', etd: '2026-09-10', eta: '2026-09-28',
    events: [
      ['2026-08-31', 'Newark', 'Booking confirmed, pickup requested'],
      ['2026-09-02', 'Newark', 'Awaiting shipper cargo ready confirmation'],
    ],
  },
  {
    shipment_id: 'MKC-24009', acid_id: 'ACID-908349', bl_number: 'MSCU2401119', container_no: 'MSDU1145992',
    customer_name: 'Isabella Clark', customer_email: 'isabella@clarkstone.example', customer_phone: '+39 010 555 0109',
    origin_port: 'Genoa', destination_port: 'Ain Sokhna Port', mode: 'Sea FCL',
    status: 'In transit', mrn_status: 'Approved', payment_status: 'Paid', delivery_status: 'Not yet',
    cargo_description: 'Marble slabs', gross_weight_kg: 17000, volume_cbm: 33.7,
    vessel: 'MSC Genova V.155S', etd: '2026-08-25', eta: '2026-09-08',
    events: [
      ['2026-08-25', 'Genoa', 'Vessel departed'],
      ['2026-08-30', 'At sea', 'Transhipment at Malta completed'],
    ],
  },
  {
    shipment_id: 'MKC-24010', acid_id: 'ACID-908350', bl_number: 'ONEY2401010', container_no: 'ONEU7730118',
    customer_name: 'Henry Lewis', customer_email: 'henry.lewis@lewisimports.example', customer_phone: '+1 310 555 0110',
    origin_port: 'Los Angeles', destination_port: 'Suez Port', mode: 'Sea FCL',
    status: 'Delivered', mrn_status: 'Approved', payment_status: 'Paid', delivery_status: 'Complete',
    cargo_description: 'Electronics and accessories', gross_weight_kg: 19500, volume_cbm: 52.0,
    vessel: 'ONE Pacific V.311', etd: '2026-07-20', eta: '2026-08-16',
    events: [
      ['2026-07-20', 'Los Angeles', 'Vessel departed'],
      ['2026-08-16', 'Suez', 'Vessel arrived'],
      ['2026-08-20', 'Cairo', 'Delivered, POD signed'],
    ],
  },
  {
    shipment_id: 'MKC-24011', acid_id: 'ACID-908351', bl_number: 'AIR-2401-EG', container_no: 'AWB 020-44881762',
    customer_name: 'Fatima El-Sayed', customer_email: 'fatima@elsayedpharma.example', customer_phone: '+20 2 555 0111',
    origin_port: 'Frankfurt (air)', destination_port: 'Alexandria Port (incl. El Dekheila)', mode: 'Air',
    status: 'Cleared, out for delivery', mrn_status: 'Approved', payment_status: 'Paid', delivery_status: 'Not yet',
    cargo_description: 'Temperature-controlled pharmaceuticals', gross_weight_kg: 820, volume_cbm: 4.1,
    vessel: 'LH 8264', etd: '2026-08-30', eta: '2026-08-31',
    events: [
      ['2026-08-30', 'Frankfurt', 'Departed on LH 8264'],
      ['2026-08-31', 'Cairo', 'Arrived, cold chain intact'],
      ['2026-09-01', 'Alexandria', 'Customs cleared, out for delivery'],
    ],
  },
  {
    shipment_id: 'MKC-24012', acid_id: 'ACID-908352', bl_number: 'MAEU2401992', container_no: 'MRSU4408123',
    customer_name: 'Karim Hassan', customer_email: 'karim@hassanbuild.example', customer_phone: '+20 3 555 0112',
    origin_port: 'Barcelona', destination_port: 'Port Said', mode: 'Sea LCL',
    status: 'Booking confirmed, awaiting cargo', mrn_status: 'Pending', payment_status: 'Pending', delivery_status: 'Not yet',
    cargo_description: 'Building fixtures, part load', gross_weight_kg: 4300, volume_cbm: 11.6,
    vessel: 'To be nominated', etd: '2026-09-12', eta: '2026-09-22',
    events: [['2026-09-01', 'Barcelona', 'Booking confirmed, LCL consolidation slot reserved']],
  },
];

/** Sections that become the company profile PDF and the RAG knowledge base. */
export const KNOWLEDGE_SECTIONS = [
  {
    title: 'About MKC Global Logistics',
    body: `MKC Global Logistics is a freight forwarding and customs clearance company founded in ${COMPANY.founded}, with its head office at ${COMPANY.hq}. We move sea and air freight from the European Union, the United Kingdom and the United States into Egypt, and we handle the full customs process on arrival. Offices and agents: ${COMPANY.branches.join(', ')}. Office hours are ${COMPANY.hours} General enquiries: ${COMPANY.email}, ${COMPANY.phone}.`,
  },
  {
    title: 'Services we provide',
    body: `Full container load (FCL) sea freight. Less than container load (LCL) consolidation, sailing weekly from Rotterdam, Felixstowe, Barcelona and Valencia. Air freight for urgent and temperature-controlled cargo. Egyptian import customs clearance including ACID registration and MRN handling. Inland trucking from all five ports to any governorate in Egypt. Warehousing and short-term bonded storage at Alexandria and Port Said. Cargo insurance arranged on request at 0.35 percent of CIF value, minimum 45 USD.`,
  },
  {
    title: 'Ports we serve',
    body: `We accept cargo originating anywhere in the European Union, the United Kingdom and the United States. Common origin ports are Rotterdam, Antwerp, Hamburg, Felixstowe, London Gateway, Barcelona, Valencia, Genoa, New York and New Jersey, Savannah and Los Angeles. In Egypt we deliver to exactly five destination ports: Alexandria Port including El Dekheila, Port Said, Damietta Port, Ain Sokhna Port and Suez Port. We do not currently serve any other Egyptian port, and we do not handle exports out of Egypt.`,
  },
  {
    title: 'Documents required for an import booking',
    body: `To open a booking we need: the commercial invoice, the packing list, the ACID number registered on the Egyptian Nafeza single window, the MRN from the export country, the bill of lading or air waybill, and a certificate of origin. For vehicles and machinery we also need the vehicle registration document, chassis and engine numbers, and the manufacturer specification sheet. For food, cosmetics and pharmaceuticals we additionally need a health certificate and a free sale certificate. The ACID must be issued before the goods are shipped; cargo that arrives without a valid ACID cannot be cleared and will accrue demurrage.`,
  },
  {
    title: 'The ACID and MRN process',
    body: `ACID stands for Advance Cargo Information Declaration. The Egyptian importer registers the shipment on the Nafeza platform and receives a 19 digit ACID number, which must be sent to the exporter before loading. The MRN, or Movement Reference Number, is issued by customs in the export country when the export declaration is lodged. Both numbers must appear on the shipping documents. If the consignee details on the MRN do not match the ACID registration, customs will reject the declaration and the shipment goes on hold until a corrected document is filed. Corrections normally take one to three working days.`,
  },
  {
    title: 'Transit times',
    body: `Typical port to port transit times: Rotterdam to Alexandria 11 to 13 days. Felixstowe to Port Said 12 to 14 days. Antwerp to Alexandria 11 to 13 days. Hamburg to Ain Sokhna 13 to 15 days. Barcelona or Valencia to Damietta 7 to 9 days. Genoa to Ain Sokhna 12 to 14 days. New York to Damietta 16 to 19 days. Savannah to Suez 20 to 23 days. Los Angeles to Suez 25 to 28 days. Air freight from any European hub is one to two days. Add three to seven working days for customs clearance and inland delivery. These are indicative and depend on the sailing schedule and on customs.`,
  },
  {
    title: 'Payment terms',
    body: `New customers pay in advance by bank transfer before the container is released. Approved account customers have 30 day credit terms after three completed shipments. We accept bank transfer in USD or EUR and local transfer in EGP. We do not accept cash or personal cheques. Invoices are issued on booking confirmation and again on arrival for local charges. Demurrage and detention are billed at cost plus a 10 percent handling fee. Proof of payment should be emailed to accounts@mkcglobal.example quoting the shipment reference.`,
  },
  {
    title: 'Booking cut-off times',
    body: `For FCL, the documentation cut-off is 72 hours before vessel departure and the physical cargo cut-off is 48 hours before departure. For LCL, cargo must reach the consolidation warehouse 5 working days before the sailing. For air freight, the cut-off is 6 hours before flight departure. Bookings received after the cut-off roll to the next available sailing.`,
  },
  {
    title: 'Tracking your shipment',
    body: `You can track using any one of four references: the MKC shipment number in the format MKC-24001, the ACID number, the bill of lading number, or the container number. Status is updated automatically when the shipping line publishes a milestone, and manually by our Tracking Desk for customs and delivery events. If a shipment shows as on hold, the reason is recorded in the event history and our Customs Documentation team will already have contacted the shipper.`,
  },
  {
    title: 'Departments and who to contact',
    body: DEPARTMENT_CONTACTS.map(([name, email, phone, scope]) => `${name}: ${scope}. Email ${email}, phone ${phone}.`).join(' '),
  },
  {
    title: 'Claims and complaints',
    body: `Damage or shortage claims must be notified within 3 days of delivery, with photographs and the signed proof of delivery noting the damage. Claims are filed with the carrier and typically settle in 30 to 60 days. Liability is limited to 2 SDR per kilogram under the Hague-Visby rules unless separate cargo insurance was purchased. Complaints about service go to Customer Care and receive a first response within one working day.`,
  },
];
