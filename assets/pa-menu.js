// Left slide-out menu for every Paddle App page.
// Adds a hamburger button to the page header (or a floating one if the page
// has no header), and a drawer that slides in from the left.
(function () {
  'use strict';
  if (window.__paMenu) return;
  window.__paMenu = true;

  // Pages inside the app, then the Google Site menu.
  var APP = [
    ['Trip Sheets', 'block-tracker.html?view=all'],
    ['Relief Runs', 'holdowner-fall-2026.html'],
    ['Detours',    'detours.html'],
    ['About',      'about.html']
  ];
  var SITE = [];
  // Other season / viewer pages count as their parent menu item.
  var ALIAS = {
    'fall-2026.html': 'index.html', 'spring2026.html': 'index.html', 'summer2026.html': 'index.html',
    'holdowner.html': 'holdowner-fall-2026.html', 'holdowner_summer.html': 'holdowner-fall-2026.html',
    'vac.html': 'holdowner-fall-2026.html', 'swap.html': 'home.html?view=swap'
  };

  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var here = ALIAS[page] || page;
  if (page === 'home.html' && /view=swap/.test(location.search)) here = 'home.html?view=swap';
  if (page === 'block-tracker.html' && /view=all/.test(location.search)) here = 'block-tracker.html?view=all';

  // pa-account-ui.js sets <html data-pa-acct="in|out"> once it knows; before
  // that, go by the "was signed in last visit" flag.
  function acctLabel() {
    var s = document.documentElement.dataset.paAcct;
    if (!s) { try { s = localStorage.getItem('pa_signed_in') === '1' ? 'in' : 'out'; } catch (_) { s = 'out'; } }
    return s === 'in' ? 'Account' : 'Sign in';
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

  function build() {
    var html = '<div class="pam-scrim" data-pam="close"></div>' +
      '<aside class="pam-drawer" id="pam-drawer" aria-label="Main menu" aria-hidden="true">' +
      '<div class="pam-top"><span class="pam-title">Paddle App</span>' +
      '<button class="pam-x" type="button" aria-label="Close menu" data-pam="close">&times;</button></div>' +
      '';
    APP.forEach(function (it) {
      html += '<a href="' + esc(it[1]) + '"' + (it[1] === here ? ' class="on" aria-current="page"' : '') + '>' + esc(it[0]) + '</a>';
    });
    SITE.forEach(function (it) {
      html += '<a href="' + esc(it[1]) + '" target="_blank" rel="noopener">' + esc(it[0]) + '<span class="ext" aria-hidden="true">&#8599;</span></a>';
    });
    // Account / Sign in sits at the bottom, apart from the pages above.
    html += '<div class="pam-acct"><button type="button" class="pam-acct-btn" data-pam="acct">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>' +
      '<span class="pam-acct-label">' + acctLabel() + '</span></button></div>';
    html += '<div class="pam-foot">Not affiliated with SEPTA.</div></aside>';
    var wrap = document.createElement('div');
    wrap.id = 'pam-root';
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
    return wrap;
  }

  function init() {
    var root = build();
    var drawer = root.querySelector('.pam-drawer');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pam-btn';
    btn.setAttribute('aria-label', 'Open menu');
    btn.setAttribute('aria-controls', 'pam-drawer');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';

    // Top bar: menu button + title on the left, Paddles / Live / sign-in on the right.
    var bar = document.createElement('div');
    bar.className = 'pam-bar';
    var title = document.createElement('span');
    title.className = 'pam-bar-title';
    title.textContent = 'Paddle App';
    var acts = document.createElement('div');
    acts.className = 'pam-bar-acts';
    [['Paddles', 'index.html'], ['Live', 'block-tracker.html']].forEach(function (it) {
      var a = document.createElement('a');
      a.className = 'pam-link' + (it[1] === here ? ' on' : '');
      a.href = it[1];
      a.textContent = it[0];
      acts.appendChild(a);
    });
    var slot = document.getElementById('pa-slot');
    if (!slot) { slot = document.createElement('div'); slot.id = 'pa-slot'; }
    acts.appendChild(slot);
    var icon = document.createElement('img');
    icon.className = 'pam-bar-icon';
    icon.src = 'assets/icon-192.png';
    icon.alt = '';
    icon.width = 30; icon.height = 30;
    bar.appendChild(btn);
    bar.appendChild(icon);
    bar.appendChild(title);
    bar.appendChild(acts);
    document.body.insertBefore(bar, document.body.firstChild);

    function set(open) {
      document.documentElement.classList.toggle('pam-open', open);
      document.body.classList.toggle('pam-lock', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (open) { var a = drawer.querySelector('a.on') || drawer.querySelector('a'); if (a) a.focus({ preventScroll: true }); }
      else btn.focus({ preventScroll: true });
    }
    btn.addEventListener('click', function () { set(true); });
    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-pam="close"]')) set(false);
      if (e.target.closest('[data-pam="acct"]')) {
        set(false);
        window.dispatchEvent(new CustomEvent('pa:open-account'));
      }
    });
    var acctLbl = root.querySelector('.pam-acct-label');
    window.addEventListener('pa:acct', function () { acctLbl.textContent = acctLabel(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.documentElement.classList.contains('pam-open')) set(false);
    });
    // Swipe left on the open drawer closes it.
    var sx = null;
    drawer.addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; }, { passive: true });
    drawer.addEventListener('touchend', function (e) {
      if (sx !== null && sx - e.changedTouches[0].clientX > 60) set(false);
      sx = null;
    }, { passive: true });
    // Same-page link (e.g. My run -> Swap tab): let the page handle it, close the menu.
    drawer.addEventListener('click', function (e) {
      var a = e.target.closest('a');
      if (a && a.classList.contains('on')) set(false);
    });
  }

  // CSS for the open state keys off <html class="pam-open">.
  var st = document.createElement('style');
  st.textContent = '.pam-open .pam-scrim{opacity:1;pointer-events:auto}.pam-open .pam-drawer{transform:none;visibility:visible}';
  document.head.appendChild(st);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
