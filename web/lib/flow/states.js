/**
 * Every state a conversation can be in, in one list.
 *
 * The point of naming them here rather than scattering string literals through
 * the handlers is that a typo becomes a crash at import time instead of a
 * conversation that silently falls into a state nothing handles. `isState()`
 * guards the values that come back out of the database, which may have been
 * written by an older deployment.
 */

export const S = {
  // -- idle ----------------------------------------------------------------
  MAIN_MENU: 'MAIN_MENU',

  // -- booking, step 1: the unit -------------------------------------------
  BOOK_DRAFT_RESUME: 'BOOK_DRAFT_RESUME',
  BOOK_VIN: 'BOOK_VIN',

  // -- booking, step 2: the basics -----------------------------------------
  BOOK_MAKE: 'BOOK_MAKE',
  BOOK_CLIENT_NAME: 'BOOK_CLIENT_NAME',
  BOOK_POL: 'BOOK_POL',
  BOOK_DESTINATION: 'BOOK_DESTINATION',

  // -- booking, step 3: MRN and documents ----------------------------------
  BOOK_MRN_CHOICE: 'BOOK_MRN_CHOICE',
  BOOK_DOCUMENTS: 'BOOK_DOCUMENTS',
  BOOK_DOCUMENT_CLASSIFY: 'BOOK_DOCUMENT_CLASSIFY',
  BOOK_MRN_SUPPORTING_INFO: 'BOOK_MRN_SUPPORTING_INFO',

  // -- booking, step 4: confirmation ---------------------------------------
  BOOK_FINAL_CONFIRMATION: 'BOOK_FINAL_CONFIRMATION',
  BOOK_EDIT_MENU: 'BOOK_EDIT_MENU',
  BOOK_EDIT_VIN: 'BOOK_EDIT_VIN',
  BOOK_EDIT_MAKE: 'BOOK_EDIT_MAKE',
  BOOK_EDIT_CLIENT_NAME: 'BOOK_EDIT_CLIENT_NAME',
  BOOK_EDIT_POL: 'BOOK_EDIT_POL',
  BOOK_EDIT_DESTINATION: 'BOOK_EDIT_DESTINATION',
  BOOK_CANCEL_CONFIRM: 'BOOK_CANCEL_CONFIRM',
  BOOK_SUBMITTED: 'BOOK_SUBMITTED',

  // -- tracking ------------------------------------------------------------
  TRACK_IDENTIFIER: 'TRACK_IDENTIFIER',
  TRACK_RESULTS: 'TRACK_RESULTS',

  // -- contact -------------------------------------------------------------
  CONTACT_MENU: 'CONTACT_MENU',
  CONTACT_BOOKING_IDENTIFIER: 'CONTACT_BOOKING_IDENTIFIER',
  CONTACT_TRACKING_IDENTIFIER: 'CONTACT_TRACKING_IDENTIFIER',
  CONTACT_DOCUMENT_MENU: 'CONTACT_DOCUMENT_MENU',
  CONTACT_DOCUMENT_REQUEST: 'CONTACT_DOCUMENT_REQUEST',
  CONTACT_TICKET_DETAILS: 'CONTACT_TICKET_DETAILS',
};

export const FLOWS = {
  BOOKING: 'booking',
  TRACKING: 'tracking',
  CONTACT: 'contact',
};

const ALL = new Set(Object.values(S));

export const isState = (value) => ALL.has(value);

/**
 * States in which a plain text message is an ANSWER to something we asked,
 * rather than a new topic. Anywhere else, free text is a question for the
 * knowledge assistant.
 *
 * This is what stops "where is my truck?" typed halfway through a booking being
 * stored as a client's name - and, equally, stops a client who is being asked
 * for their name having that name treated as a tracking query.
 */
export const AWAITING_TEXT = new Set([
  S.BOOK_VIN,
  S.BOOK_MAKE,
  S.BOOK_CLIENT_NAME,
  S.BOOK_POL,
  S.BOOK_DESTINATION,
  S.BOOK_MRN_SUPPORTING_INFO,
  S.BOOK_EDIT_VIN,
  S.BOOK_EDIT_MAKE,
  S.BOOK_EDIT_CLIENT_NAME,
  S.BOOK_EDIT_POL,
  S.BOOK_EDIT_DESTINATION,
  S.TRACK_IDENTIFIER,
  S.CONTACT_BOOKING_IDENTIFIER,
  S.CONTACT_TRACKING_IDENTIFIER,
  S.CONTACT_DOCUMENT_REQUEST,
  S.CONTACT_TICKET_DETAILS,
]);

/** States in which an uploaded file belongs to the booking in progress. */
export const ACCEPTS_DOCUMENTS = new Set([
  S.BOOK_DOCUMENTS,
  S.BOOK_DOCUMENT_CLASSIFY,
  S.BOOK_MRN_SUPPORTING_INFO,
  S.BOOK_FINAL_CONFIRMATION,
  S.BOOK_EDIT_MENU,
]);

/** The order the basics are collected in, and the state that collects each. */
export const BASIC_FIELDS = [
  { field: 'vin', state: S.BOOK_VIN },
  { field: 'make', state: S.BOOK_MAKE },
  { field: 'customer_name', state: S.BOOK_CLIENT_NAME },
  { field: 'origin_port', state: S.BOOK_POL },
  { field: 'destination_port', state: S.BOOK_DESTINATION },
];
