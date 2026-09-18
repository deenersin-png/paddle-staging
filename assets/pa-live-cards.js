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

import { blockStatus, isPhantomTrip } from './pa-schedule.js';

const LATE_BAD = 6;

export const ICONS = {
  bus:  '<svg viewBox="0 0 24 24"><path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z"/></svg>',
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
  let best = null;
  for (const t of allTrips) {
    if (t.block === String(block) || t.route !== trip.route || t.dir !== trip.dir) continue;
    if (isPhantomTrip(t, pullIns)) continue;
    if (t.s < trip.s && (!best || t.s > best.s)) best = t;
  }
  return best;
}

/**
 * A tracker-shaped bus for `block`: the live vehicle when TransitView has
 * it, otherwise a scheduled-only placeholder drawn from GTFS, exactly as
 * block-tracker.html's mergeScheduledBlocks builds them.
 */
export function buildBusModel({ block, allTrips, buses, nowMin, dirNamesByRoute = {}, pullIns = null }) {
  const dirName = t => (dirNamesByRoute[t.route] || {})[t.dir];
  const blk = String(block);
  // This block's real trips only: a trip after its pick pull-in never runs.
  const trips = allTrips.filter(t => t.block === blk && !isPhantomTrip(t, pullIns)).sort((a, b) => a.s - b.s);
  const byBlock = new Map(buses.map(b => [String(b.BlockID || ''), b]));
  const live = byBlock.get(blk);
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
    bus = {
      BlockID: blk, VehicleID: '', late: '0',
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
    const busNoOf = b => {
      const l = byBlock.get(b);
      const v = l ? String(l.VehicleID || '').trim() : '';
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
        bus: busNoOf(ldr.block),
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

/** One tracker scorecard. `rec` = block paddle record (PO/PI, run chips). */
export function busCardHtml(bus, { rec = null, leadersOpen = false } = {}) {
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
      return h + '</div></div>';
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
    return h + '</div></div>';
  }

  h += depArrLineHtml(bus, true);
  if (stop) h += '<div class="node-bottom"><span class="stop-name">→ ' + esc(stop) + '</span></div>';
  h += paddleRowHtml(rec);
  h += leaderTimelineHtml(bus, rec, leadersOpen);
  return h + '</div></div>';
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
