// ==========================================================================
// Paddle App — static schedule engine.
//
// Everything here is derived from published schedule data: the paddle CSVs
// in this repo, picks.csv, and the GTFS JSON that the septa-gtfs pipeline
// publishes. There is NO Firebase in this module and NO live vehicle data.
//
// That second point is a product rule, not a convenience. Any countdown an
// operator sees must be driven by the SCHEDULED time only. Operators
// self-delaying to match a late leader is a known operational problem, so
// nothing in this file may consult TransitView or the observed-average
// departure times that block-tracker.html folds into its own dueOutMin.
// pa-live.js is the only place live data is touched, and nothing imports it
// except the panel that renders it.
//
// Time model: a schedule date is the calendar date ('YYYY-MM-DD') the run
// reports on, and every time is integer minutes from that date's midnight.
// Times past midnight are >= 1440, exactly as GTFS writes "25:14:00" and as
// the Python parser emits *_min. No Timestamps, no timezone math — the same
// numbers work in Dart.
// ==========================================================================

export const PADDLE_BASE = new URL('data/', document.baseURI).href;   // same origin
export const PICKS_URL   = new URL('picks.csv', document.baseURI).href;
export const GTFS_BASE   = 'https://deenersin-png.github.io/septa-gtfs/data';

// ---- time helpers ---------------------------------------------------------

export const pad2 = n => String(n).padStart(2, '0');

/** "12:43 AM" -> 43. Returns null when unparseable. */
export function clockToMin(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10); const min = parseInt(m[2], 10); const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

/** "25:14:00" -> 1514. GTFS hours run past 24 for post-midnight trips. */
export function gtfsToMin(t) {
  const m = String(t || '').match(/^(\d+):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

/** 1514 -> "1:14 AM" (wraps past midnight). */
export function fmtClock(min) {
  if (min == null) return '—';
  const m = ((min % 1440) + 1440) % 1440;
  let h = Math.floor(m / 60); const mm = m % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + pad2(mm) + ' ' + ap;
}

/** Minutes -> "2h 14m" / "14m". Negative -> "0m". */
export function fmtDur(min) {
  if (min == null) return '—';
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60), r = m % 60;
  return h ? h + 'h ' + pad2(r) + 'm' : r + 'm';
}

export function isoDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
export function fromIso(iso) {
  const p = String(iso).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);           // local midnight
}
export function addDays(iso, n) {
  const d = fromIso(iso); d.setDate(d.getDate() + n); return isoDate(d);
}
export function dowOf(iso) { return fromIso(iso).getDay(); }        // 0 = Sunday
export function daysBetween(a, b) { return Math.round((fromIso(b) - fromIso(a)) / 86400000); }
export function todayIso() { return isoDate(new Date()); }
/** Minutes since local midnight right now (0..1439). */
export function nowMinutes() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
/** Absolute ms for `min` minutes after `iso`'s local midnight. */
export function minToMs(iso, min) { return fromIso(iso).getTime() + min * 60000; }
/** Sunday on or before `iso`. */
export function weekStartOf(iso) { return addDays(iso, -dowOf(iso)); }

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function fmtDate(iso) {
  const d = fromIso(iso);
  return DAY_SHORT[d.getDay()] + ' ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---- fetch + CSV ----------------------------------------------------------

// Every schedule-data download gets a time limit. On weak cellular a fetch
// can stall for minutes without failing, and nothing downstream can render
// until it settles.
const FETCH_TIMEOUT_MS = 20000;

const mem = new Map();
async function fetchText(url) {
  if (mem.has(url)) return mem.get(url);
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
  const p = fetch(url, ctl ? { signal: ctl.signal } : undefined)
    .then(r => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))))
    .catch(() => {
      // Do NOT remember a failure: one dropped request on a bad connection
      // used to leave every run "not in paddle" until the page was reloaded.
      mem.delete(url);
      return '';
    })
    .finally(() => { if (timer) clearTimeout(timer); });
  mem.set(url, p);
  return p;
}
async function fetchJson(url) {
  const t = await fetchText(url);
  try { return t ? JSON.parse(t) : null; } catch (_) { return null; }
}

/** Quote-aware CSV -> array of objects keyed by lower-cased header. */
export function parseCSV(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const row = line => {
    const out = []; let cur = '', q = false;
    for (const c of line) {
      if (c === '"') q = !q;
      else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out;
  };
  const headers = row(lines[0]).map(h => h.trim().toLowerCase());
  return lines.slice(1).filter(l => l.trim()).map(l => {
    const vals = row(l); const o = {};
    headers.forEach((h, i) => { o[h] = (vals[i] || '').trim(); });
    return o;
  });
}

// ---- seasons (picks.csv) --------------------------------------------------
// picks.csv is the season registry that already existed in the repo and that
// nothing read. A season applies to a date when start <= date < end (end
// empty = current pick).

export async function loadSeasons() {
  const rows = parseCSV(await fetchText(PICKS_URL));
  return rows.map(r => ({
    id: r.season_id, label: r.label,
    start: r.start_date || '', end: r.end_date || null,
    manifest: r.manifest
  })).filter(s => s.id && s.start);
}

export function seasonFor(seasons, iso) {
  const hits = seasons.filter(s => s.start <= iso && (!s.end || iso < s.end));
  return hits.sort((a, b) => b.start.localeCompare(a.start))[0] || null;
}

export async function loadManifest(season) {
  const j = await fetchJson(PADDLE_BASE + season.manifest);
  return (j && j.districts) || [];
}

// Depot slugs carry the season ("callowhillb-fall-2026") because they double
// as directory names. The profile stores the stable key.
const SEASON_SUFFIX = /-(summer|fall|spring|winter)-?\d{4}$/i;
export const depotKeyOf = slug => String(slug || '').replace(SEASON_SUFFIX, '');

/** This depot's district entry in a season's manifest. Tolerates the
 *  spring-era bare slugs ("callowhill") vs later "callowhillb". */
export function districtFor(districts, depotKey) {
  const k = String(depotKey || '');
  const cands = [k, k.replace(/b$/, ''), k + 'b'];
  for (const c of cands) {
    const hit = districts.find(d => depotKeyOf(d.name) === c);
    if (hit) return hit;
  }
  return null;
}

/** Depot slug for a depot key on a given date, or null when no season / no
 *  district covers it. Also returns the season for display. */
export async function slugFor(depotKey, iso) {
  const seasons = await loadSeasons();
  const season = seasonFor(seasons, iso);
  if (!season) return { season: null, slug: null, district: null };
  const districts = await loadManifest(season);
  const district = districtFor(districts, depotKey);
  return { season, slug: district ? district.name : null, district };
}

// ---- day type / holidays --------------------------------------------------
// septa-gtfs publishes GTFS calendar exceptions (July 4th -> sunday, etc.)
// as a date -> day-type map. Consult it before falling back to day-of-week.

export async function loadCalendarOverrides() {
  return (await fetchJson(GTFS_BASE + '/calendar-overrides.json')) || {};
}
export function dayTypeFor(iso, overrides) {
  const ov = overrides && overrides[iso];
  if (ov) return ov;
  const d = dowOf(iso);
  return d === 0 ? 'sunday' : d === 6 ? 'saturday' : 'weekday';
}
export function isHoliday(iso, overrides) { return !!(overrides && overrides[iso]); }

// ---- paddle runs ----------------------------------------------------------

/** Map runNo -> raw CSV row for one depot slug + day type. */
export async function loadPaddle(slug, dayType) {
  const rows = parseCSV(await fetchText(PADDLE_BASE + slug + '/' + dayType + '.csv'));
  const m = new Map();
  rows.forEach(r => { if (r.runno) m.set(String(r.runno), r); });
  return m;
}

const timePart = s => { const m = String(s || '').match(/\d{1,2}:\d{2}\s*[AP]M/i); return m ? m[0] : ''; };

/** "21-42" -> ["21","42"]; "L1 OWL" -> ["L1"]. Route ids as GTFS files them. */
export function routesOfLabel(label) {
  return String(label || '').split(/[-\/]/).map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
}

/**
 * Normalise a paddle row into the run model the rest of the app uses.
 * Times are made monotonic: walking report -> piece1 start/end -> ... ->
 * finish, any value smaller than the one before it is a midnight crossing
 * and gets +1440. That is how an 11:54 PM report with a 9:10 AM finish
 * becomes 1434 -> 1990 rather than 1434 -> 550.
 */
export function normalizeRun(row, dayType) {
  if (!row) return null;
  const pieces = [];
  for (let i = 1; i <= 10; i++) {
    const label = row['r' + i];
    if (!label) continue;
    pieces.push({
      index: i,
      routeLabel: label,
      routes: routesOfLabel(label),
      block: String(row['b' + i] || ''),
      startType: row['potype' + i] || '',
      startMin: clockToMin(row['pot' + i]),
      endType: row['pitype' + i] || '',
      endMin: clockToMin(row['pit' + i]),
      durLabel: row['stime' + i] || ''
    });
  }
  let reportMin = clockToMin(timePart(row.start));
  let finishMin = clockToMin(timePart(row.finish));

  let prev = reportMin != null ? reportMin : ((pieces[0] && pieces[0].startMin) || 0);
  const bump = v => { if (v == null) return v; while (v < prev) v += 1440; prev = v; return v; };
  for (const p of pieces) { p.startMin = bump(p.startMin); p.endMin = bump(p.endMin); }
  finishMin = bump(finishMin);

  return {
    runNo: String(row.runno), dayType,
    depot: row.depot || '', myId: row.myid || '',
    reportMin, finishMin,
    pullOutMin: pieces.length ? pieces[0].startMin : reportMin,
    pullInMin:  pieces.length ? pieces[pieces.length - 1].endMin : finishMin,
    payHours: parseFloat(row.pay) || 0,
    workTime: row.worktime || '',
    swing: pieces.length > 1,
    pieces,
    routes: [...new Set(pieces.flatMap(p => p.routes))],
    blocks: [...new Set(pieces.map(p => p.block).filter(Boolean))]
  };
}

export async function getRun(slug, dayType, runNo) {
  if (!slug || !runNo) return null;
  const m = await loadPaddle(slug, dayType);
  return normalizeRun(m.get(String(runNo)), dayType);
}

/**
 * Official SEPTA paddle PDF links for one depot slug (pdfs.csv), keyed
 * "Weekday-209" -> { moblink, pclink }. Both forms open the same PDF at the
 * run's page; the paddle viewer uses moblink on phones and pclink otherwise.
 */
export async function loadPaddleLinks(slug) {
  const rows = parseCSV(await fetchText(PADDLE_BASE + slug + '/pdfs.csv'));
  const m = new Map();
  rows.forEach(r => {
    if (r.runno && r.day) m.set(r.day + '-' + r.runno, { moblink: r.moblink || '', pclink: r.pclink || '' });
  });
  return m;
}

/** "weekday" -> "Weekday", the capitalisation pdfs.csv and the manifest use. */
export const dayLabel = dayType => String(dayType || '').charAt(0).toUpperCase() + String(dayType || '').slice(1);

/** The run's own paddle page: phone link on narrow screens, desktop link otherwise. */
export async function paddleLinkFor(slug, dayType, runNo) {
  if (!slug || !runNo) return '';
  const hit = (await loadPaddleLinks(slug)).get(dayLabel(dayType) + '-' + runNo);
  if (!hit) return '';
  const phone = typeof window !== 'undefined' && window.innerWidth <= 768;
  return (phone ? hit.moblink || hit.pclink : hit.pclink || hit.moblink) || '';
}

/**
 * Pull-out / pull-in times and run numbers per block across every district
 * for a day type - the same table block-tracker.html builds for its cards
 * (PO / PI line and RUN chips). block -> { poTime, piTime, runs:[{runno, link}] }.
 */
export async function loadBlockPaddles(districts, dayType) {
  const label = dayLabel(dayType);
  const byBlock = new Map();
  await Promise.all((districts || []).map(async d => {
    if (!d.days || !d.days.includes(label)) return;
    const [schedText, pdfsText] = await Promise.all([
      fetchText(PADDLE_BASE + d.name + '/' + dayType + '.csv'),
      fetchText(PADDLE_BASE + d.name + '/pdfs.csv')
    ]);
    const runLink = new Map();
    for (const row of parseCSV(pdfsText)) {
      if (!row.runno || (row.day || '') !== label) continue;
      const link = (row.moblink || row.pclink || '').trim();
      if (link) runLink.set(String(row.runno), link);
    }
    for (const row of parseCSV(schedText)) {
      const runno = String(row.runno || '').trim();
      if (!runno) continue;
      for (let i = 1; i <= 10; i++) {
        const b = (row['b' + i] || '').trim();
        if (!b || b === '0') continue;
        if (!byBlock.has(b)) byBlock.set(b, { poTime: '', piTime: '', runs: [] });
        const rec = byBlock.get(b);
        const potype = (row['potype' + i] || '').trim().toUpperCase();
        const pitype = (row['pitype' + i] || '').trim().toUpperCase();
        const pot = (row['pot' + i] || '').trim();
        const pit = (row['pit' + i] || '').trim();
        // Some blocks list more than one pull-out / pull-in (29 on a fall-2026
        // weekday, e.g. 5554: in at 3:23 PM and 4:14 PM). Keep the EARLIEST
        // pull-out and the LATEST pull-in, so a block is never treated as
        // finished before its last possible pull-in.
        if (potype === 'O' && pot && (!rec.poTime || (clockToMin(pot) ?? Infinity) < (clockToMin(rec.poTime) ?? Infinity))) rec.poTime = pot;
        if (pitype === 'I' && pit && (!rec.piTime || (pullInKey(pit) ?? -1) > (pullInKey(rec.piTime) ?? -1))) rec.piTime = pit;
        if (!rec.runs.some(r => r.runno === runno)) {
          rec.runs.push({ runno, link: runLink.get(runno) || '', sortMin: clockToMin(pot) ?? Infinity });
        }
      }
    }
  }));
  for (const rec of byBlock.values()) rec.runs.sort((a, b) => a.sortMin - b.sortMin);
  return byBlock;
}

/** GTFS direction names for a route, e.g. { "0": "Eastbound", "1": "Westbound" }. */
export async function routeDirectionNames(route) {
  const j = await fetchJson(GTFS_BASE + '/' + encodeURIComponent(route) + '.json');
  return (j && j.directions) || {};
}

/** Relief packages (holdowner.csv) -> Map relief_run -> {sunday:'51', monday:'454', ...}. */
export async function loadReliefPackages(slug) {
  const rows = parseCSV(await fetchText(PADDLE_BASE + slug + '/holdowner.csv'));
  const m = new Map();
  for (const r of rows) {
    if (!r.relief_run) continue;
    const days = {};
    DAY_NAMES.forEach(n => {
      const v = r[n.toLowerCase()];
      days[n.toLowerCase()] = (v && v.toUpperCase() !== 'OFF') ? v : null;
    });
    m.set(String(r.relief_run), days);
  }
  return m;
}

// ---- GTFS trips -----------------------------------------------------------

export async function loadGtfsManifest() {
  return (await fetchJson(GTFS_BASE + '/manifest.json')) || {};
}

const tripsMem = new Map();
/**
 * All trips on one route for a day type, normalised to minutes. Route files
 * are 110-150 KB; the browser HTTP cache handles repeat loads, and we only
 * ever load the routes on the operator's own run.
 */
export async function loadRouteTrips(route, dayType) {
  const key = route + '|' + dayType;
  if (tripsMem.has(key)) return tripsMem.get(key);
  const p = (async () => {
    const j = await fetchJson(GTFS_BASE + '/' + encodeURIComponent(route) + '.json');
    const list = (j && j[dayType]) || [];
    return list.map(t => ({
      tripId: String(t.trip_id), block: String(t.block_id || ''), route,
      dir: t.direction, headsign: t.headsign || '',
      s: gtfsToMin(t.start), e: gtfsToMin(t.end),
      first: t.first || '', last: t.last || ''
    })).filter(t => t.s != null && t.e != null).sort((a, b) => a.s - b.s);
  })();
  tripsMem.set(key, p);
  return p;
}

/** Every trip on a set of routes (an interlined block spans two files). */
export async function routeTrips(routes, dayType) {
  const all = (await Promise.all(routes.map(r => loadRouteTrips(r, dayType)))).flat();
  const seen = new Set();
  return all.filter(t => !seen.has(t.tripId) && seen.add(t.tripId)).sort((a, b) => a.s - b.s);
}

/**
 * One block's trips. NOTE: septa-gtfs's blocks.json keeps only the FIRST
 * route for an interlined block, so it cannot be used to discover routes —
 * the paddle's own route label ("21-42") is the source of which files to load.
 */
export async function blockTrips(block, routes, dayType) {
  const all = await routeTrips(routes, dayType);
  return all.filter(t => t.block === String(block));
}

// ---- pure scheduling (scheduled times only) -------------------------------
// Extracted from block-tracker.html's scheduledBlockStatus / getNextDeparture
// / getCurrentSchedLeader, MINUS the observed-average substitution the
// tracker applies. These take plain trip arrays so they can be unit-tested
// and ported to Dart line for line.

export function blockStatus(trips, nowMin) {
  if (!trips || !trips.length) return null;
  // SEPTA's GTFS carries near-duplicate trips from different service variants
  // (two 12:51 AM trips on the same block, one ending 1:21 and one 1:22), so
  // "next" must mean the first departure AFTER the current trip ends - never
  // the array neighbour, which may be a duplicate of the trip in progress.
  const cur = trips.find(t => nowMin >= t.s && nowMin <= t.e);
  if (cur) {
    const next = trips.find(t => t !== cur && t.s >= cur.e) || null;
    return { state: 'in_service', trip: cur, next };
  }
  const upcoming = trips.find(t => t.s > nowMin) || null;
  const ended = trips.filter(t => t.e <= nowMin);
  if (!ended.length) return { state: 'not_started', next: upcoming || trips[0] };
  const prev = ended.reduce((acc, t) => (!acc || t.e > acc.e ? t : acc), null);
  if (!upcoming) return { state: 'done', trip: prev };
  return { state: 'layover', prev, next: upcoming };
}

/** The first scheduled departure after `nowMin`. Scheduled only. */
export function nextDeparture(trips, nowMin) {
  if (!trips || !trips.length) return null;
  return trips.find(t => t.s > nowMin) || null;
}

/** Trip in progress now, else the next upcoming, else the last of the day. */
export function relevantTrip(trips, nowMin) {
  if (!trips || !trips.length) return null;
  for (const t of trips) if (nowMin >= t.s && nowMin <= t.e) return t;
  for (const t of trips) if (t.s > nowMin) return t;
  return trips[trips.length - 1];
}

// ---- phantom trips --------------------------------------------------------
// SEPTA's GTFS gives some blocks trips AFTER the block's real pull-in (seen:
// route 44 block 9120 pulls in 11:05 AM per the pick, yet GTFS lists it at
// 9:18 PM). Those trips never run, so a finished block must not be chosen as
// anyone's leader. The operator pick's pull-in time is the truth. Same rule as
// block-tracker.html's isPhantomTrip.

/** Hour the service day rolls over; earlier pull-ins are owl (24:00+). */
export const SERVICE_DAY_START_HR = 4;

/** Pick pull-in "12:18 AM" -> service-day minutes (owl pull-ins shift to 24:00+). */
export function pullInKey(t) {
  const m = clockToMin(t);
  if (m == null) return null;
  return m < SERVICE_DAY_START_HR * 60 ? m + 1440 : m;
}

/** loadBlockPaddles() table -> Map block -> final pull-in (service minutes). */
export function pullInMap(blockPaddles) {
  const m = new Map();
  if (!blockPaddles) return m;
  for (const [b, rec] of blockPaddles) {
    const k = rec && rec.piTime ? pullInKey(rec.piTime) : null;
    if (k != null) m.set(String(b), k);
  }
  return m;
}

/** A trip is phantom if it starts at or after its block's pick pull-in. */
export function isPhantomTrip(t, pullIns) {
  if (!pullIns || !t) return false;
  const pi = pullIns.get(String(t.block));
  return pi != null && t.s >= pi;
}

/**
 * The block one headway ahead of `myBlock` right now: the trip in the same
 * direction whose start is the latest one before mine. Informational only —
 * the caller renders it in its own panel and never feeds it into a countdown.
 * `pullIns` (optional, from pullInMap) drops phantom trips of blocks that have
 * already pulled in, so a finished block is never reported as the leader.
 */
export function leaderBlock(allTrips, myBlock, nowMin, pullIns) {
  const mine = allTrips.filter(t => t.block === String(myBlock));
  const my = relevantTrip(mine, nowMin);
  if (!my) return null;
  let best = null;
  for (const t of allTrips) {
    // Same route AND direction: an interlined run loads two route files, and
    // direction 0 on one route is not direction 0 on the other.
    if (t.block === String(myBlock) || t.route !== my.route || t.dir !== my.dir) continue;
    if (isPhantomTrip(t, pullIns)) continue;
    if (t.s < my.s && (!best || t.s > best.s)) best = t;
  }
  return best ? { block: best.block, trip: best, myTrip: my } : null;
}
