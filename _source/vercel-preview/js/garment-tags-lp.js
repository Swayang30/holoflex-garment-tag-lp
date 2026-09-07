/* ==========================================================================
   Holoflex — Garment Tags landing page + thank-you page  [VERCEL PREVIEW COPY]
   /js/garment-tags-lp.js

   Vanilla JS, no dependencies. Loaded with `defer` on both
   /index.html and /thank-you-lp.html. Sections that need elements
   the current page does not have simply do nothing.

   Contents
     1. dataLayer helpers (GTM events)
     2. Header: hamburger menu
     3. "Get a Quote" links: scroll to hero form and focus it
     4. Click tracking: tel:, WhatsApp, header quote button
     5. FAQ accordion (keyboard-operable)
     6. Enquiry forms: validation, fetch submit, redirect to thank-you page
     7. Fixed bottom stack: keyboard-aware action bar, cookie banner, body offset
     8. Thank-you page: single-use token -> conversion event

   GTM dataLayer events pushed by this file:
     enquiry_form_submit     THANK-YOU PAGE ONLY. { page_id: "garment-tags",
                             form_location: "hero" | "footer",
                             user_data: { phone_number, email? } }
                             page_id identifies the landing page so GTM and
                             Google Ads can report conversions per page.
                             Fired once per lead from the single-use
                             sessionStorage token written before the redirect.
                             A refresh, bookmark or direct visit pushes nothing.
                             user_data is unhashed, for Google Ads Enhanced
                             Conversions via a GTM "User-Provided Data"
                             variable (GTM hashes it before sending).
     click_call              { link_location, link_url }
     click_whatsapp          { link_location, link_url }
     click_get_quote_header  {}
     cookie_consent          { consent_choice: "accept" | "reject" }
   ========================================================================== */
(function () {
  'use strict';

  var ENDPOINT = '/submit-enquiry.php';
  var THANK_YOU_URL = '/thank-you-lp.html';
  var PAGE_ID = 'garment-tags';             // must match LP_PAGE_ID in submit-enquiry.php
  var TOKEN_KEY = 'lp_lead_token';          // sessionStorage key for the single-use lead token
  var COOKIE_KEY = 'lp_cookie_consent';
  var REQUEST_TIMEOUT_MS = 40000;           // > worst-case server path (5 s webhook + ~21 s mail hang)
  var PAGE_LOADED_AT = Date.now();
  var IS_THANK_YOU = document.body.getAttribute('data-page') === 'thank-you';

  /* ------------------------------------------------------------------------
     1. dataLayer helpers
     ------------------------------------------------------------------------ */
  window.dataLayer = window.dataLayer || [];

  function track(eventName, params) {
    var payload = { event: eventName };
    if (params) {
      for (var k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k)) { payload[k] = params[k]; }
      }
    }
    try { window.dataLayer.push(payload); } catch (e) { /* never block the UI on analytics */ }
  }

  function locationOf(el) {
    // Explicit data attribute first, otherwise the nearest section/footer id or tag name.
    var explicit = el.getAttribute('data-track-location');
    if (explicit) { return explicit; }
    var section = el.closest('section, header, footer, [id]');
    if (!section) { return 'page'; }
    if (section.id) { return section.id; }
    return section.tagName.toLowerCase();
  }

  /* ------------------------------------------------------------------------
     2. Header: hamburger menu
     ------------------------------------------------------------------------ */
  var burger = document.querySelector('.lp-burger');
  var nav = document.getElementById('lp-nav');

  function setMenu(open) {
    if (!burger || !nav) { return; }
    nav.classList.toggle('is-open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    if (open) {
      var first = nav.querySelector('a');
      if (first) { first.focus(); }
    }
  }

  if (burger && nav) {
    burger.addEventListener('click', function () {
      setMenu(!nav.classList.contains('is-open'));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) {
        setMenu(false);
        burger.focus();
      }
    });
    document.addEventListener('click', function (e) {
      if (!nav.classList.contains('is-open')) { return; }
      if (nav.contains(e.target) || burger.contains(e.target)) { return; }
      setMenu(false);
    });
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) { setMenu(false); }
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth >= 1100 && nav.classList.contains('is-open')) { setMenu(false); }
    });
  }

  /* ------------------------------------------------------------------------
     3. "Get a Quote" links → scroll to the hero form, focus the Name field
        (on the thank-you page these links point back to the landing page)
     ------------------------------------------------------------------------ */
  var heroForm = document.querySelector('#enquiry-hero .lp-form');

  function focusHeroForm() {
    if (!heroForm) { return; }
    var target = heroForm.querySelector('input[name="name"]');
    if (!target) { return; }
    // Let the smooth scroll finish before focusing, otherwise focus jumps the scroll.
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(function () {
      try { target.focus({ preventScroll: true }); } catch (err) { target.focus(); }
    }, reduce ? 0 : 450);
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-quote-link]'), function (link) {
    link.addEventListener('click', function () {
      if (link.hasAttribute('data-track-header-quote')) { track('click_get_quote_header'); }
      focusHeroForm(); // native anchor navigation handles the scroll
    });
  });

  /* ------------------------------------------------------------------------
     4. Click tracking: tel: and WhatsApp links
     ------------------------------------------------------------------------ */
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[href]');
    if (!a) { return; }
    var href = a.getAttribute('href') || '';
    if (href.indexOf('tel:') === 0) {
      track('click_call', { link_location: locationOf(a), link_url: href });
    } else if (/(^|\/\/)(wa\.me|api\.whatsapp\.com|whatsapp\.com)/i.test(href)) {
      track('click_whatsapp', { link_location: locationOf(a), link_url: href });
    }
  });

  /* ------------------------------------------------------------------------
     5. FAQ accordion
        Buttons carry aria-expanded / aria-controls; panels use [hidden].
        Keyboard: Enter/Space (native), Up/Down/Home/End move between questions.
     ------------------------------------------------------------------------ */
  var accordion = document.querySelector('[data-accordion]');
  if (accordion) {
    var triggers = Array.prototype.slice.call(accordion.querySelectorAll('.lp-acc__trigger'));

    var setPanel = function (btn, open) {
      var panel = document.getElementById(btn.getAttribute('aria-controls'));
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (panel) { panel.hidden = !open; }
    };

    triggers.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var isOpen = btn.getAttribute('aria-expanded') === 'true';
        // One open at a time, matching the design.
        triggers.forEach(function (other) { if (other !== btn) { setPanel(other, false); } });
        setPanel(btn, !isOpen);
      });
      btn.addEventListener('keydown', function (e) {
        var i = triggers.indexOf(btn);
        var next = null;
        if (e.key === 'ArrowDown') { next = triggers[(i + 1) % triggers.length]; }
        else if (e.key === 'ArrowUp') { next = triggers[(i - 1 + triggers.length) % triggers.length]; }
        else if (e.key === 'Home') { next = triggers[0]; }
        else if (e.key === 'End') { next = triggers[triggers.length - 1]; }
        if (next) { e.preventDefault(); next.focus(); }
      });
    });
  }

  /* ------------------------------------------------------------------------
     6. Enquiry forms
     ------------------------------------------------------------------------ */
  var PHONE_RE = /^(?:\+?91[\s-]?|0)?[6-9]\d{9}$/;           // Indian mobile: optional +91 / 0, then 10 digits starting 6-9
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function normalisePhone(v) {
    return v.replace(/[\s\-().]/g, '');
  }

  var VALIDATORS = {
    name: function (v) {
      if (!v) { return 'Please enter your name.'; }
      if (v.length < 2) { return 'Please enter your full name.'; }
      return '';
    },
    company: function (v) {
      if (!v) { return 'Please enter your company or brand name.'; }
      return '';
    },
    phone: function (v) {
      if (!v) { return 'Please enter your mobile number.'; }
      if (!PHONE_RE.test(normalisePhone(v))) { return 'Please enter a valid 10-digit Indian mobile number.'; }
      return '';
    },
    email: function (v) {
      if (v && !EMAIL_RE.test(v)) { return 'Please enter a valid email address, or leave this blank.'; }
      return '';
    },
    interest: function (v) {
      if (!v) { return 'Please choose a product interest.'; }
      return '';
    },
    message: function (v) {
      if (v.length > 2000) { return 'Please keep your message under 2000 characters.'; }
      return '';
    }
  };

  function fieldError(form, field, message) {
    var errEl = form.querySelector('#' + field.id + '-error');
    if (errEl) { errEl.textContent = message; }
    if (message) {
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', field.id + '-error');
    } else {
      field.removeAttribute('aria-invalid');
      field.removeAttribute('aria-describedby');
    }
  }

  function validateField(form, field) {
    var fn = VALIDATORS[field.name];
    if (!fn) { return true; }
    var msg = fn(field.value.trim());
    fieldError(form, field, msg);
    return !msg;
  }

  function validateForm(form) {
    var firstBad = null;
    Array.prototype.forEach.call(form.querySelectorAll('.lp-input'), function (field) {
      if (!validateField(form, field) && !firstBad) { firstBad = field; }
    });
    if (firstBad) { firstBad.focus(); }
    return !firstBad;
  }

  function setBusy(form, busy) {
    var btn = form.querySelector('.lp-form__submit');
    form.classList.toggle('is-busy', busy);
    if (btn) {
      btn.disabled = busy;
      btn.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
  }

  function showFormError(form, message) {
    var box = form.querySelector('.lp-form__error');
    if (!box) { return; }
    box.textContent = message;
    box.hidden = false;
  }

  function clearFormError(form) {
    var box = form.querySelector('.lp-form__error');
    if (box) { box.hidden = true; box.textContent = ''; }
  }

  /**
   * Store the single-use lead token, then go to the thank-you page. The
   * thank-you page reads the token once, deletes it, and fires the conversion.
   * Nothing is pushed to the dataLayer here.
   */
  function redirectToThankYou(location, userData) {
    var token = { page_id: PAGE_ID, form_location: location, user_data: userData, issued: Date.now() };
    try {
      window.sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token));
    } catch (e) {
      // Storage blocked (private mode / disabled). The lead is saved server-side;
      // the visitor still sees the thank-you page, only the conversion is lost.
    }
    window.location.assign(THANK_YOU_URL);
  }

  function submitForm(form) {
    clearFormError(form);
    if (!validateForm(form)) { return; }

    var location = form.getAttribute('data-form-location') || 'unknown';
    var elapsedField = form.querySelector('input[name="elapsed"]');
    if (elapsedField) { elapsedField.value = String(Date.now() - PAGE_LOADED_AT); }

    var body = new FormData(form);
    var phoneDigits = normalisePhone(body.get('phone') || '');
    body.set('phone', phoneDigits);

    // Enhanced Conversions match data (E.164 phone, lower-cased email),
    // carried to the thank-you page inside the single-use token.
    var userData = { phone_number: '+91' + phoneDigits.slice(-10) };
    var emailValue = String(body.get('email') || '').trim().toLowerCase();
    if (emailValue) { userData.email = emailValue; }

    // PREVIEW COPY: submission is disabled. Validation above still runs so the
    // field behaviour can be reviewed; a passing submit shows a notice instead.
    var notice = form.querySelector('.lp-form__notice');
    if (notice) {
      notice.textContent = 'Form preview only — enquiries are handled on the live site.';
      notice.hidden = false;
    }
  }

  Array.prototype.forEach.call(document.querySelectorAll('.lp-form'), function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.classList.contains('is-busy')) { return; }
      submitForm(form);
    });
    // Validate on blur, and clear an error as soon as the user fixes it.
    Array.prototype.forEach.call(form.querySelectorAll('.lp-input'), function (field) {
      field.addEventListener('blur', function () { if (field.value.trim() || field.required) { validateField(form, field); } });
      field.addEventListener('input', function () { if (field.getAttribute('aria-invalid') === 'true') { validateField(form, field); } });
      if (field.tagName === 'SELECT') {
        var syncPlaceholder = function () { field.classList.toggle('is-placeholder', !field.value); };
        field.addEventListener('change', syncPlaceholder);
        syncPlaceholder();
      }
    });
  });

  /* ------------------------------------------------------------------------
     7. Fixed bottom stack
     ------------------------------------------------------------------------ */
  var fixedBottom = document.getElementById('lp-fixed-bottom');
  var cookieBanner = document.getElementById('lp-cookie');

  // Keep body padding equal to the stack's height so nothing is covered.
  function syncBottomOffset() {
    var h = fixedBottom ? fixedBottom.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--lp-bottom-offset', Math.ceil(h) + 'px');
  }

  // Hide the action bar while a form field has focus (mobile keyboard open).
  var blurTimer = null;
  document.addEventListener('focusin', function (e) {
    if (e.target.closest && e.target.closest('.lp-form')) {
      if (blurTimer) { window.clearTimeout(blurTimer); blurTimer = null; }
      document.body.classList.add('lp-keyboard-open');
      syncBottomOffset();
    }
  });
  document.addEventListener('focusout', function (e) {
    if (e.target.closest && e.target.closest('.lp-form')) {
      // Small delay so tabbing between fields does not flash the bar.
      blurTimer = window.setTimeout(function () {
        if (!document.activeElement || !document.activeElement.closest('.lp-form')) {
          document.body.classList.remove('lp-keyboard-open');
          syncBottomOffset();
        }
      }, 150);
    }
  });

  // Cookie banner: show unless a choice is stored; remember the choice.
  function readConsent() {
    try { return window.localStorage.getItem(COOKIE_KEY); } catch (e) { return null; }
  }
  function writeConsent(v) {
    try { window.localStorage.setItem(COOKIE_KEY, v); } catch (e) { /* private mode etc. */ }
  }

  if (cookieBanner) {
    if (!readConsent()) { cookieBanner.hidden = false; }
    Array.prototype.forEach.call(cookieBanner.querySelectorAll('[data-cookie]'), function (btn) {
      btn.addEventListener('click', function () {
        var choice = btn.getAttribute('data-cookie');
        writeConsent(choice);
        track('cookie_consent', { consent_choice: choice });
        cookieBanner.hidden = true;
        syncBottomOffset();
      });
    });
  }

  syncBottomOffset();
  window.addEventListener('resize', syncBottomOffset);
  window.addEventListener('orientationchange', syncBottomOffset);
  if ('ResizeObserver' in window && fixedBottom) {
    new ResizeObserver(syncBottomOffset).observe(fixedBottom);
  }

  /* ------------------------------------------------------------------------
     8. Thank-you page: fire the conversion once from the single-use token
        - token absent (refresh, bookmark, direct visit): push nothing
        - token read → deleted immediately → pushed once
     ------------------------------------------------------------------------ */
  if (IS_THANK_YOU) {
    var raw = null;
    try {
      raw = window.sessionStorage.getItem(TOKEN_KEY);
      window.sessionStorage.removeItem(TOKEN_KEY);   // delete before use: a refresh cannot fire twice
    } catch (e) {
      raw = null;
    }
    if (raw) {
      var lead = null;
      try { lead = JSON.parse(raw); } catch (e) { lead = null; }
      if (lead && (lead.form_location === 'hero' || lead.form_location === 'footer')) {
        var params = {
          page_id: (typeof lead.page_id === 'string' && lead.page_id) ? lead.page_id : 'unknown',
          form_location: lead.form_location
        };
        if (lead.user_data && typeof lead.user_data === 'object') { params.user_data = lead.user_data; }
        track('enquiry_form_submit', params);
      }
    }
  }
})();
