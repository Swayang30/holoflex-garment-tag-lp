# Lead webhook — Google Sheet + Apps Script

Receives each landing-page lead from `submit-enquiry.php`, appends it to a
Google Sheet and emails a notification. This runs in addition to the CSV on the
server and the PHP `mail()` call, so a lead is delivered even if the host's mail
is unreliable.

## Deploy

1. **Create the Sheet.** In the Google account that should own the leads, create
   a new Google Sheet, e.g. "Holoflex — Garment Tag Leads". Leave it empty; the
   script creates a `Leads` tab with a bold, frozen header row on the first lead.

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

6. **Point the PHP at it.** In `submit-enquiry.php` set:
   ```php
   define('LP_WEBHOOK_URL', 'https://script.google.com/macros/s/AKfycb…/exec');
   define('LP_WEBHOOK_SECRET', '…same value as SHARED_SECRET…');
   ```
   Upload the file. Submit a test enquiry on the live page and confirm the row
   appears in the Sheet.

## Updating the script later

After editing `Code.gs`, go to **Deploy → Manage deployments**, choose the
deployment, click the pencil, set **Version: New version**, and **Deploy**. The
URL stays the same. (Saving the file alone does not update the live web app.)

## Behaviour notes

- The PHP caps the webhook round-trip at 5 seconds and follows the 302 that
  Apps Script returns. A failure is written to `/home/holoflex/lp-data/lp-errors.log`
  and the visitor still gets success, because the CSV was already written.
- Apps Script `MailApp` has a daily send quota (100 per day for consumer Gmail,
  1,500 for Google Workspace). A quota failure is reported in the JSON response
  (`mail_error`) but the sheet row is still saved.
- The Sheet is the easiest place for the sales team to work leads. Consider
  sharing it with them directly rather than relying on the email.
