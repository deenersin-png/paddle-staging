// ==========================================================================
// Holidays and alternate schedules (global PaHoliday). Needs pa-tags.js.
//
// SEPTA's GTFS says what runs on each date (septa-gtfs build.js):
//   calendar-days.json      { "2026-11-27": { day: "weekday", services: [...],
//                             special: true, alt: true, altRoutes: [...] } }
//   calendar-overrides.json { "2026-11-26": "sunday" } (older, Sunday/Saturday
//                             holidays only - the fallback while the first
//                             file is not there)
// Two kinds of special day:
//   - a holiday on the Sunday (or Saturday) schedule: Thanksgiving, Christmas,
//     New Year's Day. Those paddles exist - the day just uses another day's.
//   - an ALTERNATE schedule: day after Thanksgiving, Christmas Eve, the week
//     after Christmas, MLK Day, Presidents' Day (a "holiday week" weekday),
//     some Saturdays on the suburban routes. SEPTA publishes the timetable
//     (Live uses it), but there is NO paddle CSV for it: run info from the
//     regular paddles may not match, so the pages say so.
//
//   PaHoliday.load()                     both files (cached)
//   PaHoliday.todayIso()                 today, or ?today=YYYY-MM-DD (preview)
//   PaHoliday.info(iso, routes, data)    { day, plain, changed, alt, altRoutes, name, ... }
//   PaHoliday.noticeHtml(info, opts)     the banner
//   PaHoliday.upcoming(data, routes, n)  the next special days within n days
// ==========================================================================
(function () {
  'use strict';
  const GTFS = 'https://deenersin-png.github.io/septa-gtfs/data';
  const T = () => window.PaTags || { esc: s => String(s), labelRoutes: l => [String(l)], shortRoute: r => String(r) };

  const pad = n => String(n).padStart(2, '0');
  const isoOf = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const dateOf = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (iso, n) => { const d = dateOf(iso); d.setDate(d.getDate() + n); return isoOf(d); };

  /** Today's date - or the ?today=2026-11-27 of the page's address, to see
   *  how a holiday will look (staging test). */
  function todayIso() {
    try {
      const q = new URLSearchParams(location.search).get('today');
      if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) return q;
    } catch (_) {}
    return isoOf(new Date());
  }

  async function fetchJson(url) {
    try { const r = await fetch(url, { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch (_) { return null; }
  }
  let loading = null;
  function load() {
    if (!loading) loading = Promise.all([fetchJson(GTFS + '/calendar-days.json'), fetchJson(GTFS + '/calendar-overrides.json')])
      .then(([days, ov]) => ({ days: days || {}, ov: ov || {} }));
    return loading;
  }

  // ---- names ----------------------------------------------------------------
  // The nth weekday `dow` (0 = Sunday) of a month; n = -1 for the last one.
  function nthDow(y, m, dow, n) {
    if (n > 0) { const d = new Date(y, m, 1); d.setDate(1 + (dow - d.getDay() + 7) % 7 + (n - 1) * 7); return isoOf(d); }
    const d = new Date(y, m + 1, 0); d.setDate(d.getDate() - (d.getDay() - dow + 7) % 7); return isoOf(d);
  }
  /** The holiday's name, or '' (a name for the banner only - what runs comes
   *  from SEPTA's calendar, never from this list). */
  function holidayName(iso) {
    const y = +iso.slice(0, 4), md = iso.slice(5);
    const fixed = { '01-01': "New Year's Day", '06-19': 'Juneteenth', '07-04': 'Independence Day',
                    '12-24': 'Christmas Eve', '12-25': 'Christmas Day', '12-31': "New Year's Eve" };
    if (fixed[md]) return fixed[md];
    const tg = nthDow(y, 10, 4, 4);
    const named = {
      [nthDow(y, 0, 1, 3)]: 'Martin Luther King Jr. Day', [nthDow(y, 1, 1, 3)]: "Presidents' Day",
      [nthDow(y, 4, 1, -1)]: 'Memorial Day', [nthDow(y, 8, 1, 1)]: 'Labor Day',
      [tg]: 'Thanksgiving Day', [addDays(tg, 1)]: 'Day after Thanksgiving',
    };
    if (named[iso]) return named[iso];
    // A fixed holiday on a weekend is kept the Friday before / Monday after.
    for (const f of ['01-01', '07-04', '12-25']) {
      for (const yy of [y, y + 1]) {
        const h = yy + '-' + f, dow = dateOf(h).getDay();
        if ((dow === 6 && addDays(h, -1) === iso) || (dow === 0 && addDays(h, 1) === iso)) return fixed[f] + ' (observed)';
      }
    }
    if (md >= '12-26' && md <= '12-30') return 'Holiday week';
    return '';
  }

  // ---- what runs --------------------------------------------------------------
  const plainDay = iso => { const d = dateOf(iso).getDay(); return d === 0 ? 'sunday' : d === 6 ? 'saturday' : 'weekday'; };
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  // GTFS "D1 Bus" / "L1 OWL" and the pick's "D1" / "L1 OWL" / "21-42" the same way.
  const normRoute = r => T().shortRoute(String(r || '').trim().replace(/\s+bus$/i, '')).toUpperCase();
  const routeSet = routes => {
    const s = new Set();
    (routes || []).forEach(l => T().labelRoutes(l).forEach(r => s.add(normRoute(r))));
    return s;
  };

  /**
   * What runs on `iso`. `routes` (optional): the depot's routes (pick labels,
   * "21-42" fine) - an alternate schedule then counts only when it covers one
   * of them, and altRoutes lists those.
   */
  function info(iso, routes, data) {
    const e = (data && data.days && data.days[iso]) || null;
    const plain = plainDay(iso);
    const day = (e && e.day) || (data && data.ov && data.ov[iso]) || plain;
    let alt = [];
    if (e && e.alt && Array.isArray(e.altRoutes)) {
      const all = [...new Set(e.altRoutes.map(normRoute))];
      if (routes) { const mine = routeSet(routes); alt = all.filter(r => mine.has(r)); }
      else alt = all;
    }
    const sorted = alt.sort((a, b) => (parseInt(a, 10) || 1e9) - (parseInt(b, 10) || 1e9) || a.localeCompare(b));
    return {
      iso, plain, day, dayLabel: cap(day),
      changed: day !== plain,              // e.g. a Thursday on the Sunday schedule
      alt: sorted.length > 0,              // an alternate timetable with no paddles
      altRoutes: sorted,
      allRoutes: !!routes && sorted.length > 0 && sorted.length >= routeSet(routes).size,
      known: !!e,                           // calendar-days.json covers this date
      name: holidayName(iso),
    };
  }
  const isSpecial = i => i.changed || i.alt;

  /** The next special days after `fromIso` (default today), within `n` days. */
  function upcoming(data, routes, n, fromIso) {
    const from = fromIso || todayIso(), out = [];
    for (let k = 1; k <= (n || 14); k++) {
      const i = info(addDays(from, k), routes, data);
      if (isSpecial(i)) out.push(i);
    }
    return out;
  }

  // ---- banner -------------------------------------------------------------------
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const fmt = iso => { const d = dateOf(iso); return DOW[d.getDay()] + ' ' + MON[d.getMonth()] + ' ' + d.getDate(); };
  function routesText(i) {
    if (i.allRoutes) return "all of this depot's routes";
    const r = i.altRoutes, shown = r.slice(0, 8).join(', ');
    return (r.length === 1 ? 'Route ' : 'Routes ') + shown + (r.length > 8 ? ' and ' + (r.length - 8) + ' more' : '');
  }

  /**
   * The banner for a special day, '' for a plain one.
   * opts.today   it is today (default) - else "on <date>"
   * opts.page    'paddles' (buttons: show that day's runs / open Live) or 'live'
   * opts.curDay  the day the page shows ('Weekday'...), so a button to the
   *              right one only shows when it is not on it
   * opts.liveHref  where "Open Live" goes
   * opts.next    upcoming(...) - one line each under the banner
   */
  function noticeHtml(i, opts) {
    const o = opts || {}, esc = T().esc;
    const when = o.today === false ? 'on ' + fmt(i.iso) : 'today';
    const next = (o.next || []).filter(isSpecial).slice(0, 3);
    if (!isSpecial(i)) {
      if (!next.length) return '';
      return '<div class="pa-hol pa-hol-soon" role="status">' + nextLines(next) + '</div>';
    }
    const title = esc((i.name ? i.name.toUpperCase() + ' · ' : '') + fmt(i.iso));
    let body = '', btn = '';
    if (i.changed) {
      body += 'SEPTA runs the <b>' + esc(i.day.toUpperCase()) + ' schedule</b> ' + when + '.';
      if (!i.alt) body += ' ' + (o.today === false ? 'Its' : "Today's") + ' runs are the ' + esc(i.dayLabel) + ' paddles.';
    }
    if (i.alt) {
      body += (i.changed ? ' On ' + esc(routesText(i)) + ' it is an <b>alternate timetable</b>.'
        : 'SEPTA runs an <b>alternate ' + esc(i.dayLabel) + ' schedule</b> ' + when + ' on ' + esc(routesText(i)) + '.');
      body += ' <b>Its paddles are not available</b>, so the info here is limited: run times, reports and pull-outs are from the regular '
        + esc(i.dayLabel) + ' paddles and may not match.';
      body += o.page === 'live'
        ? ' The trips and buses here are SEPTA\'s ' + (o.today === false ? '' : 'live ') + 'data for ' + (o.today === false ? 'that day' : 'today') + '.'
        : ' Live and Trip Sheets show ' + (o.today === false ? 'that day' : "today") + '\'s real trips from SEPTA\'s live data.';
    }
    if (o.page === 'paddles') {
      if (o.curDay && o.curDay !== i.dayLabel) btn += '<button type="button" class="pa-hol-btn" data-pa-hol-day="' + esc(i.dayLabel) + '">Show ' + esc(i.dayLabel) + ' runs</button>';
      if (i.alt && o.today !== false) btn += '<a class="pa-hol-btn" href="' + esc(o.liveHref || 'block-tracker.html') + '">Open Live</a>';
    }
    return '<div class="pa-hol ' + (i.alt ? 'pa-hol-alt' : 'pa-hol-sun') + '" role="status">'
      + '<span class="pa-hol-ico" aria-hidden="true">' + (i.alt ? '&#9888;' : '&#128197;') + '</span>'
      + '<div class="pa-hol-txt"><b class="pa-hol-title">' + title + '</b><span>' + body + '</span>'
      + (next.length ? '<span class="pa-hol-next">' + nextLines(next) + '</span>' : '') + '</div>'
      + (btn ? '<div class="pa-hol-btns">' + btn + '</div>' : '') + '</div>';
  }
  function nextLines(list) {
    const esc = T().esc;
    return list.map(i => '<span class="pa-hol-line"><b>Coming up:</b> ' + esc(fmt(i.iso)) + (i.name ? ' · ' + esc(i.name) : '') + ' · '
      + (i.alt ? (i.changed ? esc(i.dayLabel) + ' schedule, alternate on some routes' : 'alternate ' + esc(i.dayLabel) + ' schedule') + ' <i>(no paddles)</i>'
               : esc(i.dayLabel) + ' schedule') + '</span>').join('');
  }

  // ---- styles (once) ---------------------------------------------------------------
  const css = `
.pa-hol { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 6px 12px; padding: 10px 16px;
  font-size: 14px; line-height: 1.35; border-bottom: 3px solid; }
.pa-hol-sun { background: #e8f1ff; color: #06295a; border-color: #06295a; }
.pa-hol-alt { background: #fff1d6; color: #3a2400; border-color: #c8102e; }
.pa-hol-soon { background: #f3f6fb; color: #06295a; border-color: #c9d6ea; border-bottom-width: 1px; padding: 6px 16px; font-size: 13px; }
.pa-hol-ico { font-size: 20px; line-height: 1.1; }
.pa-hol-txt { flex: 1 1 240px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pa-hol-title { letter-spacing: .02em; }
.pa-hol-next { margin-top: 4px; font-size: 13px; opacity: .9; }
.pa-hol-line { display: block; }
.pa-hol-btns { display: flex; gap: 8px; flex-wrap: wrap; align-self: center; }
.pa-hol-btn { flex: 0 0 auto; padding: 7px 12px; border-radius: 6px; border: 0; background: #06295a; color: #fff;
  font: inherit; font-weight: 700; font-size: 13px; text-decoration: none; cursor: pointer; }
.pa-hol-alt .pa-hol-btn { background: #c8102e; }
@media (max-width: 480px) { .pa-hol { padding: 8px 12px; font-size: 13px; } }`;
  if (!document.getElementById('pa-hol-css')) {
    const s = document.createElement('style'); s.id = 'pa-hol-css'; s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  window.PaHoliday = { load, todayIso, info, upcoming, noticeHtml, holidayName, isoOf, addDays };
})();
