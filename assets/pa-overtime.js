// ==========================================================================
// Holiday overtime list (global PaOvertime). Needs pa-holiday.js.
//
// The runs posted for overtime sign-up on a holiday, from the app owner's
// Google Sheet:
//
//   tab "Dates" - one row per holiday, for ALL depots:
//     Pick Date by | (time) | Holiday Date | Day    | Holiday      | Online
//     11/24/2026   | 2:00 PM | 11/26/2026  | Sunday | Thanksgiving | YES
//   one tab per depot, named like the app's depot ("Callowhill Bus"):
//     Run Number (+ optional Pick Date by / Holiday Date / Day: blank cells
//     take the row above's; no date at all = the Dates tab's next holiday)
//
// Day = the schedule worked (a Friday holiday on the Sunday schedule says
// "Sunday"). Online: YES = published, NO = still being typed in (hidden).
// A published holiday comes down by itself at its pick date + time.
// index.html?preview=1 / overtime.html?preview=1 show unpublished ones too.
//
// Google answers a tab name it doesn't have with the FIRST tab, so the tab
// list is read from the sheet's htmlview page and each tab fetched by gid.
//
//   PaOvertime.load({ force })     -> { holidays, entries, notices, stale, savedAt }
//                                     notices: the Dates tab's H-K day notices
//   PaOvertime.published(h)        holiday on now (Online YES, before pick time)
//   PaOvertime.depotMatches(a, b)  tab / depot names
//   PaOvertime.preview()           ?preview=1
// ==========================================================================
(function () {
  'use strict';
  const SHEET_ID = '1C8fuIoS_YOIRdtxBQgQ2o-BbyE1x_wF6DKppZKHEIPQ';
  const BASE = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID;
  const H = () => window.PaHoliday;
  const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const pad = n => String(n).padStart(2, '0');
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const todayIso = () => H().todayIso();

  // ---- CSV: rows of cells (gviz quotes every cell) ----------------------------
  function csvRows(text) {
    const rows = []; let row = [], cur = '', q = false;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows.map(r => r.map(x => x.trim()));
  }
  const key = h => String(h || '').toLowerCase().replace(/[^a-z]/g, '');
  // Column index by header name; the first name that matches wins.
  function colIdx(head, ...names) {
    const ks = head.map(key);
    for (const n of names) {
      const i = ks.findIndex(k => typeof n === 'string' ? k.includes(n) : n.test(k));
      if (i >= 0) return i;
    }
    return -1;
  }

  // ---- cells ------------------------------------------------------------------
  /** A date cell -> { iso, min } (min = time of day when there is one, else null). */
  function parseDate(s, today) {
    s = String(s || '').trim();
    if (!s) return null;
    let y, m, d, x;
    if ((x = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +x[1]; m = +x[2]; d = +x[3]; }
    else if ((x = s.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?/))) { m = +x[1]; d = +x[2]; y = x[3] ? +x[3] : null; }
    else if ((x = s.match(/([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/))) {
      const mi = MONTHS.findIndex(n => n.startsWith(x[1].toLowerCase().slice(0, 3)));
      if (mi < 0) return null;
      m = mi + 1; d = +x[2]; y = x[3] ? +x[3] : null;
    } else return null;
    if (y != null && y < 100) y += 2000;
    if (y == null) {
      // No year: this year's, unless that was more than two months ago.
      y = +today.slice(0, 4);
      if (y + '-' + pad(m) + '-' + pad(d) < H().addDays(today, -60)) y++;
    }
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    return { iso: y + '-' + pad(m) + '-' + pad(d), min: parseTime(s.slice(x.index + x[0].length)) };
  }
  /** "2:00 PM" / "14:00" / "2 PM" -> minutes, else null ("0:00:00" = none). */
  function parseTime(s) {
    s = String(s || '');
    let t = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP])?\.?M?\.?/i), h, mm, ap;
    if (t) { h = +t[1]; mm = +t[2]; ap = (t[3] || '').toUpperCase(); }
    else if ((t = s.match(/\b(\d{1,2})\s*([AP])\.?M\.?\b/i))) { h = +t[1]; mm = 0; ap = t[2].toUpperCase(); }
    else return null;
    if (ap === 'P' && h !== 12) h += 12;
    if (ap === 'A' && h === 12) h = 0;
    const min = h * 60 + mm;
    return min === 0 && !ap ? null : min;
  }
  /** "Sunday" / "SUN" / "Sat" / "Weekday" -> 'sunday' | 'saturday' | 'weekday', else ''. */
  function parseDay(s) {
    const l = String(s || '').trim().toLowerCase();
    if (!l) return '';
    if (l.startsWith('sun')) return 'sunday';
    if (l.startsWith('sat')) return 'saturday';
    if (/^(wk|week|mon|tue|wed|thu|fri)/.test(l)) return 'weekday';
    return '';
  }
  const yes = s => /^(y|yes|true|1|on|online|publish|published)$/i.test(String(s || '').trim());

  // ---- the Dates tab -----------------------------------------------------------
  const isDatesTab = name => /^(dates?|holidays?|holiday dates?)$/i.test(String(name || '').trim());
  function holidaysOf(text, today) {
    const rows = csvRows(text);
    if (!rows.length) return [];
    const head = rows[0];
    const iHol = colIdx(head, 'holidaydate', /^date$/, 'workdate');
    const iPick = colIdx(head, 'pick', 'signup', 'deadline');
    // The pick time: a "Time" column, else the unnamed one right after Pick Date by.
    let iTime = colIdx(head, 'time');
    if (iTime < 0 && iPick >= 0 && !key(head[iPick + 1])) iTime = iPick + 1;
    const iDay = colIdx(head, /^(day|schedule|scheduleday|dayschedule|servingday)$/);
    const iName = colIdx(head, /^(holiday|holidayname|name|occasion)$/);
    const iOn = colIdx(head, 'online', 'publish', 'live', 'show');
    const out = [];
    rows.slice(1).forEach(r => {
      const hol = parseDate(r[iHol], today);
      if (!hol) return;
      const pick = iPick >= 0 ? parseDate(r[iPick], today) : null;
      let pickMin = pick ? pick.min : null;
      if (iTime >= 0 && parseTime(r[iTime]) != null) pickMin = parseTime(r[iTime]);
      out.push({ iso: hol.iso, pickIso: pick ? pick.iso : '', pickMin, day: iDay >= 0 ? parseDay(r[iDay]) : '',
                 name: iName >= 0 ? String(r[iName] || '').trim() : '', online: iOn >= 0 ? yes(r[iOn]) : true, fromDates: true });
    });
    return out.sort((a, b) => a.iso.localeCompare(b.iso));
  }

  // ---- the Dates tab's day notices (columns H-K) -----------------------------------
  // For EVERY depot, overtime list or not. Row 1 says what to use, row 2 is a
  // "Date" / "Day" sub-header, then one date + its name per row:
  //   H1 "Use Sunday Paddles"     H3.. dates  I3.. the holiday ("Thanksgiving")
  //   J1 "Use Alternate Paddles"  J3.. dates  K3.. the kind of day ("Holiday week")
  // -> [{ iso, kind: 'sunday' | 'alt', name, title: the row-1 text }]
  function noticesOf(text, today) {
    const rows = csvRows(text);
    if (!rows.length) return [];
    const head = rows[0], out = [];
    const cols = [[colIdx(head, /^use.*sunday/, 'sundaypaddles', 'sundayschedule'), 'sunday'],
                  [colIdx(head, /^use.*alternate/, 'alternatepaddles', 'alternateschedule'), 'alt']];
    cols.forEach(([i, kind]) => {
      if (i < 0) return;
      const title = String(head[i] || '').trim() || (kind === 'sunday' ? 'Use Sunday Paddles' : 'Use Alternate Paddles');
      rows.slice(1).forEach(r => {
        const d = parseDate(r[i], today);                    // "Date" / blank rows: no date
        if (d) out.push({ iso: d.iso, kind, name: String(r[i + 1] || '').trim(), title });
      });
    });
    return out.sort((a, b) => a.iso.localeCompare(b.iso));
  }

  // ---- a depot tab ---------------------------------------------------------------
  function entriesOf(text, depotName, holidays, today) {
    const rows = csvRows(text);
    if (!rows.length) return [];
    const head = rows[0];
    const iRun = colIdx(head, 'run');
    if (iRun < 0) return [];
    const iHol = colIdx(head, 'holiday', 'workdate');
    const iPick = colIdx(head, 'pick', 'signup', 'deadline');
    const iDay = colIdx(head, /^(day|schedule|scheduleday|dayschedule|servingday)$/);
    const iDepot = colIdx(head, 'depot', 'district', 'garage');
    // No date on the tab: the Dates tab's next holiday (else its last one).
    const next = holidays.find(h => h.iso >= today) || holidays[holidays.length - 1] || null;
    const out = [];
    let hol = null, pick = null, day = '';
    rows.slice(1).forEach((r, i) => {
      const h = iHol >= 0 ? parseDate(r[iHol], today) : null;
      const p = iPick >= 0 ? parseDate(r[iPick], today) : null;
      const dy = iDay >= 0 ? parseDay(r[iDay]) : '';
      if (h) hol = h;
      if (p) pick = p;
      if (dy) day = dy;
      const iso = hol ? hol.iso : next ? next.iso : '';
      if (!iso) return;
      // The Dates tab's row for that holiday wins: one place for every depot.
      const H0 = holidays.find(x => x.iso === iso);
      const base = H0 || { iso, pickIso: pick ? pick.iso : '', pickMin: pick ? pick.min : null, day, name: '', online: true, fromDates: false };
      const depot = (iDepot >= 0 && String(r[iDepot] || '').trim()) || depotName;
      (String(r[iRun] || '').match(/\d{1,4}/g) || []).forEach(n => out.push({
        iso, runNo: String(+n), depot, row: i + 2,
        pickIso: base.pickIso, pickMin: base.pickMin, day: base.day || day, name: base.name, online: base.online, holiday: base }));
    });
    const seen = new Set();
    return out.filter(e => { const k = e.iso + '|' + e.runNo + '|' + e.depot.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // ---- fetch -----------------------------------------------------------------------
  async function sheetTabs() {
    const r = await fetch(BASE + '/htmlview?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const html = await r.text();
    const unq = s => s.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
                      .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');
    const tabs = [], re = /items\.push\(\{name: "((?:[^"\\]|\\.)*)",[^}]*?gid: "(\d+)"/g;
    let m;
    while ((m = re.exec(html))) tabs.push({ name: unq(m[1]).trim(), gid: m[2] });
    if (!tabs.length) throw new Error('no tabs');
    return tabs;
  }
  async function fetchTabs() {
    // Staging test: ?sheet=tests/x.csv (a depot tab) [+ &dates=tests/y.csv].
    const q = new URLSearchParams(location.search), test = q.get('sheet'), tdates = q.get('dates');
    const ok = p => p && /^[\w\/.-]+\.csv$/.test(p);
    if (ok(test)) {
      const get = async p => (await fetch(p, { cache: 'no-store' })).text();
      const out = [{ name: '', text: await get(test) }];
      if (ok(tdates)) out.push({ name: 'Dates', text: await get(tdates) });
      return { tabs: out, test: true };
    }
    const tabs = await sheetTabs();
    const out = await Promise.all(tabs.map(async t => {
      const r = await fetch(BASE + '/gviz/tq?tqx=out:csv&gid=' + t.gid + '&t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      return { name: t.name, text: await r.text() };
    }));
    return { tabs: out, test: false };
  }

  let cache = null, cacheAt = 0;
  /** Every holiday and run on the sheet. Kept 2 minutes (opts.force: fetch again);
   *  no connection = the last list saved on this phone (stale: true). */
  async function load(opts) {
    const o = opts || {};
    if (cache && !o.force && Date.now() - cacheAt < 120000) return cache;
    let tabs, stale = false, savedAt = Date.now(), test = false;
    try {
      const got = await fetchTabs();
      tabs = got.tabs; test = got.test;
      if (!test) { lsSet('ot_sheet3', JSON.stringify(tabs)); lsSet('ot_sheet_at', String(Date.now())); }
    } catch (e) {
      try { tabs = JSON.parse(lsGet('ot_sheet3') || 'null'); } catch (_) { tabs = null; }
      if (!tabs) throw e;
      stale = true; savedAt = +lsGet('ot_sheet_at') || 0;
    }
    const today = todayIso();
    const holidays = tabs.filter(t => isDatesTab(t.name)).flatMap(t => holidaysOf(t.text, today));
    const entries = tabs.filter(t => !isDatesTab(t.name)).flatMap(t => entriesOf(t.text, t.name, holidays, today));
    const notices = tabs.filter(t => isDatesTab(t.name)).flatMap(t => noticesOf(t.text, today));
    cache = { holidays, entries, notices, stale, savedAt, raw: JSON.stringify(tabs) };
    cacheAt = Date.now();
    return cache;
  }

  /** When sign-up ends: the pick date at its time (no time: end of that day). */
  function closesMs(h) {
    if (!h || !h.pickIso) return null;
    const d = H().dateOf(h.pickIso);
    if (h.pickMin != null) d.setMinutes(h.pickMin); else d.setHours(23, 59, 59);
    return d.getTime();
  }
  /** Published now: Online YES, before the pick time, and the holiday not past. */
  function published(h, now) {
    if (!h || !h.online) return false;
    const c = closesMs(h), t = now || Date.now();
    if (c != null) return t < c;
    return h.iso >= todayIso();
  }
  const preview = () => { try { return new URLSearchParams(location.search).get('preview') === '1'; } catch (_) { return false; } };

  const letters = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const normDepot = s => String(s || '').toLowerCase().replace(/\b(bus|depot|district|garage)\b/g, '').replace(/[^a-z]/g, '');
  /** Does a tab name ("Callowhill Bus", "Callowhill") name the depot `label`?
   *  ("Frankford" = Frankford Bus, never Frankford Rail.) No name fits any. */
  function depotMatches(sheetDepot, label) {
    if (!sheetDepot) return true;
    return letters(sheetDepot) === letters(label) || normDepot(sheetDepot) === normDepot(label);
  }

  window.PaOvertime = { load, published, closesMs, preview, depotMatches, parseDate, parseTime, parseDay };
})();
