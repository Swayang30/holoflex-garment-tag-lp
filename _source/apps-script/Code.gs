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
var SHARED_SECRET = 'XOqRmzY9jICpcA48ZnUGaThgK0x6ikrEeWLvyu21F3HPSBN5';

/** Human-readable names for the page_id each landing page sends. An id not
 *  listed here is still accepted: it is stored and shown verbatim. */
var PAGE_NAMES = {
  'garment-tags':         'Garment Tags',
  'self-adhesive-labels': 'Self-Adhesive Labels',
  'holograms':            'Holograms'
};

/* ================== END CONFIGURATION ==================== */

var HEADERS = [
  'Timestamp', 'Page ID',
  'GCLID', 'UTM source', 'UTM medium', 'UTM campaign', 'UTM term', 'UTM content',
  'Form', 'Name', 'Company / Brand', 'City', 'Phone', 'Email',
  'Product interest', 'Message', 'IP', 'User agent', 'Page'
];

/** Payload keys for the campaign columns, in HEADERS order. Absent or empty
 *  values (organic / direct visits) are written as blank cells. */
var CAMPAIGN_KEYS = ['gclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

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
      str_(data.gclid),
      str_(data.utm_source),
      str_(data.utm_medium),
      str_(data.utm_campaign),
      str_(data.utm_term),
      str_(data.utm_content),
      str_(data.form_location),
      str_(data.name),
      str_(data.company),
      str_(data.city),
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

/** Coerce to a trimmed string, capped so a hostile payload cannot bloat a cell
 *  or the email. No spreadsheet guard: this is what the email shows, where
 *  values are HTML-escaped instead. */
function text_(v) {
  var s = (v === undefined || v === null) ? '' : String(v).trim();
  if (s.length > 2000) { s = s.slice(0, 2000); }
  return s;
}

/** text_() plus the Sheets formula guard: a leading = + - @ is prefixed with a
 *  quote so Sheets never evaluates the cell. Use for everything written to the
 *  sheet, and nowhere else: a phone such as "+91 ..." would otherwise reach
 *  the email as "'+91 ..." and stop being tappable. */
function str_(v) {
  var s = text_(v);
  if (/^[=+\-@]/.test(s)) { s = "'" + s; }
  return s;
}

/** Normalised page id for the sheet: a short slug, or 'unknown' when the
 *  payload carries none (an older PHP build, or a hand-made POST). */
function pageId_(data) {
  var id = text_(data.page_id).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
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
  } else {
    ensureHeaders_(sheet);
  }
  return sheet;
}

/**
 * Bring an existing sheet's header row up to date with HEADERS by inserting
 * any missing column in place, so rows written by an earlier version of this
 * script keep their alignment and new rows land in the right columns.
 */
function ensureHeaders_(sheet) {
  var width = Math.max(sheet.getLastColumn(), 1);
  var row = sheet.getRange(1, 1, 1, width).getValues()[0];
  var dataRows = sheet.getLastRow() - 1;
  for (var i = 0; i < HEADERS.length; i++) {
    if (row[i] === HEADERS[i]) { continue; }
    if (row.indexOf(HEADERS[i]) !== -1) { continue; } // present elsewhere: leave the order alone
    sheet.insertColumnBefore(i + 1);
    sheet.getRange(1, i + 1).setValue(HEADERS[i]).setFontWeight('bold');
    if (HEADERS[i] === 'Page ID' && dataRows > 0) {
      sheet.getRange(2, i + 1, dataRows, 1).setValue('garment-tags'); // rows from the single-page era
    }
    row.splice(i, 0, HEADERS[i]);
  }
}

/** Shown in the email for a field the visitor left empty. */
var EMPTY_TEXT = '\u2014';
var EMPTY_HTML = '&mdash;';

/** Inline styles for the HTML email (email clients ignore <style> blocks). */
var STYLE_WRAP  = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#1a1a2e;max-width:640px;';
var STYLE_TABLE = 'border-collapse:collapse;width:100%;max-width:640px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#1a1a2e;';
var STYLE_TH    = 'text-align:left;font-weight:bold;vertical-align:top;white-space:nowrap;width:150px;padding:8px 12px;border:1px solid #dcdce4;background:#f4f4f8;';
var STYLE_TD    = 'vertical-align:top;padding:8px 12px;border:1px solid #dcdce4;word-break:break-word;';
var STYLE_LINK  = 'color:#1f2a44;';

/**
 * Notification email: an HTML body made of two bordered tables (the lead's
 * details, then the submission metadata) plus a plain-text alternative for
 * clients that do not render HTML. Values come from text_(), never str_(), so
 * the Sheets formula guard does not leak into the email.
 */
function sendNotification_(data, sheet) {
  if (!RECIPIENT_EMAIL) { return; }

  var name     = text_(data.name);
  var company  = text_(data.company);
  var phone    = text_(data.phone);
  var email    = text_(data.email);
  var city     = text_(data.city);
  var interest = text_(data.interest);
  var message  = text_(data.message);
  var form     = text_(data.form_location) || 'unknown';
  var page     = text_(data.page);
  var sheetUrl = sheet.getParent().getUrl();
  var pageName = pageName_(data);
  var heading  = 'New enquiry from the ' + (pageName || 'Holoflex') + ' landing page';

  // [label, plain value] in display order. An empty value renders as a dash.
  var lead = [
    ['Name',             name],
    ['Company / Brand',  company],
    ['Phone',            phone],
    ['Email',            email],
    ['City',             city],
    ['Product interest', interest],
    ['Message',          message]
  ];
  var meta = [
    ['Page ID',          pageId_(data)],
    ['Form',             form],
    ['Campaign / GCLID', campaignLine_(data)],
    ['Submitted',        text_(data.timestamp)],
    ['IP',               text_(data.ip)],
    ['Page',             page],
    ['Sheet link',       sheetUrl]
  ];

  // HTML overrides for cells that benefit from a link or line breaks.
  var html = {
    'Phone':      phone ? link_('tel:' + phone.replace(/[^\d+]/g, ''), phone) : '',
    'Email':      email ? link_('mailto:' + email, email) : '',
    'Message':    escapeHtml_(message).replace(/\r?\n/g, '<br>'),
    'Page':       /^https?:\/\//i.test(page) ? link_(page, page) : '',
    'Sheet link': link_(sheetUrl, sheetUrl)
  };

  var htmlBody =
    '<div style="' + STYLE_WRAP + '">' +
      '<p style="margin:0 0 14px;font-size:17px;font-weight:bold;">' + escapeHtml_(heading) + '</p>' +
      htmlTable_(lead, html) +
      '<hr style="border:0;border-top:1px solid #dcdce4;margin:24px 0 12px;">' +
      '<p style="margin:0 0 8px;font-size:12px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;color:#6b6b80;">Submission details</p>' +
      htmlTable_(meta, html) +
    '</div>';

  var textBody =
    heading + '\n\n' +
    textBlock_(lead) + '\n\n' +
    '--- Submission details ---\n' +
    textBlock_(meta);

  var options = { name: 'Holoflex Website', htmlBody: htmlBody };
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    options.replyTo = email;
  }

  MailApp.sendEmail(
    RECIPIENT_EMAIL,
    'New ' + (pageName ? pageName + ' ' : '') + 'enquiry \u2014 ' + (company || '(no company)') + ' (' + form + ' form)',
    textBody,
    options
  );
}

/** One bordered two-column table: bold label on the left, value on the right. */
function htmlTable_(rows, htmlOverrides) {
  var out = '<table cellpadding="0" cellspacing="0" border="0" style="' + STYLE_TABLE + '">';
  for (var i = 0; i < rows.length; i++) {
    var label = rows[i][0];
    var value = rows[i][1];
    var cell = value ? (htmlOverrides[label] || escapeHtml_(value)) : EMPTY_HTML;
    out += '<tr>' +
      '<th style="' + STYLE_TH + '">' + escapeHtml_(label) + '</th>' +
      '<td style="' + STYLE_TD + '">' + cell + '</td>' +
    '</tr>';
  }
  return out + '</table>';
}

/** Plain-text fallback: "Label:   value" lines with the values aligned;
 *  a multi-line value (the message) continues indented under its label. */
function textBlock_(rows) {
  var width = 0;
  for (var i = 0; i < rows.length; i++) { width = Math.max(width, rows[i][0].length + 1); }
  var indent = new Array(width + 2).join(' ');
  var lines = [];
  for (var j = 0; j < rows.length; j++) {
    var label = rows[j][0] + ':';
    while (label.length < width) { label += ' '; }
    var value = rows[j][1] || EMPTY_TEXT;
    lines.push(label + ' ' + value.replace(/\r?\n/g, '\n' + indent));
  }
  return lines.join('\n');
}

function link_(href, label) {
  return '<a href="' + escapeHtml_(href) + '" style="' + STYLE_LINK + '">' + escapeHtml_(label) + '</a>';
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "gclid=..., utm_source=..." for the email, or a note when nothing was captured. */
function campaignLine_(data) {
  var parts = [];
  for (var i = 0; i < CAMPAIGN_KEYS.length; i++) {
    var v = text_(data[CAMPAIGN_KEYS[i]]);
    if (v) { parts.push(CAMPAIGN_KEYS[i] + '=' + v); }
  }
  return parts.length ? parts.join(', ') : '(none \u2014 organic or direct visit)';
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
    gclid: 'TeSt-GcLiD-123',
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'garment-tags-search',
    utm_term: 'garment tag manufacturer',
    utm_content: '',
    form_location: 'hero',
    name: 'Test Lead',
    company: 'Test Apparel Co',
    city: 'Tiruppur',
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
