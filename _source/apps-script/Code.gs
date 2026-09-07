/**
 * Holoflex landing pages: lead webhook
 *
 * Google Apps Script bound to a Google Sheet. Receives each lead as JSON from
 * a landing page's submit-enquiry.php (LP_WEBHOOK_URL), appends it as a row,
 * and emails a notification. Deployment steps are in DEPLOY.md next to this file.
 *
 * ONE deployment serves every Holoflex landing page (Garment Tags,
 * Self-Adhesive Labels, Holograms). Each page sends its own `page_id`
 * (LP_PAGE_ID in its PHP), which becomes the "Page ID" column and the product
 * named in the email subject. Do not create a separate script per page.
 */

/* ===================== CONFIGURATION ===================== */

/** Who receives the notification email. Comma-separate for several. */
var RECIPIENT_EMAIL = 'holoflex@gmail.com, plandleadtest@gmail.com';

/** Tab name in the bound spreadsheet. Created with a header row if missing. */
var SHEET_NAME = 'Leads';

/** Must match LP_WEBHOOK_SECRET in submit-enquiry.php.
 *  Leave blank on both sides to disable the check. */
var SHARED_SECRET = '';

/** Human-readable names for the page_id each landing page sends. An id not
 *  listed here is still accepted: it is stored and shown verbatim. */
var PAGE_NAMES = {
  'garment-tags':         'Garment Tags',
  'self-adhesive-labels': 'Self-Adhesive Labels',
  'holograms':            'Holograms'
};

/* ================== END CONFIGURATION ==================== */

var HEADERS = [
  'Timestamp', 'Page ID', 'Form', 'Name', 'Company / Brand', 'Phone', 'Email',
  'Product interest', 'Message', 'IP', 'User agent', 'Page'
];

/**
 * Entry point for the PHP webhook (HTTP POST, application/json).
 * Always answers JSON; never throws to the caller.
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var data = parseBody_(e);

    if (SHARED_SECRET && data.token !== SHARED_SECRET) {
      return respond_({ ok: false, error: 'unauthorised' });
    }

    var row = [
      str_(data.timestamp) || Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss'),
      pageId_(data),
      str_(data.form_location),
      str_(data.name),
      str_(data.company),
      str_(data.phone),
      str_(data.email),
      str_(data.interest),
      str_(data.message),
      str_(data.ip),
      str_(data.user_agent),
      str_(data.page)
    ];

    // Serialise concurrent appends (two leads in the same second).
    lock.waitLock(10000);
    var sheet = getSheet_();
    sheet.appendRow(row);
    lock.releaseLock();

    var mailError = '';
    try {
      sendNotification_(data, sheet);
    } catch (mailErr) {
      mailError = String(mailErr); // row is saved; report but do not fail
    }

    return respond_({ ok: true, mail_error: mailError || undefined });
  } catch (err) {
    try { lock.releaseLock(); } catch (ignore) {}
    return respond_({ ok: false, error: String(err) });
  }
}

/** Visiting the web-app URL in a browser shows this instead of an error. */
function doGet() {
  return ContentService
    .createTextOutput('Holoflex lead webhook is running. POST JSON to this URL.')
    .setMimeType(ContentService.MimeType.TEXT);
}

/* ----------------------------- helpers ----------------------------- */

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Empty request body');
  }
  var parsed = JSON.parse(e.postData.contents);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Body is not a JSON object');
  }
  return parsed;
}

/** Coerce to a trimmed string, capped so a hostile payload cannot bloat cells.
 *  A leading = + - @ is prefixed with a quote so Sheets never treats it as a formula. */
function str_(v) {
  var s = (v === undefined || v === null) ? '' : String(v).trim();
  if (s.length > 2000) { s = s.slice(0, 2000); }
  if (/^[=+\-@]/.test(s)) { s = "'" + s; }
  return s;
}

/** Normalised page id for the sheet: a short slug, or 'unknown' when the
 *  payload carries none (an older PHP build, or a hand-made POST). */
function pageId_(data) {
  var id = str_(data.page_id).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  return id || 'unknown';
}

/** Display name for the email: the configured name, else the raw id, else
 *  nothing (the subject then reads "New enquiry — ..."). */
function pageName_(data) {
  var id = pageId_(data);
  if (id === 'unknown') { return ''; }
  return PAGE_NAMES[id] || id;
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else if (sheet.getRange(1, 2).getValue() !== 'Page ID') {
    // Sheet created by the earlier single-page script: add the column in place
    // so existing rows keep their alignment and new rows land correctly.
    sheet.insertColumnBefore(2);
    sheet.getRange(1, 2).setValue('Page ID').setFontWeight('bold');
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).setValue('garment-tags');
    }
  }
  return sheet;
}

function sendNotification_(data, sheet) {
  if (!RECIPIENT_EMAIL) { return; }

  var company = str_(data.company) || '(no company)';
  var form = str_(data.form_location) || 'unknown';
  var email = str_(data.email);
  var pageName = pageName_(data);

  var lines = [
    'New enquiry from the ' + (pageName || 'Holoflex') + ' landing page',
    '',
    'Name:             ' + str_(data.name),
    'Company / Brand:  ' + company,
    'Phone:            ' + str_(data.phone),
    'Email:            ' + (email || '(not provided)'),
    'Product interest: ' + str_(data.interest),
    'Message:',
    str_(data.message) || '(none)',
    '',
    '---',
    'Page ID:   ' + pageId_(data),
    'Form:      ' + form,
    'Submitted: ' + str_(data.timestamp),
    'IP:        ' + str_(data.ip),
    'Page:      ' + (str_(data.page) || '(unknown)'),
    'Sheet:     ' + sheet.getParent().getUrl()
  ];

  var options = { name: 'Holoflex Website' };
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    options.replyTo = email;
  }

  MailApp.sendEmail(
    RECIPIENT_EMAIL,
    'New ' + (pageName ? pageName + ' ' : '') + 'enquiry — ' + company + ' (' + form + ' form)',
    lines.join('\n'),
    options
  );
}

function respond_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Manual test: run this from the Apps Script editor (Run > testDoPost) after
 * the first deployment to confirm the sheet row and the email arrive.
 */
function testDoPost() {
  var sample = {
    timestamp: Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss'),
    page_id: 'garment-tags',
    form_location: 'hero',
    name: 'Test Lead',
    company: 'Test Apparel Co',
    phone: '+91 98765 43210',
    email: 'test@example.com',
    interest: 'Garment tags — 3-in-1 plastic tag',
    message: 'Test submission from the Apps Script editor.',
    ip: '127.0.0.1',
    user_agent: 'Apps Script test',
    page: 'https://www.holoflex.com/garment_tags/',
    token: SHARED_SECRET
  };
  var out = doPost({ postData: { contents: JSON.stringify(sample) } });
  Logger.log(out.getContent());
}
