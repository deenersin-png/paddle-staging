// ==========================================================================
// Paddle App — the live tracker's bus scorecard and the Detours page's
// detour cards, for use on the home screen.
//
// Markup and wording are copied from block-tracker.html (buildNode,
// depArrLineHtml, paddleRowHtml, runChipsHtml, leaderTimelineHtml,
// annotateLeaderTimeline) and detours.html (renderDetours), so an operator
// sees the same card in both places. Styles live in pa-live-cards.css under
// the .bt and .dt wrappers. The tracker's list-only extras - the sequence
// number and overtake flags - need every bus on the route ranked in order,
// so they are not part of a single card.
//
// Live data here is informational only. Nothing in this file feeds the
// scheduled countdown.
// ==========================================================================

import { blockStatus, isPhantomTrip, blockOutSince } from './pa-schedule.js';

const LATE_BAD = 6;

export const ICONS = {
  // The app's own bus (the picture next to the menu button), everywhere.
  bus:  '<img class="bus-ico" src="' + new URL('./icon-192.png', import.meta.url).href + '" alt="" width="14" height="14">',
  seat: '<svg viewBox="0 0 24 24"><path d="M4 18v3h3v-3h10v3h3v-3h1v-1c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v1h1zm15-8h-2V7c0-1.1-.9-2-2-2H9c-1.1 0-2 .9-2 2v3H5c-1.1 0-2 .9-2 2v1h18v-1c0-1.1-.9-2-2-2zM9 7h6v3H9V7z"/></svg>'
};

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtClock(min) {
  min = ((min % 1440) + 1440) % 1440;
  let h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

export function dirShort(d) {
  if (!d) return '—';
  const l = String(d).toLowerCase();
  if (l.includes('east'))  return 'EB';
  if (l.includes('west'))  return 'WB';
  if (l.includes('north')) return 'NB';
  if (l.includes('south')) return 'SB';
  return String(d).slice(0, 2).toUpperCase();
}

function seatInfo(v) {
  return ({
    MANY_SEATS_AVAILABLE:       { t: 'Many Seats',   c: 'many',     show: true },
    FEW_SEATS_AVAILABLE:        { t: 'Few Seats',    c: 'few',      show: true },
    STANDING_ROOM_ONLY:         { t: 'Standing',     c: 'standing', show: true },
    CRUSHED_STANDING_ROOM_ONLY: { t: 'Very Crowded', c: 'full',     show: true },
    FULL:                       { t: 'Full',         c: 'full',     show: true }
  })[v] || { t: '—', c: 'na', show: false };
}

// Passenger load from the live feed (estimated_seat_availability), as a
// colour-coded tag for the card's bottom-right corner. No data → nothing.
const LOAD_INFO = {
  EMPTY:                      { t: 'Empty',      c: 'empty' },
  MANY_SEATS_AVAILABLE:       { t: 'Many', x: ' Seats', c: 'many' },
  FEW_SEATS_AVAILABLE:        { t: 'Few',  x: ' Seats', c: 'few' },
  STANDING_ROOM_ONLY:         { t: 'Standing',   c: 'standing' },
  CRUSHED_STANDING_ROOM_ONLY: { t: 'Crowded',    c: 'full' },
  FULL:                       { t: 'Full',       c: 'full' }
};
function loadTagHtml(v) {
  const s = LOAD_INFO[v];
  return s ? '<span class="at-load ' + s.c + '" title="Passenger load">' + ICONS.seat + ' ' + s.t + (s.x ? '<span class="ld-x">' + s.x + '</span>' : '') + '</span>' : '';
}

// ---- model -------------------------------------------------------------------

/**
 * The scheduled leader of a trip: among the same route and direction, the
 * trip with the latest start before `startMin`. (block-tracker loads one route
 * at a time, so its candidates are always same-route; an interlined run spans
 * two route files here, and direction 0 on one route is not direction 0 on
 * the other.) Phantom trips of blocks that already pulled in are skipped, so
 * a finished block never shows up as a leader (block-tracker isPhantomTrip).
 */
export function leaderForTrip(allTrips, block, trip, pullIns) {
  // Start times only compare at the same place: a 4:44 trip from the far end
  // of the line (Wycombe Loop) is not ahead of a 5:05 departure from 61st &
  // Pine the way the 4:35 from 61st & Pine is. So the bus that left MY first
  // stop before me wins; any trip in my direction only when none did.
  let best = null, sameStop = null;
  for (const t of allTrips) {
    if (t.block === String(block) || t.route !== trip.route || t.dir !== trip.dir) continue;
    if (isPhantomTrip(t, pullIns)) continue;
    if (t.s >= trip.s) continue;
    if (!best || t.s > best.s) best = t;
    if (trip.first && t.first === trip.first && (!sameStop || t.s > sameStop.s)) sameStop = t;
  }
  return sameStop || best;
}

/**
 * A tracker-shaped bus for `block`: the live vehicle when TransitView has
 * it, otherwise a scheduled-only placeholder drawn from GTFS, exactly as
 * block-tracker.html's mergeScheduledBlocks builds them.
 * `knownBus(block, route, busyAt)` (pa-live.js) gives today's bus for a block
 * that isn't in the live feed right now — e.g. resting at a terminal — so the
 * card keeps its number instead of "pending".
 */
export function buildBusModel({ block, allTrips, buses, nowMin, dirNamesByRoute = {}, pullIns = null, pullOuts = null, knownBus = null }) {
  const dirName = t => (dirNamesByRoute[t.route] || {})[t.dir];
  const blk = String(block);
  // This block's real trips only: a trip after its pick pull-in never runs.
  const trips = allTrips.filter(t => t.block === blk && !isPhantomTrip(t, pullIns)).sort((a, b) => a.s - b.s);
  const byBlock = new Map(buses.map(b => [String(b.BlockID || ''), b]));
  const live = byBlock.get(blk);
  // Today's bus for a block from the pairing, '' if none. busyAt: was that
  // block mid-trip on `route` at epoch `ts`? (then another route's sighting
  // of the same block number is a different bus)
  const pairedBus = (b, route) => {
    if (!knownBus) return '';
    const own = allTrips.filter(t => t.block === b && t.route === route);
    const busyAt = ts => {
      const m = nowMin - (Date.now() - ts) / 60000;
      return own.some(t => m >= t.s + 2 && m <= t.e - 2);
    };
    // Only a bus seen since this block last pulled out (pa-schedule
    // blockOutSince): never yesterday's bus on today's block.
    const since = pullOuts ? blockOutSince(pullOuts.get(b), pullIns && pullIns.get(b)) : 0;
    if (since > Date.now()) return '';
    return knownBus(b, route, busyAt, since);
  };
  let bus;

  if (live) {
    bus = { ...live };
    // Dep/Arr of the trip the bus is on: its live trip id, else the last trip
    // already started (block-tracker depArrOf).
    let t = live.trip != null ? trips.find(x => x.tripId === String(live.trip)) : null;
    if (!t) { for (const x of trips) if (x.s <= nowMin) t = x; if (!t) t = trips[0]; }
    if (t) Object.assign(bus, { _depMin: t.s, _arrMin: t.e, _firstStop: t.first, _lastStop: t.last });
  } else {
    const st = blockStatus(trips, nowMin);
    if (!st || st.state === 'done') return { BlockID: blk, _scheduledOnly: true, _schedState: 'done', _doneForDay: true, _leaderTimeline: timeline() };
    const trip = st.state === 'in_service' ? st.trip : st.next;
    // Not out yet: none of its trips has run and its pull-out (the pick's, else
    // its first trip) is still ahead. Then no bus can be today's, and the card
    // says so instead of "may not be in service".
    const outAt = pullOuts && pullOuts.get(blk) != null ? pullOuts.get(blk) : trip.s;
    const notOutYet = st.state === 'not_started' && nowMin < outAt;
    bus = {
      BlockID: blk, VehicleID: notOutYet ? '' : pairedBus(blk, trip.route), late: '0',
      _notOutYet: notOutYet, _outAtMin: outAt, _outIsPullOut: !!(pullOuts && pullOuts.get(blk) != null),
      Direction: dirName(trip) || ('Direction ' + trip.dir),
      _scheduledOnly: true,
      _schedState: st.state === 'in_service' ? 'in_service_expected' : st.state === 'layover' ? 'layover_expected' : 'not_started',
      _overdueMin: 0,
      _depMin: trip.s, _arrMin: trip.e, _firstStop: trip.first, _lastStop: trip.last
    };
  }
  bus._leaderTimeline = timeline();
  return bus;

  // Past / current / next leaders across this block's day
  // (block-tracker annotateLeaderTimeline).
  function timeline() {
    if (!trips.length) return null;
    const busNoOf = (b, route) => {
      const l = byBlock.get(b);
      const v = l ? String(l.VehicleID || '').trim() : pairedBus(b, route);
      return v && v !== '0' ? v : 'n/a';
    };
    const liveStatusOf = b => {
      const l = byBlock.get(b);
      if (!l) return 'Scheduled';
      const late = parseInt(l.late) || 0;
      if (late === 0) return 'On time';
      if (late < 0) return Math.abs(late) + 'm early';
      return '+' + late + 'm late';
    };
    let curIdx = trips.findIndex(t => nowMin >= t.s && nowMin <= t.e);
    if (curIdx < 0) curIdx = trips.findIndex(t => t.s > nowMin);
    if (curIdx < 0) curIdx = trips.length - 1;
    const past = [], next = []; let current = null;
    trips.forEach((t, i) => {
      const ldr = leaderForTrip(allTrips, blk, t, pullIns);
      if (!ldr) return;
      const row = {
        blk: ldr.block,
        dir: dirShort(dirName(t) || String(t.dir)),
        start: ldr.s,
        bus: busNoOf(ldr.block, ldr.route),
        status: i < curIdx ? 'Past' : i > curIdx ? 'Scheduled' : liveStatusOf(ldr.block)
      };
      if (i < curIdx) past.push(row); else if (i === curIdx) current = row; else next.push(row);
    });
    const dedupe = arr => { const seen = new Set(); return arr.filter(r => !seen.has(r.blk) && seen.add(r.blk)); };
    return { past: dedupe(past), current, next: dedupe(next) };
  }
}

// ---- card HTML (block-tracker buildNode) ---------------------------------------

function depArrLineHtml(bus, showDir) {
  if (bus._depMin == null && bus._arrMin == null) return '';
  const lead   = showDir ? '<span class="da-dir">' + esc(dirShort(bus.Direction)) + '</span>' : '';
  const spacer = showDir ? '<span class="da-dir-spacer"></span>' : '';
  const depTxt = bus._depMin != null ? 'Dep: ' + fmtClock(bus._depMin) : '';
  const arrTxt = bus._arrMin != null ? 'Arr: ' + fmtClock(bus._arrMin) : '';
  const fromLoc = bus._firstStop ? '<span class="da-loc">from: ' + esc(bus._firstStop) + '</span>' : '';
  const toLoc   = bus._lastStop  ? '<span class="da-loc">at: '   + esc(bus._lastStop)  + '</span>' : '';
  let h = '<div class="deparr">';
  h += '<div class="da-line">' + lead   + '<span class="da-t">' + depTxt + '</span>' + fromLoc + '</div>';
  h += '<div class="da-line">' + spacer + '<span class="da-t">' + arrTxt + '</span>' + toLoc   + '</div>';
  return h + '</div>';
}

function paddleRowHtml(rec) {
  if (!rec || (!rec.poTime && !rec.piTime)) return '';
  let h = '<div class="paddle-row"><span class="po-pi">';
  if (rec.poTime) h += 'PO ' + esc(rec.poTime);
  if (rec.poTime && rec.piTime) h += ' · ';
  if (rec.piTime) h += 'PI ' + esc(rec.piTime);
  return h + '</span></div>';
}

function runChipsHtml(rec) {
  if (!rec || !rec.runs.length) return '';
  let h = '';
  for (const r of rec.runs) {
    if (r.link) h += '<a class="run-chip" href="' + esc(r.link) + '" target="_blank" rel="noopener">RUN ' + esc(r.runno) + '</a>';
    else        h += '<span class="run-chip nolink">RUN ' + esc(r.runno) + '</span>';
  }
  return h;
}

function leaderTimelineHtml(bus, rec, open) {
  const tl = bus._leaderTimeline;
  const isLive = !bus._scheduledOnly && !bus._isLayover;
  const hasTL  = !!(tl && (tl.past.length || tl.current || tl.next.length));
  const runChips = runChipsHtml(rec);
  const seat = seatInfo(bus.estimated_seat_availability);
  const seatHtml = (isLive && seat.show)
    ? '<span class="seat-tag ' + seat.c + '">' + ICONS.seat + ' ' + seat.t + '</span>' : '';
  if (!hasTL && !seatHtml && !runChips) return '';
  const row = r =>
    '<div class="tl-row">' +
      '<span class="tl-dir">' + esc(r.dir) + '</span>' +
      '<span class="tl-time">' + fmtClock(r.start) + '</span>' +
      '<span class="tl-blk">Blk ' + esc(r.blk) + '</span>' +
      '<span class="tl-bus">Bus ' + esc(r.bus) + '</span>' +
      '<span class="tl-status">' + esc(r.status) + '</span>' +
    '</div>';
  let inner = '';
  if (hasTL) {
    if (tl.past.length) inner += '<div class="tl-head">Past leaders</div>'   + tl.past.map(row).join('');
    if (tl.current)     inner += '<div class="tl-head">Current leader</div>' + row(tl.current);
    if (tl.next.length) inner += '<div class="tl-head">Next leaders</div>'   + tl.next.map(row).join('');
  } else {
    inner = '<div class="tl-head">No leader info</div>';
  }
  return '<div class="leader-tl' + (open ? ' open' : '') + '">' +
           '<div class="leader-sum">' + runChips + seatHtml +
             '<span class="lead-toggle" data-lead-toggle role="button" tabindex="0">Leaders <span class="arrow">▸</span></span>' +
           '</div>' +
           '<div class="leader-body' + (open ? '' : ' hidden') + '">' + inner + '</div>' +
         '</div>';
}

/** One tracker scorecard. `rec` = block paddle record (PO/PI, run chips).
 *  `note`: one line of status text at the very bottom of the card, under the
 *  RUN chips and the Leaders button (My Run: "Not in service yet - pulls out
 *  at 4:28 AM"). */
export function busCardHtml(bus, { rec = null, leadersOpen = false, note = '' } = {}) {
  const end = (note ? '<div class="node-note">' + esc(note) + '</div>' : '') + '</div></div>';
  const late = parseInt(bus.late) || 0;
  let lateClass, lateText;
  if (late === 0)          { lateClass = 'ontime'; lateText = 'On Time'; }
  else if (late < 0)       { lateClass = 'early';  lateText = Math.abs(late) + 'm early'; }
  else if (late < LATE_BAD){ lateClass = 'mild';   lateText = '+' + late + 'm late'; }
  else                     { lateClass = 'bad';    lateText = '+' + late + 'm late'; }

  const blk     = bus.BlockID || bus.label || '—';
  const vidRaw  = String(bus.VehicleID || bus.label || '').trim();
  const vid     = vidRaw && vidRaw !== '0' ? vidRaw : '';
  const stop    = bus.next_stop_name || '';
  const isSched = !!bus._scheduledOnly;
  const nodeRole = isSched ? 'scheduled' : 'other';
  const arrowDir = /west|north/i.test(bus.Direction || '') ? 'up' : 'down';

  let h = '<div class="bus-node ' + nodeRole + ' ' + arrowDir + '">';
  h += '<div class="node-card">';
  h += '<div class="node-row1">';
  h += '<span class="block-num">' + esc(String(blk)) + '</span>';
  if (vid) h += '<span class="vehicle-num">' + ICONS.bus + ' ' + esc(vid) + '</span>';
  else if (isSched) h += '<span class="vehicle-num unknown">' + ICONS.bus + ' Bus# pending</span>';
  else h += '<span class="vehicle-num">' + ICONS.bus + ' —</span>';
  if (!isSched) {
    if (bus._notTracking) h += '<span class="not-tracking-tag">NOT TRACKING</span>';
    else h += '<span class="late-tag ' + lateClass + '">' + lateText + '</span>';
  }
  h += '</div>';

  if (isSched) {
    if (bus._doneForDay) {
      h += '<div class="sched-only-row"><span class="sched-only-badge">DONE FOR DAY</span></div>';
      h += paddleRowHtml(rec);
      h += leaderTimelineHtml(bus, rec, leadersOpen);
      return h + end;
    }
    const served = bus._schedState === 'layover_expected';
    let badgeCls = 'sched-only-badge';
    if (bus._schedState === 'in_service_expected') badgeCls += ' expected';
    if (served) badgeCls += ' served';
    h += '<div class="sched-only-row"><span class="' + badgeCls + '">SCHD ' + esc(dirShort(bus.Direction)) + ':</span>';
    if (bus._overdueMin > 0) h += '<span class="sched-only-detail overdue">OVERDUE ' + bus._overdueMin + 'm</span>';
    h += '</div>';
    h += depArrLineHtml(bus, false);
    h += paddleRowHtml(rec);
    h += leaderTimelineHtml(bus, rec, leadersOpen);
    return h + end;
  }

  h += depArrLineHtml(bus, true);
  if (stop) h += '<div class="node-bottom"><span class="stop-name">→ ' + esc(stop) + '</span></div>';
  h += paddleRowHtml(rec);
  h += leaderTimelineHtml(bus, rec, leadersOpen);
  return h + end;
}

// ---- scorecards (block-tracker live pages) ---------------------------------------
// My Run's leader cards in the live pages' scorecard format: the trip's
// number for the day ("98-WB", coloured by leader / follower), the run
// number + day as one paddle button, the trip times, where the bus is (➜ next
// stop, or ⚓ where it is parked with the countdown to its next scheduled
// departure ➜ that trip's number), then trips left, bus and block. Styles in
// assets/pa-scorecard.css; wrap the cards in <div class="at-list pa-sc">.

const DAY_LABEL = { weekday: 'Weekday', saturday: 'Saturday', sunday: 'Sunday' };

/** "12:05", "1:02:05", then "DUE +2:13" once the time has passed. */
export function dueText(dueMs) {
  const d = Math.round((dueMs - Date.now()) / 1000);
  const f = x => { const h = Math.floor(x / 3600), m = Math.floor(x % 3600 / 60), sec = x % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0'); };
  return d > 0 ? f(d) : 'DUE +' + f(-d);
}

/** Keeps every [data-due-ms] countdown on the page ticking (started once). */
let dueTicker = null;
export function startDueTicker() {
  if (dueTicker) return;
  dueTicker = setInterval(() => {
    document.querySelectorAll('[data-due-ms]').forEach(el => {
      const ms = parseInt(el.dataset.dueMs);
      el.textContent = dueText(ms);
      el.classList.toggle('late', ms <= Date.now());
    });
  }, 1000);
}

// A trip's place in its route + direction for the whole day (1, 2, 3 …),
// over every block, finished trips too, so it never changes.
function tripNumber(allTrips, t, pullIns) {
  const seen = new Set();
  const list = allTrips.filter(x => x.route === t.route && x.dir === t.dir && !isPhantomTrip(x, pullIns))
    .filter(x => { const k = x.block + '|' + x.s; return !seen.has(k) && seen.add(k); })
    .sort((a, b) => a.s - b.s || a.e - b.e || String(a.block).localeCompare(String(b.block)));
  const i = list.findIndex(x => x.block === t.block && x.s === t.s);
  return i < 0 ? 0 : i + 1;
}

// The run on the block when trip `t` starts: the latest piece to start by
// then, else the first. Pick times are clock minutes; owl trips run past 24:00.
function runForTrip(rec, t) {
  if (!rec || !rec.runs || !rec.runs.length) return null;
  const at = m => (m < 4 * 60 && t.s >= 1440 ? m + 1440 : m);
  let best = null;
  for (const r of rec.runs) if (isFinite(r.sortMin) && at(r.sortMin) <= t.s + 1 && (!best || at(r.sortMin) > at(best.sortMin))) best = r;
  return best || rec.runs[0];
}

export function scorecardHtml({ model, block, allTrips, buses, nowMin, dirNamesByRoute = {}, pullIns = null, rec = null, dayType = 'weekday', note = '' }) {
  const blk = String(block);
  const trips = allTrips.filter(t => t.block === blk && !isPhantomTrip(t, pullIns)).sort((a, b) => a.s - b.s);
  const live = !model._scheduledOnly;
  let t = live && model.trip != null ? trips.find(x => x.tripId === String(model.trip)) : null;
  if (!t && model._depMin != null) t = trips.find(x => x.s === model._depMin);
  if (!t) return '';
  const dirOf = x => (dirNamesByRoute[x.route] || {})[x.dir] || String(x.dir);
  const ds = esc(dirShort(dirOf(t)));
  const waiting = live && t.s > nowMin && (parseInt(model.next_stop_sequence) || 0) <= 1;
  const ghost = !live && model._schedState === 'in_service_expected';
  const layover = waiting || (!live && model._schedState === 'layover_expected');
  const notOut = !live && model._schedState === 'not_started';
  const inService = live && !waiting;
  const nth = tripNumber(allTrips, t, pullIns);
  const numTag = cls => '<span class="at-nth' + (cls ? ' ' + cls : '') + '">#' + (nth || '?') + '</span>';

  // Leader / follower colour: the buses online on this route and direction.
  let cls = ghost || notOut ? 'gray' : 'green';
  if (inService) {
    const byTrip = new Map(allTrips.map(x => [x.tripId, x]));
    const online = [];
    for (const b of buses || []) {
      const bt = b.trip != null ? byTrip.get(String(b.trip)) : null;
      if (!bt || bt.route !== t.route || bt.dir !== t.dir || bt.s > nowMin) continue;
      online.push({ blk: String(b.BlockID || ''), n: tripNumber(allTrips, bt, pullIns), pos: parseInt(b.next_stop_sequence) || 0 });
    }
    online.sort((a, b) => a.n - b.n);
    const i = online.findIndex(x => x.blk === blk);
    if (i >= 0) {
      const me = online[i], lead = online[i - 1], fol = online[i + 1];
      cls = fol && fol.pos > me.pos ? 'red' : lead && me.pos > lead.pos ? 'yellow' : 'green';
    }
  }

  const day = DAY_LABEL[dayType] || 'Weekday';
  const run = runForTrip(rec, t);
  const inner = '<span class="prc-num">' + esc(run ? run.runno : '—') + '</span><span class="prc-day">' + esc(day) + '</span>';
  const runBtn = run && run.link ? '<a class="at-runbtn" href="' + esc(run.link) + '" target="_blank" rel="noopener">' + inner + '</a>'
                                 : '<span class="at-runbtn nolink">' + inner + '</span>';
  let h = '<div class="prc day-' + day + (inService ? ' at-now' : '') + '">';
  h += '<div class="prc-head"><div class="prc-head-top">' + (layover ? '<span class="at-nth lay">LAYOVER</span>' : numTag(cls)) + runBtn + '</div>';
  h += '<div class="prc-head-bottom"><span class="at-time">' + (inService ? '<span class="at-tag now">IN SERVICE</span>' : '') +
       fmtClock(t.s) + ' – ' + fmtClock(t.e) + '</span><div class="prc-routes">' + esc(t.route) + '</div></div></div>';
  if (inService && model.next_stop_name) {
    const late = parseInt(model.late) || 0;
    const lt = late === 0 ? ['ontime', 'On Time'] : late < 0 ? ['early', Math.abs(late) + 'm early'] : [late < LATE_BAD ? 'mild' : 'bad', '+' + late + 'm late'];
    h += '<div class="at-loc"><span class="at-loc-txt"><span class="at-ico">➜</span> ' + esc(model.next_stop_name) + '</span>' +
         (model._notTracking ? '<span class="not-tracking-tag">NOT TRACKING</span>' : '<span class="late-tag ' + lt[0] + '">' + lt[1] + '</span>') + '</div>';
  }
  if (layover) {
    // Parked where its last trip ended (any route), else where the next one leaves.
    const prev = allTrips.filter(x => x.block === blk && x.e <= t.s && !isPhantomTrip(x, pullIns)).sort((a, b) => b.e - a.e)[0];
    const at = (prev && prev.last) || t.first || 'At terminal';
    const dueMs = Date.now() + (t.s - nowMin) * 60000;
    h += '<div class="at-loc"><span class="at-loc-txt">⚓ ' + esc(at) + '</span><span class="at-next"><span class="at-due" data-due-ms="' +
         Math.round(dueMs) + '">' + dueText(dueMs) + '</span><span class="at-arrow at-ico">➜</span>' + numTag('next') + '</span></div>';
  }
  const left = new Set(trips.filter(x => x.route === t.route && x.dir === t.dir && x.s >= t.s).map(x => x.s)).size || 1;
  const vRaw = String(model.VehicleID || '').trim();
  const vid = vRaw && vRaw !== '0' ? vRaw : '';
  h += '<div class="at-trips"><span class="at-dir' + (inService ? ' cur' : '') + '">' + left + ' ' + ds + '</span>' +
       (vid ? '<span class="at-bus">' + ICONS.bus + ' ' + esc(vid) + '</span>' : '<span class="at-bus unknown">' + ICONS.bus + ' Bus# pending</span>') +
       '<span class="at-blk">Blk #: ' + esc(blk) + '</span>' +
       (live ? loadTagHtml(model.estimated_seat_availability) : '') + '</div>';
  if (note) h += '<div class="at-note">' + esc(note) + '</div>';
  return h + '</div>';
}

// ---- detour cards (detours.html renderDetours) --------------------------------

export function detourCardsHtml(cards) {
  return cards.map(detour => `
      <div class="detour-card">
        <div class="detour-header">
          <div class="route-badge">Route ${esc(detour.routeId)}</div>
          <div class="detour-title">${esc(detour.reason || 'Bus Route Detour')}</div>
          ${detour.direction ? `<div class="detour-direction">${esc(detour.direction)}</div>` : ''}
        </div>
        <div class="detour-body">
          ${detour.startLocation || detour.endLocation ? `
            <div class="detour-section">
              <div class="section-label">Location</div>
              <div class="section-content">
                ${detour.startLocation ? `From: ${esc(detour.startLocation)}<br>` : ''}
                ${detour.endLocation ? `To: ${esc(detour.endLocation)}` : ''}
              </div>
            </div>
          ` : ''}
          ${detour.message ? `
            <div class="detour-section">
              <div class="section-label">Details</div>
              <div class="section-content">${esc(detour.message)}</div>
            </div>
          ` : ''}
          ${detour.startDate || detour.endDate ? `
            <div class="detour-section">
              <div class="section-label">Timeline</div>
              <div class="section-content">
                ${detour.startDate ? `Start: ${esc(detour.startDate)}<br>` : ''}
                ${detour.endDate ? `End: ${esc(detour.endDate)}` : ''}
              </div>
            </div>
          ` : ''}
        </div>
      </div>`).join('');
}

export const detoursLoadingHtml = () => '<div class="loading"><div class="spinner"></div>Loading detours...</div>';
export const detoursErrorHtml = msg => '<div class="error-banner">Error: ' + esc(msg) + '</div>';
export const detoursEmptyHtml = routeLabel => `
      <div class="empty-state">
        <p>No detours found${routeLabel ? ` for Route ${esc(routeLabel)}` : ''}</p>
        <p style="font-size: 14px; color: var(--dim);">Check back later for updates</p>
      </div>`;
