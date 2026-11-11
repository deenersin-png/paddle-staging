// One clear button for every search box in the app: a round red ✕ inside the
// right end of the box, shown whenever the box has something in it - after a
// search that found something or nothing alike. One tap empties the box and
// tells the page (an 'input' event), so each page goes back to its normal view
// the same way as when the number is deleted by hand. Esc does the same.
//
// Which boxes: every <input type="search"> and every input with data-pa-clear.
// The box must fill its parent's width (the ✕ sits at the parent's right).
// Loaded on every page by assets/pa-menu.js.
(function () {
  'use strict';
  if (window.__paClear) return;
  window.__paClear = true;

  var SEL = 'input[type="search"], input[data-pa-clear]';
  var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  var css = document.createElement('style');
  css.textContent =
    '.pa-clr{position:absolute;top:50%;right:7px;transform:translateY(-50%);z-index:2;' +
    'width:28px;height:28px;padding:0;margin:0;border:0;border-radius:50%;cursor:pointer;' +
    'background:#c8102e;color:#fff;display:none;align-items:center;justify-content:center;' +
    'box-shadow:0 1px 4px rgba(8,18,43,.3);-webkit-tap-highlight-color:transparent;touch-action:manipulation}' +
    '.pa-clr.on{display:inline-flex}' +
    '.pa-clr:active{transform:translateY(-50%) scale(.92);background:#9e0c24}' +
    // Pages style the magnifier icon in their boxes ("box svg {...}"); keep
    // that off the ✕.
    'button.pa-clr svg{position:static!important;transform:none!important;left:auto!important;top:auto!important;' +
    'width:14px!important;height:14px!important;color:#fff!important;stroke:#fff!important;display:block;pointer-events:none}' +
    // Bigger invisible tap area around the circle.
    '.pa-clr::after{content:"";position:absolute;inset:-8px}' +
    // The browser's own tiny search ✕ would be a second one.
    'input.pa-clr-in::-webkit-search-cancel-button{-webkit-appearance:none;display:none}';
  document.head.appendChild(css);

  function setup(input) {
    if (input.__paClr) return;
    var box = input.parentElement;
    if (!box) return;
    input.__paClr = true;
    input.classList.add('pa-clr-in');
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    // Room on the right so typed digits never run under the ✕.
    input.style.setProperty('padding-right', '42px', 'important');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pa-clr';
    btn.setAttribute('aria-label', 'Clear ' + (input.getAttribute('placeholder') || 'search'));
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    box.appendChild(btn);

    function show() { btn.classList.toggle('on', !!desc.get.call(input)); }
    // Pages also set the box in code (e.g. Live empties it when a route is
    // picked); watch those writes too, not just typing.
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: function () { return desc.get.call(input); },
      set: function (v) { desc.set.call(input, v); show(); }
    });

    function clear() {
      if (!desc.get.call(input)) return;
      desc.set.call(input, '');
      show();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('search', { bubbles: true }));
      input.blur(); // phones: close the keyboard so the page shows again
    }
    // pointerdown keeps the box from losing/gaining focus before the tap lands.
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', clear);
    input.addEventListener('input', show);
    input.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); clear(); } });
    show();
  }

  function scan(root) {
    if (root.matches && root.matches(SEL)) setup(root);
    if (root.querySelectorAll) root.querySelectorAll(SEL).forEach(setup);
  }

  function init() {
    scan(document);
    // Search boxes a page draws later get one too.
    new MutationObserver(function (list) {
      list.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) scan(n); }); });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
