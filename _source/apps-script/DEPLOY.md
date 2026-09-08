# Lead webhook — Google Sheet + Apps Script

Receives each landing-page lead from `submit-enquiry.php`, appends it to a
Google Sheet and emails a notification. This runs in addition to the CSV on the
server and the PHP `mail()` call, so a lead is delivered even if the host's mail
is unreliable.

## One deployment for all landing pages

This single script and Sheet serve **all three** Holoflex landing pages:
Garment Tags, Self-Adhesive Labels and Holograms. Do not create a second
`Code.gs` or a second Sheet per page.

Each page's `submit-enquiry.php` sends a `page_id` (its `LP_PAGE_ID` constant),
which the script writes to the **Page ID** column (column B, next to the
timestamp) and uses in the email subject, e.g.
`New Garment Tags enquiry — Acme Apparel (hero form)`.

To connect a new landing page, its `submit-enquiry.php` needs only:

```php
define('LP_PAGE_ID',        'self-adhesive-labels');   // or 'holograms'
define('LP_WEBHOOK_URL',    '…the SAME web-app URL as the other pages…');
define('LP_WEBHOOK_SECRET', '…the SAME value as SHARED_SECRET…');
```

Nothing changes in this script. The ids it knows by name are listed in
`PAGE_NAMES` in `Code.gs`; an id that is missing or not listed is still accepted
(stored as `unknown` or shown verbatim), so a mismatch never loses a lead. If a
new page gets a new slug, add it to `PAGE_NAMES` and redeploy a new version so
the email names the product.

## Deploy

1. **Create the Sheet.** In the Google account that should own the leads, create
   a new Google Sheet, e.g. "Holoflex — Landing Page Leads". Leave it empty; the
   script creates a `Leads` tab with a bold, frozen header row on the first lead.
   (A Sheet created by the earlier garment-tags-only script keeps working: the
   script inserts the Page ID column on its next run.)

2. **Add the script.** In the Sheet: **Extensions → Apps Script**. Delete the
   default contents of `Code.gs`, paste in this folder's `Code.gs`, and save.

3. **Set the constants** at the top of `Code.gs`:
   - `RECIPIENT_EMAIL` – who receives the notification email.
   - `SHARED_SECRET` – optional. Any random string, e.g. 32 characters. Put the
     identical value in `LP_WEBHOOK_SECRET` in `submit-enquiry.php`. With it set,
     the script ignores any POST that does not carry the secret.

4. **Test once from the editor.** Select `testDoPost` in the function dropdown
   and click **Run**. Approve the permission prompt (the script needs
   Spreadsheets and Send email). Check the `Leads` tab gains a row and the email
   arrives.

5. **Deploy as a web app.** **Deploy → New deployment → Select type: Web app.**
   - Description: `Holoflex lead webhook`
   - Execute as: **Me**
   - Who has access: **Anyone**  (required — the PHP server is not signed in)
   Click **Deploy** and copy the **Web app URL**
   (`https://script.google.com/macros/s/AKfycb…/exec`).

6. **Point the PHP at it.** In each landing page's `submit-enquiry.php` set:
   ```php
   define('LP_PAGE_ID', 'garment-tags');   // this page's slug
   define('LP_WEBHOOK_URL', 'https://script.google.com/macros/s/AKfycb…/exec');
   define('LP_WEBHOOK_SECRET', '…same value as SHARED_SECRET…');
   ```
   Upload the file. Submit a test enquiry on the live page and confirm the row
   appears in the Sheet with the right Page ID.

## Updating the script later

After editing `Code.gs`, go to **Deploy → Manage deployments**, choose the
deployment, click the pencil, set **Version: New version**, and **Deploy**. The
URL stays the same. (Saving the file alone does not update the live web app.)

## Behaviour notes

- Columns C–H (GCLID, UTM source/medium/campaign/term/content) are captured by
  the landing page from its URL and posted with the lead. They are blank for
  organic and direct visits. For Google Ads offline conversion import, export
  GCLID plus Timestamp for the leads that qualified.
- **City** (optional on the forms, added 2026-09-08) is column L, right after
  Company / Brand. Blank when the visitor left it empty.
- Adding columns later is safe: the script inserts any header it is missing in
  place, so a sheet created by an older version keeps its rows aligned.
- The notification email is HTML: two bordered label/value tables (the lead,
  then a "Submission details" block) with a plain-text part for clients that
  do not render HTML. Empty fields show as "—". Email values are taken
  without the Sheets formula guard (the leading `'` on `+91 ...`), so the
  phone number is tappable; the guard still applies to every sheet cell.

- The PHP caps the webhook round-trip at 5 seconds and follows the 302 that
  Apps Script returns. A failure is written to `/home/holoflex/lp-data/lp-errors.log`
  and the visitor still gets success, because the CSV was already written.
- Apps Script `MailApp` has a daily send quota (100 per day for consumer Gmail,
  1,500 for Google Workspace). A quota failure is reported in the JSON response
  (`mail_error`) but the sheet row is still saved.
- The Sheet is the easiest place for the sales team to work leads. Consider
  sharing it with them directly rather than relying on the email.
