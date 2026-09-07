<?php
/**
 * Holoflex — Garment Tags landing page: enquiry endpoint
 * /submit-enquiry.php
 *
 * Accepts a POST from the landing-page forms, validates and sanitises every
 * field server-side, filters bots (honeypot, timing, per-IP rate limit), then
 * delivers the lead in this order:
 *
 *   1. CSV append (system of record — the request fails only if this fails)
 *   2. JSON POST to the Google Apps Script webhook (optional, 5 s cap)
 *   3. One mail() attempt
 *
 * Steps 2 and 3 are best effort: a failure is logged to lp-errors.log and the
 * browser still receives success, because the lead is already in the CSV.
 *
 * Response is always JSON:  {"success":true}  or  {"success":false,"error":"..."}
 * No submitted value is ever echoed back in the response.
 *
 * Targets PHP 7.4+. No 8.x-only syntax.
 */

declare(strict_types=1);

/* ==========================================================================
   CONFIGURATION — edit these
   ========================================================================== */

/** Where the lead emails go. Comma-separate for more than one recipient. */
define('LP_RECIPIENT_EMAIL', 'holoflex@gmail.com, plandleadtest@gmail.com');

/** The From address on lead emails. Should be a mailbox on the sending domain
 *  so SPF/DMARC pass. Reply-To is set to the enquirer's email when provided. */
define('LP_FROM_EMAIL', 'no-reply@holoflex.com');
define('LP_FROM_NAME',  'Holoflex Website');

/**
 * Identifies this landing page. All Holoflex landing pages share one Apps
 * Script deployment and one Google Sheet; this value is what tells the leads
 * apart in the CSV, the Sheet and the notification email. Use a short slug:
 * "garment-tags" | "self-adhesive-labels" | "holograms".
 */
define('LP_PAGE_ID', 'garment-tags');

/** Public URL of this landing page, recorded with each lead (CSV, Sheet, email). */
define('LP_PAGE_URL', 'https://www.holoflex.com/garment_tags/');

/** Subject line prefix on lead emails. */
define('LP_SUBJECT', 'New garment tag enquiry');

/**
 * Google Apps Script web-app URL that receives each lead as JSON and writes it
 * to a Google Sheet (see _source/apps-script/Code.gs). Leave EMPTY to skip the
 * webhook entirely; the endpoint works with or without it.
 * Format: https://script.google.com/macros/s/AKfycb.../exec
 */
define('LP_WEBHOOK_URL', 'https://script.google.com/macros/s/AKfycbwTWHLJP9Avz6X3RCYp2J8cMABY-nyi11R1JDuGGvZycvSh4VBk5rMmIZsN02UrI1L2/exec');

/** Optional shared secret sent as "token" in the webhook payload. Set the same
 *  value in SHARED_SECRET in Code.gs so the script ignores posts from anyone
 *  else. Leave empty to disable the check on both sides. */
define('LP_WEBHOOK_SECRET', 'XOqRmzY9jICpcA48ZnUGaThgK0x6ikrEeWLvyu21F3HPSBN5');

/** Hard cap on the webhook round-trip, in seconds. */
define('LP_WEBHOOK_TIMEOUT', 5);

/**
 * Storage for the CSV, rate-limit data and error log.
 *
 * Must be ABOVE the web root so the files are never web-accessible. On the
 * Holoflex server the document root is /home/holoflex/public_html and this
 * folder is /home/holoflex/lp-data (confirmed writable). The folder is created
 * on first use if it does not exist. If it cannot be written to, submissions
 * return an error (nothing is ever written inside the web root).
 */
define('LP_DATA_DIR', '/home/holoflex/lp-data');

/** CSV file name (inside the data dir). */
define('LP_CSV_FILE', 'garment-tags-enquiries.csv');

/** Rate limit: at most LP_RATE_MAX submissions per IP per LP_RATE_WINDOW seconds. */
define('LP_RATE_MAX',    5);
define('LP_RATE_WINDOW', 600);

/** Minimum milliseconds between page load and submit (bot filter). */
define('LP_MIN_ELAPSED_MS', 2500);

/** Timezone for timestamps in the CSV and email. */
define('LP_TIMEZONE', 'Asia/Kolkata');

/* ==========================================================================
   END CONFIGURATION
   ========================================================================== */

ini_set('display_errors', '0');
error_reporting(E_ALL);
date_default_timezone_set(LP_TIMEZONE);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('X-Content-Type-Options: nosniff');

/**
 * Send a JSON response and stop.
 */
function lp_respond(bool $success, string $error = '', int $status = 200): void
{
    http_response_code($status);
    $payload = $success ? ['success' => true] : ['success' => false, 'error' => $error];
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * Log to the data dir if possible, else to PHP's error log. Never throws.
 */
function lp_log(string $message): void
{
    $line = '[' . date('Y-m-d H:i:s') . '] ' . $message . PHP_EOL;
    $dir = lp_data_dir();
    if ($dir !== null) {
        @file_put_contents($dir . DIRECTORY_SEPARATOR . 'lp-errors.log', $line, FILE_APPEND | LOCK_EX);
    } else {
        error_log('garment-tags-lp: ' . $message);
    }
}

/**
 * Resolve the data directory, creating it on first use. Result cached.
 *
 * @return string|null  Absolute path, or null if it is not writable.
 */
function lp_data_dir(): ?string
{
    static $resolved = false;
    static $dir = null;

    if ($resolved) {
        return $dir;
    }
    $resolved = true;

    if (lp_ensure_dir(LP_DATA_DIR)) {
        $dir = LP_DATA_DIR;
    }
    return $dir;
}

/**
 * Create the directory if needed and confirm it is writable.
 */
function lp_ensure_dir(string $path): bool
{
    if (!is_dir($path)) {
        if (!@mkdir($path, 0750, true) && !is_dir($path)) {
            return false;
        }
    }
    return is_writable($path);
}

/**
 * Best-effort client IP. Only trusts proxy headers when the request actually
 * arrived from a private/loopback address (i.e. behind a reverse proxy).
 */
function lp_client_ip(): string
{
    $remote = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    $isPrivate = filter_var(
        $remote,
        FILTER_VALIDATE_IP,
        FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
    ) === false;
    if ($isPrivate) {
        foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_REAL_IP', 'HTTP_X_FORWARDED_FOR'] as $h) {
            if (!empty($_SERVER[$h])) {
                $candidate = trim(explode(',', (string) $_SERVER[$h])[0]);
                if (filter_var($candidate, FILTER_VALIDATE_IP)) {
                    return $candidate;
                }
            }
        }
    }
    return $remote;
}

/**
 * Per-IP sliding-window rate limit stored in one JSON file with an exclusive lock.
 * Returns true when the request is allowed. Fails OPEN if storage is unavailable
 * (the honeypot and timing checks still apply).
 */
function lp_rate_limit_ok(string $ip): bool
{
    $dir = lp_data_dir();
    if ($dir === null) {
        return true;
    }
    $file = $dir . DIRECTORY_SEPARATOR . 'rate-limit.json';
    $fh = @fopen($file, 'c+');
    if ($fh === false) {
        return true;
    }
    if (!flock($fh, LOCK_EX)) {
        fclose($fh);
        return true;
    }

    $raw = stream_get_contents($fh);
    $data = $raw !== '' ? json_decode($raw, true) : [];
    if (!is_array($data)) {
        $data = [];
    }

    $now = time();
    $key = hash('sha256', $ip);
    $allowed = true;

    // Prune expired timestamps for every IP so the file cannot grow without bound.
    foreach ($data as $k => $stamps) {
        $stamps = array_values(array_filter((array) $stamps, function ($t) use ($now) {
            return is_int($t) && ($now - $t) < LP_RATE_WINDOW;
        }));
        if (count($stamps) === 0) {
            unset($data[$k]);
        } else {
            $data[$k] = $stamps;
        }
    }

    $mine = $data[$key] ?? [];
    if (count($mine) >= LP_RATE_MAX) {
        $allowed = false;
    } else {
        $mine[] = $now;
        $data[$key] = $mine;
    }

    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($data));
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);

    return $allowed;
}

/**
 * Basic string sanitiser: force UTF-8, strip control characters, collapse
 * whitespace (newlines kept when $multiline), trim, cap length.
 */
function lp_clean(string $value, int $max, bool $multiline = false): string
{
    if (!mb_check_encoding($value, 'UTF-8')) {
        $value = mb_convert_encoding($value, 'UTF-8', 'UTF-8');
    }
    $value = $multiline
        ? preg_replace('/[^\P{C}\n\r\t]+/u', '', $value)   // keep newlines/tabs
        : preg_replace('/\p{C}+/u', '', $value);           // strip all control chars
    $value = $multiline
        ? preg_replace("/[ \t]+/", ' ', (string) $value)
        : preg_replace('/\s+/', ' ', (string) $value);
    $value = trim((string) $value);
    if (mb_strlen($value) > $max) {
        $value = mb_substr($value, 0, $max);
    }
    return $value;
}

/**
 * Neutralise spreadsheet formula injection: a leading = + - @ or tab/CR makes
 * Excel/Sheets evaluate the cell, so prefix with a single quote.
 */
function lp_csv_safe(string $value): string
{
    if ($value !== '' && preg_match('/^[=+\-@\t\r]/', $value)) {
        return "'" . $value;
    }
    return $value;
}

/**
 * Header-safe single line for email headers/subject (no CR/LF).
 */
function lp_header_safe(string $value): string
{
    return trim(str_replace(["\r", "\n", "\0"], ' ', $value));
}

/**
 * Forward the lead to the Apps Script webhook as JSON.
 *
 * Best effort only: capped at LP_WEBHOOK_TIMEOUT seconds, follows redirects
 * (Apps Script web apps answer with a 302 to the actual result), never throws.
 * Returns true on an HTTP 2xx after redirects, false otherwise (and logs).
 */
function lp_post_webhook(array $payload): bool
{
    if (LP_WEBHOOK_URL === '') {
        return true; // not configured: skip silently
    }

    $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        lp_log('Webhook: could not encode payload as JSON. Lead is in the CSV.');
        return false;
    }

    $status = 0;
    $error  = '';
    $headers = ['Content-Type: application/json; charset=utf-8', 'Accept: application/json'];

    if (function_exists('curl_init')) {
        $ch = curl_init(LP_WEBHOOK_URL);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $json,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,   // Apps Script: 302 -> script.googleusercontent.com
            CURLOPT_MAXREDIRS      => 5,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_TIMEOUT        => LP_WEBHOOK_TIMEOUT,
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        $response = curl_exec($ch);
        $status   = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if ($response === false) {
            $error = curl_error($ch);
        }
        curl_close($ch);
    } else {
        // Streams fallback when the cURL extension is not available.
        $ctx = stream_context_create(['http' => [
            'method'        => 'POST',
            'header'        => implode("\r\n", $headers) . "\r\n",
            'content'       => $json,
            'timeout'       => LP_WEBHOOK_TIMEOUT,
            'follow_location' => 1,
            'max_redirects' => 5,
            'ignore_errors' => true,
        ]]);
        // 'timeout' above only covers reads; the connect phase follows
        // default_socket_timeout (60 s), so pin that to the same cap.
        $prevSocketTimeout = ini_get('default_socket_timeout');
        ini_set('default_socket_timeout', (string) LP_WEBHOOK_TIMEOUT);
        $fp = @fopen(LP_WEBHOOK_URL, 'r', false, $ctx);
        ini_set('default_socket_timeout', (string) $prevSocketTimeout);
        if ($fp === false) {
            $last  = error_get_last();
            $error = is_array($last) ? (string) ($last['message'] ?? 'request failed') : 'request failed';
        } else {
            stream_set_timeout($fp, LP_WEBHOOK_TIMEOUT);
            @stream_get_contents($fp);
            // wrapper_data holds the status line of every hop; the last one wins.
            $meta = stream_get_meta_data($fp);
            if (!empty($meta['wrapper_data']) && is_array($meta['wrapper_data'])) {
                foreach ($meta['wrapper_data'] as $line) {
                    if (is_string($line) && preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
                        $status = (int) $m[1];
                    }
                }
            }
            if (!empty($meta['timed_out'])) {
                $error = 'read timed out';
            }
            fclose($fp);
        }
    }

    if ($status < 200 || $status >= 300) {
        lp_log('Webhook failed: HTTP ' . $status . ($error !== '' ? ' (' . mb_substr($error, 0, 200) . ')' : '') . '. Lead is in the CSV.');
        return false;
    }
    return true;
}

/* ==========================================================================
   MAIN
   ========================================================================== */
try {
    // --- Method ---------------------------------------------------------
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        header('Allow: POST');
        lp_respond(false, 'Method not allowed.', 405);
    }

    // --- Same-origin check (when the browser sends an Origin header) ------
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '') {
        $originHost = strtolower((string) parse_url($origin, PHP_URL_HOST));
        $selfHost = strtolower((string) preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
        if ($originHost === '' || $originHost !== $selfHost) {
            lp_respond(false, 'Request not accepted.', 403);
        }
    }

    // --- Honeypot ---------------------------------------------------------
    if (isset($_POST['website']) && trim((string) $_POST['website']) !== '') {
        // Pretend success so bots do not learn from the response.
        lp_respond(true);
    }

    // --- Timing (bot filter) ----------------------------------------------
    $elapsed = isset($_POST['elapsed']) ? (int) $_POST['elapsed'] : -1;
    if ($elapsed >= 0 && $elapsed < LP_MIN_ELAPSED_MS) {
        lp_respond(true); // silently drop: submitted faster than a human can type
    }

    // --- Collect + sanitise -----------------------------------------------
    $name     = lp_clean((string) ($_POST['name'] ?? ''), 100);
    $company  = lp_clean((string) ($_POST['company'] ?? ''), 120);
    $phoneRaw = lp_clean((string) ($_POST['phone'] ?? ''), 20);
    $email    = lp_clean((string) ($_POST['email'] ?? ''), 150);
    $interest = lp_clean((string) ($_POST['interest'] ?? ''), 80);
    $message  = lp_clean((string) ($_POST['message'] ?? ''), 2000, true);
    $formLoc  = lp_clean((string) ($_POST['form_location'] ?? ''), 20);

    // Campaign attribution, captured client-side from the landing URL and
    // posted as hidden fields. All optional: organic and direct visits send
    // them empty. Kept verbatim (capped) so the Sheet can be matched to
    // Google Ads for offline conversion import.
    $campaign = [];
    foreach (['gclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as $key) {
        $campaign[$key] = lp_clean((string) ($_POST[$key] ?? ''), 200);
    }
    $campaignParts = [];
    foreach ($campaign as $key => $value) {
        if ($value !== '') {
            $campaignParts[] = $key . '=' . $value;
        }
    }
    $campaignLine = $campaignParts !== [] ? implode(', ', $campaignParts) : '(none — organic or direct visit)';

    // --- Validate ---------------------------------------------------------
    if (mb_strlen($name) < 2) {
        lp_respond(false, 'Please enter your name.', 422);
    }
    if ($company === '') {
        lp_respond(false, 'Please enter your company or brand name.', 422);
    }

    $phone = preg_replace('/[\s\-().]/', '', $phoneRaw);
    if (!preg_match('/^(?:\+?91|0)?[6-9]\d{9}$/', (string) $phone)) {
        lp_respond(false, 'Please enter a valid 10-digit Indian mobile number.', 422);
    }
    // Normalise. Email shows "+91 98765 43210"; the CSV column omits the "+" so
    // spreadsheets keep it as text instead of treating it as a formula/number.
    $digits   = substr((string) $phone, -10);
    $phone    = '+91 ' . substr($digits, 0, 5) . ' ' . substr($digits, 5);
    $phoneCsv = '91 ' . substr($digits, 0, 5) . ' ' . substr($digits, 5);

    if ($email !== '') {
        if (mb_strlen($email) > 150 || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            lp_respond(false, 'Please enter a valid email address, or leave it blank.', 422);
        }
        $email = strtolower($email);
    }

    $allowedInterests = [
        'Garment tags — 3-in-1 plastic tag',
        'Security / hologram garment tags',
        'Barcode tags and TTR ribbon supply',
        'Other labels or tags',
    ];
    if (!in_array($interest, $allowedInterests, true)) {
        lp_respond(false, 'Please choose a product interest.', 422);
    }

    if (!in_array($formLoc, ['hero', 'footer'], true)) {
        $formLoc = 'unknown';
    }

    // --- Rate limit (well-formed submissions only) ------------------------
    $ip = lp_client_ip();
    if (!lp_rate_limit_ok($ip)) {
        lp_respond(false, 'Too many requests. Please wait a few minutes and try again, or call us on +91 62923 00439.', 429);
    }

    // --- Storage ----------------------------------------------------------
    $dir = lp_data_dir();
    if ($dir === null) {
        lp_log('Data directory is not writable: ' . LP_DATA_DIR);
        lp_respond(false, 'We could not save your enquiry. Please call or WhatsApp +91 62923 00439.', 500);
    }

    $timestamp = date('Y-m-d H:i:s');
    $userAgent = lp_clean((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 255);

    // --- 1. CSV first: this is the system of record ----------------------
    $csvPath = $dir . DIRECTORY_SEPARATOR . LP_CSV_FILE;
    $isNew = !is_file($csvPath) || filesize($csvPath) === 0;
    $fh = @fopen($csvPath, 'a');
    if ($fh === false || !flock($fh, LOCK_EX)) {
        if ($fh !== false) {
            fclose($fh);
        }
        lp_log('Cannot open CSV for writing: ' . $csvPath);
        lp_respond(false, 'We could not save your enquiry. Please call or WhatsApp +91 62923 00439.', 500);
    }
    if ($isNew) {
        fputcsv($fh, ['timestamp', 'page_id', 'gclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'form', 'name', 'company', 'phone', 'email', 'interest', 'message', 'ip', 'user_agent', 'page'], ',', '"', '');
    }
    $written = fputcsv($fh, [
        $timestamp,
        LP_PAGE_ID,
        lp_csv_safe($campaign['gclid']),
        lp_csv_safe($campaign['utm_source']),
        lp_csv_safe($campaign['utm_medium']),
        lp_csv_safe($campaign['utm_campaign']),
        lp_csv_safe($campaign['utm_term']),
        lp_csv_safe($campaign['utm_content']),
        $formLoc,
        lp_csv_safe($name),
        lp_csv_safe($company),
        $phoneCsv,
        lp_csv_safe($email),
        lp_csv_safe($interest),
        lp_csv_safe($message),
        $ip,
        lp_csv_safe($userAgent),
        LP_PAGE_URL,
    ], ',', '"', '');
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);

    if ($written === false) {
        lp_log('fputcsv failed for CSV: ' . $csvPath);
        lp_respond(false, 'We could not save your enquiry. Please call or WhatsApp +91 62923 00439.', 500);
    }

    // --- 2. Webhook to Google Sheets (best effort, 5 s cap) ----------------
    $payload = [
        'timestamp'     => $timestamp,
        'page_id'       => LP_PAGE_ID,
        'gclid'         => $campaign['gclid'],
        'utm_source'    => $campaign['utm_source'],
        'utm_medium'    => $campaign['utm_medium'],
        'utm_campaign'  => $campaign['utm_campaign'],
        'utm_term'      => $campaign['utm_term'],
        'utm_content'   => $campaign['utm_content'],
        'form_location' => $formLoc,
        'name'          => $name,
        'company'       => $company,
        'phone'         => $phone,
        'email'         => $email,
        'interest'      => $interest,
        'message'       => $message,
        'ip'            => $ip,
        'user_agent'    => $userAgent,
        'page'          => LP_PAGE_URL,
    ];
    if (LP_WEBHOOK_SECRET !== '') {
        $payload['token'] = LP_WEBHOOK_SECRET;
    }
    lp_post_webhook($payload);

    // --- 3. Email: ONE attempt (best effort: a failure is logged) ---------
    $subject = lp_header_safe(LP_SUBJECT . ' — ' . $company . ' (' . $formLoc . ' form)');
    $encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';

    $bodyLines = [
        'New enquiry from the Garment Tags landing page',
        '',
        'Name:             ' . $name,
        'Company / Brand:  ' . $company,
        'Phone:            ' . $phone,
        'Email:            ' . ($email !== '' ? $email : '(not provided)'),
        'Product interest: ' . $interest,
        'Message:',
        $message !== '' ? $message : '(none)',
        '',
        '---',
        'Form:      ' . $formLoc,
        'Submitted: ' . $timestamp,
        'IP:        ' . $ip,
        'Page:      ' . LP_PAGE_URL,
        'Page ID:   ' . LP_PAGE_ID,
        'Campaign:  ' . $campaignLine,
    ];
    $body = implode("\r\n", $bodyLines);

    $headers = [
        'From: =?UTF-8?B?' . base64_encode(LP_FROM_NAME) . '?= <' . lp_header_safe(LP_FROM_EMAIL) . '>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        'X-Mailer: PHP/' . PHP_VERSION,
    ];
    if ($email !== '') {
        $headers[] = 'Reply-To: ' . lp_header_safe($email);
    }

    // Single attempt, no retry: on hosts where the SMTP port is silently
    // dropped a mail() call can block for ~21 s, and a retry would double that.
    $mailed = false;
    if (function_exists('mail')) {
        $mailed = @mail(LP_RECIPIENT_EMAIL, $encodedSubject, $body, implode("\r\n", $headers));
    }
    if (!$mailed) {
        lp_log('mail() failed for enquiry at ' . $timestamp . ' (' . $formLoc . ' form, company: ' . $company . '). Lead is in the CSV.');
    }

    // The CSV write succeeded, so the lead is safe regardless of steps 2 and 3.
    lp_respond(true);

} catch (Throwable $e) {
    lp_log('Unhandled error: ' . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    lp_respond(false, 'Sorry, something went wrong. Please call or WhatsApp +91 62923 00439.', 500);
}
