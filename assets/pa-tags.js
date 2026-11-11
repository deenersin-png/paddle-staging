// ==========================================================================
// Paddle App design system: the tags every page shares. Styles: pa-tags.css.
// A classic script (global PaTags) so the classic pages (Paddles, Live,
// Trip Sheets, Pull Outs) and the modules (pa-run-card, pa-live-cards) can
// all use the same markup.
//
//   PaTags.dayTags(days, cur, today, attr)  Sunday / Weekday / Saturday row
//   PaTags.blockTag(route, block, opts)     "21/1050" (opts.label + times: the
//                                           route is looked up for a two-route block)
//   PaTags.busTag(vid)                      bus icon + number
//   PaTags.runTag(runno, day, link, opts)   "RUN#: 308 WEEKDAY"
//   PaTags.typeBar(types, sel)              Run / Block / Bus search buttons
//   PaTags.pickType(types, sel)             which type is selected
//   PaTags.routeList(routes, cur, live)     "65 | 21 | 46", current one marked
//   PaTags.resolveBlockTags(root)           fill in two-route blocks' route
// ==========================================================================
(function () {
  'use strict';
  const SELF = (document.currentScript && document.currentScript.src) || new URL('assets/pa-tags.js', location.href).href;
  const ICON = new URL('icon-192.png', SELF).href;
  const SCHEDULE = new URL('pa-schedule.js', SELF).href;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- days ---------------------------------------------------------------
  const STD_DAYS = ['Sunday', 'Weekday', 'Saturday'];
  /** 'sunday' | 'weekday' | 'saturday' for a day name (an alternate schedule
   *  "Saturday Special" counts as Saturday). */
  function dayKey(label) {
    const l = String(label || '').toLowerCase();
    return l.includes('sat') ? 'saturday' : l.includes('sun') ? 'sunday' : 'weekday';
  }
  const dayName = label => { const k = dayKey(label); return k.charAt(0).toUpperCase() + k.slice(1); };
  /** Today's day name from the calendar day (midnight to midnight) and the
   *  GTFS holiday overrides when the page has them ({ iso: 'sunday' }). */
  function todayLabel(overrides) {
    const d = new Date();
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const ov = overrides && overrides[iso];
    if (ov) return dayName(ov);
    return d.getDay() === 0 ? 'Sunday' : d.getDay() === 6 ? 'Saturday' : 'Weekday';
  }
  let ovPromise = null;
  /** As todayLabel, after loading the holiday overrides (cached). */
  async function todayLabelAsync() {
    if (!ovPromise) ovPromise = import(SCHEDULE).then(m => m.loadCalendarOverrides()).catch(() => ({}));
    return todayLabel(await ovPromise);
  }
  /** Days in the app's order: Sunday, Weekday, Saturday, then any alternates. */
  function sortDays(days) {
    const rank = d => { const i = STD_DAYS.indexOf(d); return i < 0 ? 10 : i; };
    return days.slice().sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)));
  }
  /** The day row's buttons. `attr` is the data attribute each carries its day
   *  in (the page listens for clicks on it). */
  function dayTags(days, cur, today, attr) {
    const a = attr || 'data-pa-day';
    return sortDays(days).map(d =>
      '<button type="button" class="pa-day pa-day-' + dayKey(d) + (STD_DAYS.includes(d) ? '' : ' alt') + (d === cur ? ' on' : '') +
      '" ' + a + '="' + esc(d) + '" aria-pressed="' + (d === cur) + '">' + esc(d) +
      (d === today ? '<span class="pa-today">Today</span>' : '') + '</button>').join('');
  }

  // ---- routes -------------------------------------------------------------
  // The pick and GTFS name the owl lines "L1 OWL" / "B1 OWL"; the app's
  // 3-character names for them.
  const SHORT = { 'L1 OWL': 'MFO', 'B1 OWL': 'BSO' };
  const shortRoute = r => { r = String(r == null ? '' : r).trim(); return SHORT[r.toUpperCase()] || r; };
  /** A pick route label's routes: "21-42" → ["21","42"], "L1 OWL" → ["MFO"]. */
  function labelRoutes(label) {
    const l = String(label || '').trim();
    if (!l) return [];
    if (SHORT[l.toUpperCase()]) return [SHORT[l.toUpperCase()]];
    return l.split(/[-\/]/).map(s => s.trim()).filter(Boolean);
  }

  // ---- tags ---------------------------------------------------------------
  /**
   * The block tag "21/1050". A block runs one route at a time; pass that
   * route. Where only the pick's label is known ("21-42"), pass it as
   * opts.label with the moment that counts (opts.at, minutes on the run's
   * clock; opts.s / opts.e the piece) and opts.day ('weekday' …):
   * resolveBlockTags() then puts in the route of the trip the block is on
   * at that moment (or, between trips, the next one).
   */
  function blockTag(route, block, opts) {
    const o = opts || {};
    const routes = o.label ? labelRoutes(o.label) : [];
    const r = shortRoute(route || routes[0] || '');
    let data = '';
    if (routes.length > 1 && o.day) {
      data = ' data-rl="' + esc(o.label) + '" data-blk="' + esc(block) + '" data-day="' + esc(dayKey(o.day)) + '"' +
        (o.at != null ? ' data-at="' + Math.round(o.at) + '"' : '') +
        (o.s != null ? ' data-s="' + Math.round(o.s) + '"' : '') + (o.e != null ? ' data-e="' + Math.round(o.e) + '"' : '');
    }
    return '<span class="pa-blk' + (o.cls ? ' ' + o.cls : '') + '"' + data + ' title="Route ' + esc(r) + ' · Block ' + esc(block) + '">' +
      '<span class="pa-blk-r">' + esc(r) + '</span><span class="pa-blk-s">/</span><span class="pa-blk-n">' + esc(block) + '</span></span>';
  }
  function busTag(vid, opts) {
    const o = opts || {};
    return '<span class="pa-bus' + (o.cls ? ' ' + o.cls : '') + '"' + (o.attrs || '') + '><img class="bus-ico" src="' + ICON + '" alt="" width="14" height="14"> ' + esc(vid) + '</span>';
  }
  /** Trip Sheets' run button: "RUN#: 308 WEEKDAY", opening the paddle when
   *  there is a link. opts.noDay: number only; opts.big: search results. */
  function runTag(runno, day, link, opts) {
    const o = opts || {};
    const cls = 'pa-run day-' + (day && !STD_DAYS.includes(day) && !/^(sunday|weekday|saturday)$/i.test(day) ? 'alt' : dayName(day || 'Weekday')) +
      (o.big ? ' big' : '') + (o.cls ? ' ' + o.cls : '');
    const inner = '<span class="pa-run-n">' + esc(runno) + '</span>' + (o.noDay ? '' : '<span class="pa-run-d">' + esc(day || 'Weekday') + '</span>');
    return link ? '<a class="' + cls + '" href="' + esc(link) + '" target="_blank" rel="noopener">' + inner + '</a>'
                : '<span class="' + cls + ' nolink">' + inner + '</span>';
  }

  // ---- search type buttons ------------------------------------------------
  const TYPE_NAME = { run: 'Run', block: 'Block', bus: 'Bus' };
  /** Selected type: the user's choice while it still matches; else Bus when
   *  bus and block both match, else the first type that matches. */
  function pickType(types, sel) {
    const has = t => types.some(x => x.type === t && x.match);
    if (sel && has(sel)) return sel;
    if (has('bus')) return 'bus';
    const first = types.find(x => x.match);
    return first ? first.type : '';
  }
  /** types: [{ type: 'run'|'block'|'bus', match: bool, n?: count }] in the
   *  page's order. No match = gray and not tappable. */
  function typeBar(types, sel) {
    return types.map(x => {
      const on = x.type === sel;
      return '<button type="button" class="pa-type pa-type-' + x.type + (on ? ' on' : '') + (x.match ? '' : ' off') + '" data-pa-type="' + x.type + '"' +
        (x.match ? '' : ' disabled') + ' aria-pressed="' + on + '">' + TYPE_NAME[x.type] +
        (x.match && x.n > 1 ? '<span class="pa-type-n">' + x.n + '</span>' : '') + '</button>';
    }).join('');
  }

  /** "65 | 21 | 46" with the current route marked: green when live, yellow
   *  when going by the schedule. `same(a, b)` compares route names. */
  function routeList(routes, cur, live, same) {
    const eq = same || ((a, b) => shortRoute(a) === shortRoute(b));
    let marked = false;
    return routes.map(r => {
      const hit = !marked && cur && eq(r, cur);
      if (hit) marked = true;
      return hit ? '<span class="pa-rt-cur ' + (live ? 'live' : 'sched') + '">' + esc(r) + '</span>' : esc(r);
    }).join(' | ');
  }

  // ---- two-route blocks ---------------------------------------------------
  /** The route a two-route block runs at minute `at` of its piece: the trip
   *  under way then, else (between trips) the next one, else the last. */
  async function routeAt(label, block, day, at, s, e) {
    const S = await import(SCHEDULE);
    const piece = { block: String(block), routeLabel: label, startMin: s != null ? s : null, endMin: e != null ? e : null };
    const trips = await S.pieceTrips(piece, day);
    if (!trips.length) return null;
    const t = at != null ? at : s;
    const hit = t == null ? trips[0]
      : trips.find(x => x.s <= t && t <= x.e) || trips.find(x => x.s > t) || trips[trips.length - 1];
    // How often a block is between trips at that moment (the layover case).
    if (t != null && !trips.some(x => x.s <= t && t <= x.e)) resolveStats.between++;
    resolveStats.total++;
    return shortRoute(hit.route);
  }
  const resolveStats = { total: 0, between: 0 };
  const memo = new Map();
  /** Every unresolved two-route block tag under `root`: the route filled in. */
  async function resolveBlockTags(root) {
    const els = [...(root || document).querySelectorAll('.pa-blk[data-rl]')];
    await Promise.all(els.map(async el => {
      const d = el.dataset;
      const num = k => d[k] != null && d[k] !== '' ? Number(d[k]) : null;
      const key = [d.rl, d.blk, d.day, d.at, d.s, d.e].join('|');
      if (!memo.has(key)) memo.set(key, routeAt(d.rl, d.blk, d.day, num('at'), num('s'), num('e')).catch(() => null));
      const r = await memo.get(key);
      el.removeAttribute('data-rl');
      if (!r) return;
      const rEl = el.querySelector('.pa-blk-r');
      if (rEl && rEl.textContent !== r) rEl.textContent = r;
      el.title = 'Route ' + r + ' · Block ' + d.blk;
    }));
  }

  /** The route a piece's block runs at minute `at` (see routeAt), as a
   *  promise: one route label is just that route; "21-42" is looked up. */
  function resolveRoute(label, block, day, at, s, e) {
    const routes = labelRoutes(label);
    if (routes.length < 2) return Promise.resolve(shortRoute(routes[0] || ''));
    const key = [label, block, dayKey(day), at, s, e].join('|');
    if (!memo.has(key)) memo.set(key, routeAt(label, block, dayKey(day), at, s, e).catch(() => null));
    return memo.get(key).then(r => r || shortRoute(routes[0]));
  }

  window.PaTags = { esc, STD_DAYS, dayKey, dayName, todayLabel, todayLabelAsync, sortDays, dayTags,
    shortRoute, labelRoutes, blockTag, busTag, runTag, pickType, typeBar, routeList, resolveBlockTags, resolveRoute, resolveStats };
})();
