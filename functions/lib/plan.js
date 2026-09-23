// ==========================================================================
// What is this operator doing next, and what should the email tell them?
//
// The rules are NOT reimplemented here. vendor/ holds the very modules the
// site runs — pa-schedule (picks, paddles, GTFS), pa-resolve (patterns,
// assignments, vacation weeks, pay) and pa-live (TransitView, detours) — so
// an email can never disagree with what the app shows. `npm run sync` copies
// them in, and the deploy does it automatically.
//
// The one rule worth restating: the SEND TIME comes from the schedule only.
// A leader running late never moves it, exactly as on the home screen.
// ==========================================================================

import * as S from '../vendor/pa-schedule.js';
import * as R from '../vendor/pa-resolve.js';
import * as L from '../vendor/pa-live.js';

/**
 * The operator's run on `date`, or null when they are off / nothing is
 * registered / there is no time to count down to.
 *
 * Returns { resolved, run, reportMin } where reportMin is when they are due
 * to report — the day's own report time when dispatch gave them one (Slate),
 * otherwise the paddle's.
 */
export async function runOnDate(db, uid, profile, date, overrides) {
  const user = db.collection('users').doc(uid);
  const [pats, asgs, vacs] = await Promise.all([
    user.collection('patterns').get(),
    user.collection('assignments')
      .where('date', '>=', S.addDays(date, -1))
      .where('date', '<=', S.addDays(date, 1)).get(),
    user.collection('vacations').get()
  ]);

  const st = {
    patterns: pats.docs.map(d => ({ id: d.id, ...d.data() })),
    assignments: new Map(asgs.docs.map(d => [d.id, { id: d.id, ...d.data() }])),
    vacations: new Map(vacs.docs.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.id))
                                .map(d => [d.id, { id: d.id, ...d.data() }]))
  };

  const resolved = R.resolvePure(st, date, overrides);
  if (resolved.off || !resolved.runNo) return null;

  const { slug } = await S.slugFor(resolved.depotKey || profile.depotKey, date);
  const run = slug ? await S.getRun(slug, resolved.runDayType || resolved.dayType, resolved.runNo) : null;

  // A run the paddle does not know still gets an email IF the operator typed
  // a report time for it; otherwise there is no minute to send on.
  const reportMin = resolved.reportMin != null ? resolved.reportMin : (run ? run.reportMin : null);
  if (reportMin == null) return null;

  return { resolved, run, reportMin };
}

/**
 * Is the email due in this minute?
 *
 * `dayOffsetMin` is where the run's day sits relative to the current one: 0
 * for today, 1440 for tomorrow — which is how a run reporting at 12:05 AM is
 * sent for at 11:55 PM the night before. `catchUp` lets a minute that was
 * missed (a cold start, a wobble at SEPTA) still send, slightly late, rather
 * than skipping the run altogether.
 *
 * Pure, and the only thing that decides when an email goes out.
 */
export function isDue({ reportMin, nowMin, lead, dayOffsetMin = 0, catchUp = 3 }) {
  const report = dayOffsetMin + reportMin;
  const target = report - lead;
  return {
    due: nowMin >= target && nowMin <= target + catchUp,
    target,
    minutesAway: Math.max(0, report - nowMin)
  };
}

/** The piece of the run in progress at `nowMin`, else the first one. */
export function pieceAt(run, nowMin) {
  if (!run || !run.pieces || !run.pieces.length) return null;
  return run.pieces.find(p => p.startMin <= nowMin && nowMin <= p.endMin) || run.pieces[0];
}

/**
 * Live context for the email: the bus one headway ahead, and the detours on
 * the routes this run works. Both are informational — they are what the
 * operator would otherwise have to open two pages to find out.
 *
 * Never throws: an email with a missing leader is worth far more than no
 * email, so every failure degrades to null / an empty list.
 */
export async function liveContext(profile, date, run, nowMin) {
  const out = { leader: null, leaderTrip: null, myTrip: null, detours: [], detoursFailed: [], routes: [] };
  if (!run) return out;
  out.routes = run.routes || [];

  const piece = pieceAt(run, nowMin);
  if (piece && piece.block) {
    try {
      const [all, table] = await Promise.all([
        S.routeTrips(piece.routes, run.dayType),
        blockTable(profile.depotKey, date, run.dayType)
      ]);
      // Blocks that have already pulled in are skipped, same as the app.
      const lb = S.leaderBlock(all, piece.block, nowMin, S.pullInMap(table));
      if (lb) {
        out.leaderTrip = lb.trip;
        out.myTrip = lb.myTrip;
        const v = await L.vehicleForBlock(piece.routes, lb.block);
        out.leader = v || { block: String(lb.block), vehicleId: '', late: null, nextStop: '', destination: '', offline: true };
      }
    } catch (_) { /* leave the leader out */ }
  }

  try {
    const d = await L.fetchDetours(out.routes);
    out.detours = d.cards || [];
    out.detoursFailed = d.failed || [];
  } catch (_) { out.detoursFailed = out.routes; }

  return out;
}

/** Every district's block table for this day, for the pull-in times. */
async function blockTable(depotKey, date, dayType) {
  const { season } = await S.slugFor(depotKey, date);
  if (!season) return null;
  return S.loadBlockPaddles(await S.loadManifest(season), dayType);
}

/** Holiday / day-type overrides, shared by every subscriber in one run. */
export async function loadOverrides() {
  try { return (await S.loadCalendarOverrides()) || {}; } catch (_) { return {}; }
}
