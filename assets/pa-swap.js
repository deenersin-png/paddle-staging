// ==========================================================================
// Paddle App — swap rules, with nothing around them.
//
// The Swap board only CONNECTS operators. It never approves anything: two
// operators who agree still arrange the official swap with the dispatcher.
// So everything here is advice — "this fits your week", "this breaks the
// 8-hour rest rule" — and never a gate the dispatcher relies on.
//
// Pure: no Firebase, no DOM, no clock beyond the `today` a caller passes in.
// Minutes follow pa-schedule's run model: reportMin / finishMin are minutes
// from midnight of the run's date, and finishMin can pass 1440 when a run
// ends after midnight. assets/tests/swap.test.mjs pins every rule here.
//
// ---- the data model (Firestore) ------------------------------------------
//
// swapOffers/{offerId}                     PUBLIC read, signed-in writes
//   v, kind ('give' | 'dayoff'), status ('open' | 'matched' | 'arranged' | 'cancelled' | 'hidden')
//   posterUid, posterName                  display name only, never email
//   depotKey, depotLabel                   'callowhillb', 'Callowhill Bus'
//   seasonId, seasonLabel                  the picking the run belongs to
//   weekStart                              the Sunday of the one work week
//   give: RunCard                          the poster's run being offered
//   wants: [{ type:'day', date } | { type:'same' } | { type:'shift', shift }]
//                                          'same' = any other run that day, inside
//                                          prefs' time window ('shift' is older offers)
//   prefs: { flexible, excludeRoutes[], earliestMin, latestMin, note }
//   posterBusy: { date: [reportMin, finishMin] }   the poster's working days,
//                                          times only, Saturday before to the
//                                          Sunday after — so the OTHER side of
//                                          the rest rule can be checked without
//                                          reading the poster's private schedule
//   expiresOn                              earliest date in the offer; gone after it
//   startsAtMs                             when the offered run starts on the real clock
//                                          (a night liner: the evening before its date);
//                                          unless arranged, the offer is deleted
//                                          CUTOFF_MIN before then
//   matchedUid, matchedName                set when the poster picks someone
//   reportCount                            server-maintained (functions/)
//   createdAt, updatedAt
//
// swapOffers/{offerId}/interest/{uid}      poster + that operator only
//   uid, name, run: RunCard | null, wantIndex, color, note, createdAt
//
// swapOffers/{offerId}/contact/{uid}       readable by the two matched people only
//   name, phone, email
//
// swapReports/{autoId}                     create by signed-in; read by admins
//   offerId, reporterUid, reason, note, createdAt
//
// users/{uid}/swapBlocks/{otherUid}        owner only: { name, createdAt }
// users/{uid}/devices/{deviceId}           owner only: { fcmToken, platform, ... }
//
// RunCard = { date, dayType, runNo, routeLabel, routes[], owl, reportMin,
//             finishMin, payHours, swing }
// ==========================================================================

import { addDays, dowOf, weekStartOf, fmtClock, minToMs, DAY_NAMES, DAY_SHORT, daysBetween } from './pa-schedule.js';

export const OFFER_VERSION = 1;

/** Minimum rest between two runs, checked for BOTH operators. */
export const MIN_REST_MIN = 8 * 60;

/** How many weeks ahead an offer can be posted, counting this one: only the
 *  current Sunday-to-Saturday week. */
export const WEEKS_AHEAD = 1;

/** No offer for a run that starts within this many minutes (or has started). */
export const CUTOFF_MIN = 120;
export const CUTOFF_TEXT = "You can't post a swap for today's run within two hours of its start time.";

export const SHIFTS = { early: 'Early', mid: 'Midday', late: 'Late', night: 'Night' };

/** Pseudo-route for the night liners (paddles label them "L1 OWL"). */
export const OWL = 'OWL';

export const REPORT_REASONS = {
  fake: 'Not a real run / fake offer',
  rude: 'Rude or abusive',
  spam: 'Spam or selling',
  other: 'Something else'
};

// ---- week rule ------------------------------------------------------------
// A swap lives inside ONE work week, Sunday through Saturday (pay week starts
// Sunday, see pa-store WEEK_STARTS_ON). Current or future weeks only, never a
// past day.

export const weekOf = iso => weekStartOf(iso);
export const weekDates = weekStart => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
export const sameWeek = (a, b) => weekOf(a) === weekOf(b);

/** Sundays an offer may be posted for: this week and the next WEEKS_AHEAD - 1. */
export function weekChoices(today, n = WEEKS_AHEAD) {
  const w0 = weekOf(today);
  return Array.from({ length: n }, (_, i) => addDays(w0, 7 * i));
}

/** Days of a week that are still open for an offer (today counts). */
export const openDates = (weekStart, today) => weekDates(weekStart).filter(d => d >= today);

/** Every date the offer depends on. */
export function offerDates(offer) {
  const out = new Set([offer.give && offer.give.date].filter(Boolean));
  (offer.wants || []).forEach(w => { if (w.type === 'day' && w.date) out.add(w.date); });
  return [...out].sort();
}

/** The offer is gone once its EARLIEST date has passed: after that day there
 *  is no complete swap left to make. */
export const expiresOnOf = offer => offerDates(offer)[0] || null;
export const isExpired = (offer, today) => !!offer.expiresOn && offer.expiresOn < today;

/** When the offered run starts, epoch ms, or null when its time is unknown.
 *  reportMin counts from the run's schedule day, so a night liner filed
 *  under Thursday starts Wednesday evening. */
export const startsAtOf = give => (give && give.date && give.reportMin != null ? minToMs(give.date, give.reportMin) : null);

/** The run has started and no swap was arranged: the offer is over. */
export function hasStarted(offer, nowMs, leadMin = 0) {
  if (!offer || offer.status === 'arranged') return false;
  const at = offer.startsAtMs != null ? offer.startsAtMs : startsAtOf(offer.give);
  return at != null && at - leadMin * 60000 <= nowMs;
}

/** The run starts within CUTOFF_MIN (or has started) and no swap was arranged:
 *  the offer is deleted (functions/lib/swap.js expireStarted; the app hides
 *  it at once). */
export const pastCutoff = (offer, nowMs) => hasStarted(offer, nowMs, CUTOFF_MIN);

/** Too late to post this run: it starts within CUTOFF_MIN or has started. */
export function runInCutoff(card, nowMs) {
  const at = startsAtOf(card);
  return at != null && at - CUTOFF_MIN * 60000 <= nowMs;
}

// ---- runs -----------------------------------------------------------------

/** The small, public slice of a pa-schedule run that an offer carries. */
export function runCard(run, date) {
  if (!run) return null;
  const labels = (run.pieces || []).map(p => p.routeLabel).filter(Boolean);
  const routeLabel = [...new Set(labels)].join(' / ') || (run.routes || []).join(' / ');
  return {
    date,
    dayType: run.dayType || '',
    runNo: String(run.runNo),
    routeLabel,
    routes: [...(run.routes || [])],
    owl: /\bOWL\b/i.test(routeLabel),
    reportMin: run.reportMin != null ? run.reportMin : null,
    finishMin: run.finishMin != null ? run.finishMin : null,
    payHours: run.payHours || 0,
    swing: !!run.swing
  };
}

/** early / mid / late / night, by report time. */
export function shiftOf(reportMin) {
  if (reportMin == null) return null;
  const m = ((reportMin % 1440) + 1440) % 1440;
  if (m < 180 || m >= 1200) return 'night';
  if (m < 600) return 'early';
  if (m < 840) return 'mid';
  return 'late';
}

/** Does the run use any excluded route (or is it a night liner when OWL is excluded)? */
export function excludedRoute(card, excludeRoutes) {
  const ex = (excludeRoutes || []).map(r => String(r).toUpperCase());
  if (!ex.length || !card) return null;
  if (ex.includes(OWL) && (card.owl || shiftOf(card.reportMin) === 'night')) return 'night liner';
  const hit = (card.routes || []).find(r => ex.includes(String(r).toUpperCase()));
  return hit || null;
}

// ---- rest rule ------------------------------------------------------------

/**
 * busy: { date: [reportMin, finishMin] } for the days someone works.
 * Returns the first pair of consecutive runs around `date` with less than
 * MIN_REST_MIN between them, as { from, to, restMin }, else null.
 */
export function restProblem(busy, date) {
  const cur = busy[date];
  if (!cur) return null;
  const prevD = addDays(date, -1), nextD = addDays(date, 1);
  const prev = busy[prevD], next = busy[nextD];
  if (prev && prev[1] != null && cur[0] != null) {
    const rest = cur[0] + 1440 - prev[1];
    if (rest < MIN_REST_MIN) return { from: prevD, to: date, restMin: rest };
  }
  if (next && next[0] != null && cur[1] != null) {
    const rest = next[0] + 1440 - cur[1];
    if (rest < MIN_REST_MIN) return { from: date, to: nextD, restMin: rest };
  }
  return null;
}

const span = c => (c ? [c.reportMin, c.finishMin] : null);

/** busy with `date` replaced by `card` (or cleared when card is null). */
function withDay(busy, date, card) {
  const b = { ...busy };
  if (card) b[date] = span(card); else delete b[date];
  return b;
}

// ---- eligibility ------------------------------------------------------------

/** Depot keys across the spring-era bare slugs ("callowhill") and later
 *  "callowhillb" (same tolerance as pa-schedule districtFor). */
export function sameDepot(a, b) {
  const n = k => String(k || '').toLowerCase().replace(/b$/, '');
  return !!a && !!b && n(a) === n(b);
}

/** One line for each failure the preferences can produce. */
function prefProblem(card, prefs) {
  const p = prefs || {};
  const ex = excludedRoute(card, p.excludeRoutes);
  if (ex) return ex === 'night liner' ? 'Poster is not taking night liners' : 'Poster is not taking route ' + ex;
  if (p.earliestMin != null && card.reportMin != null && card.reportMin < p.earliestMin) {
    return 'Starts ' + fmtClock(card.reportMin) + ', poster wants no earlier than ' + fmtClock(p.earliestMin);
  }
  if (p.latestMin != null && card.finishMin != null && card.finishMin > p.latestMin) {
    return 'Finishes ' + fmtClock(card.finishMin) + ', poster wants to finish by ' + fmtClock(p.latestMin);
  }
  return null;
}

const restText = (who, pr) => who + ' would get only ' + Math.floor(pr.restMin / 60) + 'h '
  + String(pr.restMin % 60).padStart(2, '0') + 'm rest between ' + DAY_SHORT[dowOf(pr.from)] + ' and '
  + DAY_SHORT[dowOf(pr.to)] + ' (8 h minimum)';

const dayName = iso => DAY_NAMES[dowOf(iso)];
const an = w => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w;

/**
 * Check one offer against one operator's week.
 *
 * me = {
 *   uid, depotKey,
 *   seasonFor(date) -> seasonId | null,
 *   day(date) -> { known: bool, card: RunCard | null, away?: bool }
 *                (null card = off; away = on vacation, so not free to work)
 * }
 * Every date the offer needs, plus the day before and after each, should
 * be answerable by me.day; an unknown neighbour is treated as off.
 *
 * Returns { color: 'green' | 'red' | 'yellow' | 'mine', reason, want, myCard, needs[] }.
 *  green  — at least one of the poster's options fits both weeks
 *  red    — none does; `reason` is the one to show
 *  yellow — no run on record for a day that decides it; `needs` lists the
 *           dates to ask the operator about (manual entry, then recheck)
 */
export function checkOffer(offer, me, today) {
  if (!me) return { color: 'yellow', reason: 'Sign in to check this against your schedule', needs: [] };
  if (offer.posterUid && me.uid === offer.posterUid) return { color: 'mine', reason: 'Your offer', needs: [] };
  if (offer.status && offer.status !== 'open') return { color: 'red', reason: 'This offer is no longer open', needs: [] };
  if (isExpired(offer, today)) return { color: 'red', reason: 'This offer has expired', needs: [] };
  if (!sameDepot(me.depotKey, offer.depotKey)) {
    return { color: 'red', reason: 'Different district: this offer is for ' + (offer.depotLabel || offer.depotKey), needs: [] };
  }

  const D = offer.give.date;
  const posterBusy = offer.posterBusy || {};
  const myBusyAround = dates => {
    const b = {};
    for (const d of dates) for (const x of [addDays(d, -1), d, addDays(d, 1)]) {
      const day = me.day(x);
      if (day && day.card) b[x] = span(day.card);
    }
    return b;
  };

  const results = (offer.wants || []).map((w, i) => {
    const X = w.type === 'day' ? w.date : D;
    if (!X || !sameWeek(X, D)) return { color: 'red', reason: 'Swaps stay inside one work week' };
    if (X < today) return { color: 'red', reason: dayName(X) + ' has already passed' };
    if (me.seasonFor && offer.seasonId) {
      const s = me.seasonFor(X);
      if (s && s !== offer.seasonId) return { color: 'red', reason: 'Different picking: this offer is for ' + (offer.seasonLabel || offer.seasonId) };
    }
    const dayX = me.day(X), dayD = me.day(D);

    if (w.type === 'shift' || w.type === 'same') {
      if (!dayD || !dayD.known) return { color: 'yellow', needs: [D] };
      const mine = dayD.card;
      if (!mine) return { color: 'red', reason: 'You are off ' + dayName(D) + ': this is a same-day swap' };
      if (mine.runNo === offer.give.runNo) return { color: 'red', reason: 'That is the same run' };
      const sh = shiftOf(mine.reportMin);
      if (w.type === 'same') { /* any other run that day; the time window is in prefs */ }
      else if (w.shift && w.shift !== 'any' && sh !== w.shift) {
        return { color: 'red', reason: 'Poster wants ' + an(SHIFTS[w.shift].toLowerCase()) + ' run; yours (' + mine.runNo + ') is ' + (SHIFTS[sh] || '?').toLowerCase() };
      }
      else if (w.shift === 'any' && sh === shiftOf(offer.give.reportMin)) {
        return { color: 'red', reason: 'Poster wants a different shift; yours is ' + (SHIFTS[sh] || '?').toLowerCase() + ' too' };
      }
      const pp = prefProblem(mine, offer.prefs);
      if (pp) return { color: 'red', reason: pp };
      const meAfter = withDay(myBusyAround([D]), D, offer.give);
      const r1 = restProblem(meAfter, D);
      if (r1) return { color: 'red', reason: restText('You', r1) };
      const posterAfter = withDay(posterBusy, D, mine);
      const r2 = restProblem(posterAfter, D);
      if (r2) return { color: 'red', reason: restText('The poster', r2) };
      return { color: 'green', want: i, myCard: mine };
    }

    // type 'day': you take the poster's run on D, the poster takes yours on X.
    const needs = [];
    if (!dayD || !dayD.known) needs.push(D);
    if (!dayX || !dayX.known) needs.push(X);
    if (needs.length) return { color: 'yellow', needs };
    if (dayD.away) return { color: 'red', reason: 'You are on vacation ' + dayName(D) };
    if (dayD.card) return { color: 'red', reason: 'You work ' + dayName(D) + ' (run ' + dayD.card.runNo + '): you need ' + dayName(D) + ' free to take run ' + offer.give.runNo };
    if (!dayX.card) return { color: 'red', reason: 'You are off ' + dayName(X) + ', so there is no run to trade that day' };
    if (posterBusy[X]) return { color: 'red', reason: 'The poster already works ' + dayName(X) };
    const mine = dayX.card;
    const pp = prefProblem(mine, offer.prefs);
    if (pp) return { color: 'red', reason: pp };
    const meAfter = withDay(withDay(myBusyAround([D, X]), X, null), D, offer.give);
    const r1 = restProblem(meAfter, D);
    if (r1) return { color: 'red', reason: restText('You', r1) };
    const posterAfter = withDay(withDay(posterBusy, D, null), X, mine);
    const r2 = restProblem(posterAfter, X);
    if (r2) return { color: 'red', reason: restText('The poster', r2) };
    return { color: 'green', want: i, myCard: mine };
  });

  const green = results.find(r => r.color === 'green');
  if (green) return { color: 'green', reason: 'Fits your week', want: green.want, myCard: green.myCard, needs: [] };
  const yellow = results.filter(r => r.color === 'yellow');
  if (yellow.length) {
    const needs = [...new Set(yellow.flatMap(r => r.needs))].sort();
    return { color: 'yellow', reason: 'No run on record for ' + needs.map(dayName).join(' and ') + '. Enter it to check.', needs };
  }
  const red = results.find(r => r.color === 'red');
  return { color: 'red', reason: red ? red.reason : 'Poster did not say what they want in return', needs: [] };
}

/** The guest board: everything is yellow, because nothing is known. */
export const guestCheck = () => ({ color: 'yellow', reason: 'Sign in to see if this fits your schedule', needs: [] });

// ---- building an offer --------------------------------------------------------

/**
 * The validated document for a new or edited offer, or { error } with the
 * first thing wrong. `poster.day(date)` is the same shape as in checkOffer.
 */
export function buildOffer(input, poster, today, nowMs) {
  const { kind, give, wants, prefs } = input;
  if (!give || !give.runNo || !give.date) return { error: 'Pick the day and run you are offering.' };
  const ws = weekOf(give.date);
  if (give.date < today) return { error: 'That day has already passed.' };
  if (!weekChoices(today).includes(ws)) return { error: 'Swaps are for this week only (Sunday to Saturday).' };
  if (nowMs != null && runInCutoff(give, nowMs)) return { error: CUTOFF_TEXT };
  const list = (wants || []).filter(Boolean);
  if (!list.length) return { error: 'Pick at least one thing you would take in return.' };
  for (const w of list) {
    if (w.type === 'day') {
      if (!sameWeek(w.date, give.date)) return { error: 'Both runs must be in the same week (Sunday to Saturday).' };
      if (w.date < today) return { error: dayName(w.date) + ' has already passed.' };
      if (w.date === give.date) return { error: 'For the same day, choose "Same day".' };
      const pd = poster.day(w.date);
      if (pd && pd.card) return { error: 'You already work ' + dayName(w.date) + ' (run ' + pd.card.runNo + ').' };
    } else if (w.type === 'same') {
      if (kind === 'dayoff') return { error: 'A day-off offer needs a different day.' };
    } else if (w.type === 'shift') {
      if (kind === 'dayoff') return { error: 'A day-off offer needs a different day, not a different shift.' };
      if (w.shift !== 'any' && !SHIFTS[w.shift]) return { error: 'Unknown shift.' };
    } else return { error: 'Unknown option.' };
  }
  const p = prefs || {};
  const clampMin = v => (v == null || v === '' || !Number.isFinite(+v) ? null : Math.max(0, Math.min(2879, Math.round(+v))));
  const doc = {
    v: OFFER_VERSION,
    kind: kind === 'dayoff' ? 'dayoff' : 'give',
    weekStart: ws,
    give: { ...give },
    wants: list.map(w => (w.type === 'day' ? { type: 'day', date: w.date } : w.type === 'same' ? { type: 'same' } : { type: 'shift', shift: w.shift })),
    prefs: {
      flexible: !!p.flexible,
      excludeRoutes: [...new Set((p.excludeRoutes || []).map(r => String(r).toUpperCase().trim()).filter(Boolean))].slice(0, 30),
      earliestMin: clampMin(p.earliestMin),
      latestMin: clampMin(p.latestMin),
      note: String(p.note || '').trim().slice(0, 140)
    },
    posterBusy: {}
  };
  for (let i = -1; i <= 7; i++) {
    const d = addDays(ws, i), pd = poster.day(d);
    if (pd && pd.card) doc.posterBusy[d] = span(pd.card);
  }
  doc.expiresOn = expiresOnOf(doc);
  const at = startsAtOf(doc.give);
  if (at != null) doc.startsAtMs = at;
  return { doc };
}

// ---- words ------------------------------------------------------------------

export const shortDay = iso => DAY_SHORT[dowOf(iso)];
export const longDay = dayName;
export const fmtDay = iso => DAY_SHORT[dowOf(iso)] + ' ' + Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10));

/** What the poster wants in return, as one line. */
export function describeWants(offer) {
  const days = (offer.wants || []).filter(w => w.type === 'day').map(w => w.date).sort();
  const shifts = (offer.wants || []).filter(w => w.type === 'shift').map(w => w.shift);
  const parts = [];
  if ((offer.wants || []).some(w => w.type === 'same')) parts.push('Another run on ' + shortDay(offer.give.date) + ', same day');
  if (days.length) {
    const list = days.map(shortDay).join(', ');
    parts.push(offer.prefs && offer.prefs.flexible ? 'Any run on a day I\'m off (' + list + ')' : 'Any run on ' + list);
  }
  if (shifts.length) {
    const d = shortDay(offer.give.date);
    parts.push(shifts.includes('any') ? 'A different shift on ' + d
      : an(shifts.map(s => SHIFTS[s].toLowerCase()).join(' or ')).replace(/^a/, 'A') + ' run on ' + d);
  }
  return parts.join(' · ') || '—';
}

/** Preference chips: excluded routes, time window. */
export function describePrefs(prefs) {
  const p = prefs || {}, out = [];
  if (p.excludeRoutes && p.excludeRoutes.length) out.push('No ' + p.excludeRoutes.map(r => (r === OWL ? 'night liners' : r)).join(', '));
  if (p.earliestMin != null) out.push('Start ' + fmtClock(p.earliestMin) + ' or later');
  if (p.latestMin != null) out.push('Done by ' + fmtClock(p.latestMin));
  return out;
}

/** The headline, e.g. "Tue 10/28 · run 209 for Mon". */
export function headline(offer) {
  return (offer.kind === 'dayoff' ? 'Wants ' + longDay(offer.give.date) + ' off' : 'Giving up ' + longDay(offer.give.date));
}

export const STATUS_LABELS = { open: 'Open', matched: 'Talking', arranged: 'Arranged', cancelled: 'Cancelled', hidden: 'Hidden', expired: 'Expired' };

export const DISPATCH_REMINDER = 'This app does not approve swaps. Both of you must still get the swap approved by the dispatcher before it counts.';

/** Days between two ISO dates, re-exported for the UI's "in 3 days". */
export const daysUntil = (today, iso) => daysBetween(today, iso);
