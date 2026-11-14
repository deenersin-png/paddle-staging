// ==========================================================================
// Paddle App — the picks (seasons), from the owner's Google Sheet.
//
// No pick name or date is written into the app any more. Every pick comes
// from one published Google Sheet with three columns:
//
//     Picking       | Start Date | Finish Date
//     Fall 2026     | 8/23/2026  | 2/27/2027
//
// - The name is used exactly as the sheet writes it (not GTFS's names).
// - Start and end are the first and LAST day of the pick (both included).
//   An empty end means the pick runs until further notice.
// - The current pick is the one whose range holds today.
// - The picks before it are on Older Picks; each pick after it gets its
//   own menu link (assets/pa-menu.js).
//
// If the sheet does not answer, the last copy this device loaded is used.
// With no copy at all, a red bar says so at the top of the page.
//
// Loaded as a plain <script> (window.PaPicks) and also by
// assets/pa-schedule.js through import(), so it must stay a classic script
// that only sets a global.
// ==========================================================================
(function (root) {
  'use strict';
  if (root.PaPicks) return;

  // THE PICK SHEET. Publish the sheet (File -> Share -> Publish to web ->
  // the tab -> Comma-separated values) and paste that link here. A normal
  // sheet link (…/spreadsheets/d/<id>/edit#gid=…) works too, if the sheet is
  // shared "anyone with the link can view".
  // The owner's sheet, tab "Pikingdates": Picking | Start Date | Finish Date.
  var SHEET_URL = 'https://docs.google.com/spreadsheets/d/1C8fuIoS_YOIRdtxBQgQ2o-BbyE1x_wF6DKppZKHEIPQ/edit#gid=316407380';

  var CACHE_KEY = 'pa_picks_v1';
  var TIMEOUT_MS = 12000;

  // Where each pick's paddle files are. Only the file NAME lives here, never
  // the pick's name or dates: the three picks before the sheet were saved
  // under uneven names. A new pick needs no entry — "Winter 2027" is read
  // from data/manifest-winter-2027.json.
  var MANIFESTS = {
    fall2026:   'manifest-fall-2026.json',
    summer2026: 'manifest_summer.json',
    spring2026: 'manifest_fall2026.json'
  };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isoOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function day(y, m, d) {
    // A year like 0202 or 20277 is a typo in the sheet, not a date.
    if (y < 2000 || y > 2100) return null;
    var x = new Date(y, m - 1, d);
    return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d ? x : null;
  }
  /** "8/23/2026", "8/23/26", "2026-08-23", "Aug 23, 2026" -> a Date at local
   *  midnight; null when it is not a date. */
  function parseDate(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return day(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})\b/);
    if (m) return day(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
    var t = Date.parse(s);
    if (isNaN(t)) return null;
    var d = new Date(t);
    return day(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  function toDate(x) {
    if (x instanceof Date) return day(x.getFullYear(), x.getMonth() + 1, x.getDate());
    return parseDate(x);
  }

  /** "Fall 2026" -> "fall2026". The id the app has always stored the pick
   *  under (paddleSeason, paddleDepot_<id>, swap offers), so it must not change. */
  //  Only the season and year count, so "Fall 2026 Pick" is still fall2026.
  function idOf(name) {
    var n = String(name).toLowerCase();
    var m = n.match(/(spring|summer|fall|autumn|winter)[^a-z0-9]*(\d{4})/);
    return m ? m[1] + m[2] : n.replace(/[^a-z0-9]/g, '');
  }
  function manifestOf(id, name) {
    if (MANIFESTS[id]) return MANIFESTS[id];
    var m = String(name).toLowerCase().match(/([a-z]+)[^a-z0-9]*(\d{4})/);
    return 'manifest-' + (m ? m[1] + '-' + m[2] : id) + '.json';
  }

  function csvRows(text) {
    var rows = [], row = [], cur = '', q = false;
    text = String(text || '').replace(/^﻿/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  /** The sheet's CSV -> [{ name, start, end }] as written (strings). The
   *  columns are found by their headers ("pick", "start", "end"); without
   *  such headers they are taken in order: name, start date, end date. */
  function rowsOf(text) {
    var rows = csvRows(text).filter(function (r) { return r.some(function (v) { return String(v).trim(); }); });
    if (!rows.length) return [];
    var head = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var find = function (re) { for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; };
    var cS = find(/start|from|begin/), cE = find(/finish|end|last|to\b|until|thru|through/);
    var cN = find(/pick|name|season/);
    var hasHead = cS >= 0 && !parseDate(rows[0][cS]);
    if (!hasHead) { cN = 0; cS = 1; cE = 2; }
    if (cN < 0) cN = 0;
    if (cE < 0) cE = cS + 1;
    return rows.slice(hasHead ? 1 : 0).map(function (r) {
      return { name: String(r[cN] == null ? '' : r[cN]).trim(), start: String(r[cS] || '').trim(), end: String(r[cE] || '').trim() };
    }).filter(function (r) { return r.name && parseDate(r.start); });
  }

  /** The work year, from two more columns of the same tab: "New Work Year"
   *  (the first day) and "End Year" (the last day), found by their headers.
   *  The work year does not start on January 1 - usually the last Sunday of
   *  December. One row per year; any row may hold one. -> [{ start, end }]
   *  as written (strings). */
  function yearRowsOf(text) {
    var rows = csvRows(text).filter(function (r) { return r.some(function (v) { return String(v).trim(); }); });
    if (!rows.length) return [];
    var head = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var cS = -1, cE = -1;
    head.forEach(function (h, i) {
      if (cS < 0 && /year/.test(h) && /new|start|begin|first|work/.test(h) && !/end|last|finish/.test(h)) cS = i;
      else if (cE < 0 && /year/.test(h) && /end|last|finish/.test(h)) cE = i;
    });
    if (cS < 0) return [];
    return rows.slice(1).map(function (r) {
      return { start: String(r[cS] || '').trim(), end: cE >= 0 ? String(r[cE] || '').trim() : '' };
    }).filter(function (r) { return parseDate(r.start); });
  }

  function addDaysIso(iso, n) {
    var p = iso.split('-');
    return isoOf(new Date(+p[0], +p[1] - 1, +p[2] + n));
  }
  /** [{ start, end }] -> the work years on the sheet, oldest first:
   *  { start, last, label } in "YYYY-MM-DD". A missing end is the day
   *  before the next row's start, else 52 weeks on. The label is the year
   *  the work year mostly falls in (the year of its last day). */
  function buildYears(rows) {
    var ys = (rows || []).map(function (r) {
      var s = parseDate(r.start), e = parseDate(r.end);
      return { start: isoOf(s), last: e && e >= s ? isoOf(e) : '' };
    }).sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    ys.forEach(function (y, i) {
      if (!y.last) y.last = ys[i + 1] ? addDaysIso(ys[i + 1].start, -1) : addDaysIso(y.start, 363);
      y.label = y.last.slice(0, 4);
    });
    return ys;
  }
  /** The work year that holds `iso` ("YYYY-MM-DD"). A date outside the
   *  sheet's rows gets a year worked out from the nearest row, 52 weeks at a
   *  time (derived: true). null when the sheet has no year at all. */
  function workYearFor(years, iso) {
    if (!years || !years.length || !iso) return null;
    for (var i = 0; i < years.length; i++) if (years[i].start <= iso && iso <= years[i].last) return years[i];
    var first = years[0], last = years[years.length - 1];
    var y;
    if (iso < first.start) {
      y = { start: addDaysIso(first.start, -364), last: addDaysIso(first.start, -1) };
      for (var k = 0; k < 60 && iso < y.start; k++) y = { start: addDaysIso(y.start, -364), last: addDaysIso(y.start, -1) };
    } else {
      y = { start: addDaysIso(last.last, 1), last: addDaysIso(last.last, 364) };
      for (var j = 0; j < 60 && iso > y.last; j++) y = { start: addDaysIso(y.last, 1), last: addDaysIso(y.last, 364) };
    }
    y.label = y.last.slice(0, 4);
    y.derived = true;
    return y;
  }
  /** The work year right after (n = 1) or before (n = -1) the one given. */
  function workYearNext(years, y, n) {
    if (!y) return null;
    return workYearFor(years, n < 0 ? addDaysIso(y.start, -1) : addDaysIso(y.last, 1));
  }

  /** [{ name, start, end }] -> the picks, oldest first:
   *  { id, label, startDate, endDate, start, last, manifest }.
   *  startDate / endDate are Dates (endDate = the last day, null = open);
   *  start / last are the same days as "YYYY-MM-DD" for the app's date code. */
  function build(rows) {
    return rows.map(function (r) {
      var s = parseDate(r.start), e = parseDate(r.end);
      var id = idOf(r.name);
      return {
        id: id, label: r.name,
        startDate: s, endDate: e && e >= s ? e : null,
        start: isoOf(s), last: e && e >= s ? isoOf(e) : '',
        manifest: manifestOf(id, r.name)
      };
    }).sort(function (a, b) { return a.startDate - b.startDate; });
  }

  function contains(p, d) { return p.startDate <= d && (!p.endDate || d <= p.endDate); }

  /** The pick that covers a date (Date or "YYYY-MM-DD"), or null. Where two
   *  ranges touch on one day, the newer pick wins. */
  function forDate(picks, date) {
    var d = toDate(date);
    if (!d || !picks) return null;
    var hit = null;
    picks.forEach(function (p) { if (contains(p, d) && (!hit || p.startDate >= hit.startDate)) hit = p; });
    return hit;
  }
  /** The current pick: the range that holds today. If today falls in no
   *  range (a gap in the sheet), the last pick that has started; before the
   *  first one, the first. */
  function current(picks, today) {
    if (!picks || !picks.length) return null;
    var d = toDate(today || new Date());
    var hit = forDate(picks, d);
    if (hit) return hit;
    var started = picks.filter(function (p) { return p.startDate <= d; });
    return started.length ? started[started.length - 1] : picks[0];
  }
  /** The picks after the current one, soonest first. */
  function upcoming(picks, today) {
    var c = current(picks, today);
    return c ? picks.filter(function (p) { return p.startDate > c.startDate; }) : [];
  }
  /** 'past' | 'current' | 'future' for one pick, relative to the current pick. */
  function whenOf(picks, p, today) {
    var c = current(picks, today);
    if (!c || p.id === c.id) return 'current';
    return p.startDate > c.startDate ? 'future' : 'past';
  }

  function sheetCsvUrl(u) {
    u = String(u || '').trim();
    if (!u) return '';
    // A published link: make sure it is the CSV output.
    if (/\/spreadsheets\/d\/e\//.test(u)) {
      if (/output=csv/.test(u)) return u;
      var gp = u.match(/[#&?]gid=(\d+)/);
      return u.replace(/\/pub(html)?(\?.*|#.*)?$/, '/pub') + '?output=csv' + (gp ? '&gid=' + gp[1] : '') + '&single=true';
    }
    // A normal sheet link: read it through gviz.
    var m = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (m) {
      var g = u.match(/[#&?]gid=(\d+)/);
      return 'https://docs.google.com/spreadsheets/d/' + m[1] + '/gviz/tq?tqx=out:csv' + (g ? '&gid=' + g[1] : '');
    }
    return u;
  }

  function store() { try { return root.localStorage || null; } catch (_) { return null; } }
  function readCache() {
    var ls = store();
    if (!ls) return null;
    try {
      var c = JSON.parse(ls.getItem(CACHE_KEY) || 'null');
      return c && Array.isArray(c.rows) && c.rows.length ? c : null;
    } catch (_) { return null; }
  }
  function writeCache(rows, years) {
    var ls = store();
    if (!ls) return;
    try { ls.setItem(CACHE_KEY, JSON.stringify({ rows: rows, years: years || [], savedAt: Date.now() })); } catch (_) {}
  }

  function fetchSheet() {
    var url = sheetCsvUrl(SHEET_URL);
    if (!url) return Promise.reject(new Error('no pick sheet link is set'));
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
    // A cache-buster: Google and the phone both like to hand back yesterday's copy.
    var bust = (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
    return fetch(url + bust, ctl ? { cache: 'no-store', signal: ctl.signal } : { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('the pick sheet answered ' + r.status)); })
      .then(function (t) {
        // A sheet that is not published hands back Google's sign-in page.
        if (/^\s*</.test(t)) throw new Error('the pick sheet is not published');
        var rows = rowsOf(t);
        if (!rows.length) throw new Error('the pick sheet has no picks in it');
        return { rows: rows, years: yearRowsOf(t) };
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  function showError(msg) {
    var doc = root.document;
    if (!doc || !doc.body || doc.getElementById('pa-picks-error')) return;
    var bar = doc.createElement('div');
    bar.id = 'pa-picks-error';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:sticky;top:0;z-index:10000;background:#b3261e;color:#fff;'
      + 'font:600 14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:10px 14px;'
      + 'display:flex;gap:10px;align-items:center;flex-wrap:wrap';
    var t = doc.createElement('span');
    t.style.flex = '1 1 220px';
    t.textContent = 'The pick list could not be loaded (' + msg + '), and this device has no saved copy. '
      + 'Paddles and pick dates cannot show until it loads. Check your connection and try again.';
    var b = doc.createElement('button');
    b.type = 'button';
    b.textContent = 'Try again';
    b.style.cssText = 'background:#fff;color:#b3261e;border:0;border-radius:8px;padding:6px 14px;font:700 14px system-ui,sans-serif;cursor:pointer';
    b.onclick = function () { root.location.reload(); };
    bar.appendChild(t); bar.appendChild(b);
    doc.body.insertBefore(bar, doc.body.firstChild);
  }
  function showErrorWhenReady(msg) {
    var doc = root.document;
    if (!doc) return;
    if (doc.body) showError(msg);
    else doc.addEventListener('DOMContentLoaded', function () { showError(msg); });
  }

  var memo = null;
  var yearRows = [];
  var info = { stale: false, savedAt: null, error: null };
  /** All picks, oldest first. Resolves from the sheet, else from this
   *  device's last copy ({ stale: true } in PaPicks.info). Rejects only when
   *  neither is there, after showing the red bar. */
  function load() {
    if (memo) return memo;
    memo = fetchSheet().then(function (got) {
      writeCache(got.rows, got.years);
      yearRows = got.years;
      info = { stale: false, savedAt: Date.now(), error: null };
      return build(got.rows);
    }, function (err) {
      var c = readCache();
      var msg = (err && err.name === 'AbortError') ? 'the pick sheet did not answer' : (err && err.message) || 'unknown error';
      if (c) {
        info = { stale: true, savedAt: c.savedAt || null, error: msg };
        yearRows = c.years || [];
        return build(c.rows);
      }
      info = { stale: true, savedAt: null, error: msg };
      memo = null;                         // the next call tries the sheet again
      showErrorWhenReady(msg);
      throw new Error('The pick list could not be loaded: ' + msg + '.');
    });
    return memo;
  }
  /** The last copy this device loaded, at once (no network); null if none. */
  function cached() { var c = readCache(); return c ? build(c.rows) : null; }
  function reset() { memo = null; }
  /** The work years from the sheet (see buildYears); [] when it has none. */
  function loadYears() { return load().then(function () { return buildYears(yearRows); }, function () { return buildYears((readCache() || {}).years || []); }); }

  root.PaPicks = {
    load: load, cached: cached, reset: reset,
    current: current, forDate: forDate, whenOf: whenOf, upcoming: upcoming,
    parseDate: parseDate, isoOf: isoOf,
    loadYears: loadYears, workYearFor: workYearFor, workYearNext: workYearNext,
    info: function () { return info; },
    // For the tests.
    _rowsOf: rowsOf, _build: build, _sheetCsvUrl: sheetCsvUrl, _yearRowsOf: yearRowsOf, _buildYears: buildYears
  };
})(typeof window !== 'undefined' ? window : globalThis);
