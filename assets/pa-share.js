// Share the Paddle App: Share button, QR code popup, install help.
//
// Loaded on every page by assets/pa-menu.js (the menu has Share app / Show
// QR code / Install app). Any element on a page with data-pa-share="share",
// "qr", "copy" or "install" works the same way (the About page uses this).
//
//  - Share: the phone's own share sheet (Web Share API) with the app name,
//    a short line and the link. No share sheet -> the link is copied and a
//    "Link copied" note shows.
//  - QR code: a popup with a big QR code of the link (drawn here by
//    assets/pa-qr.js, no outside service), Share / Copy link, and how to add
//    the app to the home screen on this kind of phone.
//  - Install app: only where the browser offers its install prompt (Chrome,
//    Edge, Samsung Internet), never once the app is installed.
(function () {
  'use strict';
  if (window.PaShare) return;

  var me = document.currentScript && document.currentScript.src;
  function asset(name) { return me ? me.replace(/pa-share\.js(\?.*)?$/, name) : 'assets/' + name; }

  // The link people get from Share, Copy link and the QR code: the short
  // link to the live site (it forwards to .../septa-scheduler/ with the
  // utm_source=app tags, so shared visits show up in the stats). The popup
  // does not show it, only if copying fails.
  var LINK = 'https://bit.ly/4jkDQr8';
  // The site folder this page is served from (for sw.js).
  var SITE = me ? new URL('../', me).href : new URL('./', document.baseURI).href;
  var TITLE = 'Paddle App';
  var TEXT = 'Free app for SEPTA bus operators: your run, paddles, live buses, detours.';

  if (!document.querySelector('link[href$="pa-share.css"]')) {
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = asset('pa-share.css');
    document.head.appendChild(css);
  }

  // Same worker every page registers (assets/pa-account-ui.js); registering
  // twice is a no-op. It is what makes the app installable.
  if ('serviceWorker' in navigator) {
    try { navigator.serviceWorker.register(new URL('sw.js', SITE).href).catch(function () {}); } catch (_) {}
  }

  // ---- install state ------------------------------------------------------
  // pa-menu.js catches the browser's install prompt as early as it can
  // (window.__paInstall); keep listening here too for pages without it.
  var prompt = window.__paInstall || null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    prompt = window.__paInstall = e;
    showInstall();
  });
  window.addEventListener('pa:installable', function () { prompt = window.__paInstall || prompt; showInstall(); });
  window.addEventListener('appinstalled', function () {
    prompt = window.__paInstall = null;
    try { localStorage.setItem('pa_installed', '1'); } catch (_) {}
    showInstall();
    toast('Paddle App is installed');
  });

  function installed() {
    try {
      if (navigator.standalone === true) return true;                     // iPhone home-screen app
      return ['standalone', 'fullscreen', 'minimal-ui'].some(function (m) {
        return window.matchMedia('(display-mode: ' + m + ')').matches;
      });
    } catch (_) { return false; }
  }
  function canInstall() { return !!prompt && !installed(); }

  // ---- which phone --------------------------------------------------------
  function platform() {
    var ua = navigator.userAgent || '';
    var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) return { os: 'ios', otherBrowser: /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua) };
    if (/Android/i.test(ua)) return { os: 'android', samsung: /SamsungBrowser/i.test(ua) };
    return { os: 'other' };
  }

  // ---- share / copy -------------------------------------------------------
  function share() {
    var data = { title: TITLE, text: TEXT, url: LINK };
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      return navigator.share(data).catch(function (err) {
        if (err && err.name === 'AbortError') return;                     // they closed the share sheet
        return copy();
      });
    }
    return copy();
  }

  function copy() {
    function done() { toast('Link copied'); }
    function old() {
      var ta = document.createElement('textarea');
      ta.value = LINK;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      if (ok) return done();
      // Nothing worked: show the link so it can be copied by hand.
      openQR();
      overlay.querySelector('.pas-url').hidden = false;
      toast('Press and hold the link to copy it');
    }
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(LINK).then(done, old);
    }
    old();
    return Promise.resolve();
  }

  function install() {
    if (!prompt) { openQR(); return Promise.resolve(); }
    var p = prompt;
    prompt = window.__paInstall = null;                                    // a prompt can be used once
    p.prompt();
    return (p.userChoice || Promise.resolve({})).then(function (c) {
      if (c && c.outcome === 'accepted') toast('Installing Paddle App…');
      showInstall();
    }, showInstall);
  }

  // ---- small "Link copied" note ------------------------------------------
  var toastEl = null, toastTimer = 0;
  function ensureToast() {
    if (toastEl) return toastEl;
    toastEl = document.createElement('div');
    toastEl.className = 'pas-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
    return toastEl;
  }
  function toast(msg) {
    var t = ensureToast();
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }

  // ---- QR popup -----------------------------------------------------------
  var SHARE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2"/></svg>';
  var COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>';
  var INSTALL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19h14"/></svg>';

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

  function steps(os) {
    if (os === 'ios') return '<ol class="pas-steps">' +
      '<li>Open the link in <b>Safari</b>.</li>' +
      '<li>Tap the <b>Share</b> button <span class="pas-ico">' + SHARE_ICON + '</span>.</li>' +
      '<li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>';
    return '<ol class="pas-steps">' +
      '<li>Open the link in <b>Chrome</b> or <b>Samsung Internet</b>.</li>' +
      '<li>Tap the menu (<b>&#8942;</b> in Chrome, <b>&#9776;</b> in Samsung Internet).</li>' +
      '<li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li></ol>';
  }
  function block(os, here) {
    return '<div class="pas-os' + (here ? ' here' : '') + '"><h4>' +
      (os === 'ios' ? 'iPhone' : 'Samsung &amp; other Android phones') +
      (here ? ' <span class="pas-here">this phone</span>' : '') + '</h4>' + steps(os) + '</div>';
  }

  function helpHTML() {
    var p = platform(), inst = installed(), h = '';
    if (inst) {
      h += '<p class="pas-ok" role="note">&#10003; Paddle App is installed on this phone.</p>';
      h += '<h3 class="pas-h">Add it on another phone</h3>' + block('ios') + block('android');
      return h;
    }
    h += '<h3 class="pas-h">Add it to your home screen</h3>';
    if (p.os === 'ios') {
      if (p.otherBrowser) h += '<p class="pas-warn">You are in another browser. Copy the link and open it in Safari first.</p>';
      h += block('ios', true) + '<details class="pas-more"><summary>Android phones</summary>' + block('android') + '</details>';
    } else if (p.os === 'android') {
      h += block('android', true) + '<details class="pas-more"><summary>iPhone</summary>' + block('ios') + '</details>';
    } else {
      h += '<p class="pas-note">On a computer? Scan the code with your phone’s camera, then:</p>' + block('ios') + block('android');
    }
    return h;
  }

  var overlay = null, lastFocus = null, opener = null;
  function buildQR() {
    overlay = document.createElement('div');
    overlay.className = 'pas-overlay';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="pas-card" role="dialog" aria-modal="true" aria-labelledby="pas-title" aria-describedby="pas-lead">' +
        '<div class="pas-head"><h2 class="pas-title" id="pas-title">Share Paddle App</h2>' +
        '<button type="button" class="pas-x" data-pas="close" aria-label="Close">&times;</button></div>' +
        '<div class="pas-body">' +
          '<p class="pas-lead" id="pas-lead">Point a phone camera at the code to open the app.</p>' +
          '<div class="pas-qr" data-pas="qr"></div>' +
          '<p class="pas-url" hidden><span class="pas-url-txt">' + esc(LINK) + '</span></p>' +
          '<div class="pas-row">' +
            (navigator.share ? '<button type="button" class="pas-btn" data-pa-share="share">' + SHARE_ICON + '<span>Share link</span></button>' : '') +
            '<button type="button" class="pas-btn' + (navigator.share ? ' pas-btn-2' : '') + '" data-pa-share="copy">' + COPY_ICON + '<span>Copy link</span></button>' +
          '</div>' +
          '<button type="button" class="pas-btn pas-install" data-pa-share="install" hidden>' + INSTALL_ICON + '<span>Install App</span></button>' +
          '<div class="pas-help" data-pas="help"></div>' +
          '<button type="button" class="pas-btn pas-btn-2 pas-done" data-pas="close">Close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.closest('[data-pas="close"]')) closeQR();
    });
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeQR(); return; }
      if (e.key !== 'Tab') return;
      var f = [].filter.call(overlay.querySelectorAll('button, a[href], summary, [tabindex]:not([tabindex="-1"])'),
        function (el) { return !el.hidden && el.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  var qrReady = null;
  function loadQR() {
    if (window.PaQR) return Promise.resolve();
    if (qrReady) return qrReady;
    qrReady = new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = asset('pa-qr.js');
      s.onload = ok;
      s.onerror = function () { qrReady = null; bad(); };
      document.head.appendChild(s);
    });
    return qrReady;
  }

  function openQR() {
    if (!overlay) buildQR();
    overlay.querySelector('[data-pas="help"]').innerHTML = helpHTML();
    var box = overlay.querySelector('[data-pas="qr"]');
    if (!box.firstChild) {
      box.innerHTML = '<span class="pas-qr-wait">Loading…</span>';
      loadQR().then(function () {
        box.innerHTML = window.PaQR.svg(LINK, { quiet: 4, label: 'QR code that opens Paddle App' });
      }, function () {
        box.innerHTML = '<span class="pas-qr-wait">QR code could not load. Use Share link or Copy link.</span>';
      });
    }
    showInstall();
    // Focus goes back here on close. Safari does not focus a tapped button,
    // so fall back to the button that opened the popup.
    if (overlay.hidden) {
      var a = document.activeElement;
      lastFocus = a && a !== document.body && !overlay.contains(a) ? a : opener;
    }
    overlay.hidden = false;
    document.body.classList.add('pas-lock');
    overlay.querySelector('.pas-x').focus({ preventScroll: true });
  }
  function closeQR() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.body.classList.remove('pas-lock');
    var f = lastFocus;
    lastFocus = opener = null;
    if (f && f.focus && document.contains(f) && f.offsetParent !== null) f.focus({ preventScroll: true });
    else if (overlay.contains(document.activeElement)) document.activeElement.blur();
  }

  // Every Install button on the page (menu, About, popup) shows only while
  // the browser's install prompt is on offer and the app is not installed.
  function showInstall() {
    var on = canInstall();
    [].forEach.call(document.querySelectorAll('[data-pa-share="install"]'), function (el) { el.hidden = !on; });
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-pa-share]');
    if (!el) return;
    e.preventDefault();
    var what = el.getAttribute('data-pa-share');
    if (!overlay || overlay.hidden) opener = el;
    if (what === 'share') share();
    else if (what === 'copy') copy();
    else if (what === 'qr') openQR();
    else if (what === 'install') install();
  });
  // The display mode changes when the page is opened as the installed app.
  try { window.matchMedia('(display-mode: standalone)').addEventListener('change', showInstall); } catch (_) {}

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { ensureToast(); showInstall(); });
  else { ensureToast(); showInstall(); }

  window.PaShare = { link: LINK, share: share, copy: copy, openQR: openQR, closeQR: closeQR, install: install, installed: installed, refresh: showInstall };
})();
