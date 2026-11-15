// ==========================================================================
// Paddle App — the additional short run: district settings, the runs the
// second-run picker may offer, and the check every day save goes through.
//
// The rules themselves are pure and live in pa-resolve.js (shortRunRules,
// isShortPay, checkDayRuns). This module only fetches what they need:
// data/district-settings.json and the paddle pay of the runs on the day.
// ==========================================================================

import * as S from './pa-schedule.js';
import { shortRunRules, isShortPay, checkDayRuns, runsOverlap } from './pa-resolve.js';

let settingsP = null;

/** data/district-settings.json, or null when it can't be read. A failure is
 *  not kept, so the next call tries again. */
export function loadDistrictSettings() {
  if (!settingsP) {
    settingsP = fetch(S.PADDLE_BASE + 'district-settings.json', { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .catch(() => { settingsP = null; return null; });
  }
  return settingsP;
}

/** { allowsShortRuns, shortRunMaxPayHours, loaded } for a depot. */
export async function rulesFor(depotKey) {
  const s = await loadDistrictSettings();
  return { ...shortRunRules(s, depotKey), loaded: !!s };
}

/** The paddle run (normalised) for a run number on a date, or null. */
export async function paddleRun(depotKey, dayType, runNo, iso) {
  if (!depotKey || !runNo) return null;
  const { slug } = await S.slugFor(depotKey, iso);
  return slug ? S.getRun(slug, dayType, runNo, iso) : null;
}

/**
 * The runs the second-run picker offers: every SHORT run in the paddle for
 * `dayType` on `iso`, except `exceptRunNo` and any that overlaps one of the
 * `avoid` runs (the driver's regular run(s) - nobody works two at once),
 * earliest start first. The list's `.overlapping` says how many were left
 * out for overlapping.
 */
export async function shortRunOptions(depotKey, dayType, iso, exceptRunNo, avoid) {
  const rules = await rulesFor(depotKey);
  if (!rules.allowsShortRuns) return [];
  const { slug } = await S.slugFor(depotKey, iso);
  if (!slug) return [];
  const m = await S.loadPaddle(slug, dayType, iso);
  const out = [];
  const regs = (avoid || []).filter(Boolean);
  let overlapping = 0;
  for (const row of m.values()) {
    const run = S.normalizeRun(row, dayType);
    if (!run || String(run.runNo) === String(exceptRunNo || '')) continue;
    if (!isShortPay(run.payHours, rules)) continue;
    if (regs.some(g => runsOverlap(g, run))) { overlapping++; continue; }
    out.push(run);
  }
  out.overlapping = overlapping;
  return out.sort((a, b) => (a.reportMin ?? 9e9) - (b.reportMin ?? 9e9) || a.runNo.localeCompare(b.runNo, undefined, { numeric: true }));
}

function dayError(message) {
  const e = new Error(message);
  e.name = 'DayRunsError';
  return e;
}

/**
 * Check the day a save would leave behind and throw a DayRunsError when its
 * runs are not an allowed combination. `next` is the whole day after the
 * write (the stored day with the new fields merged over it).
 *
 * A day with one run in a district without short runs needs no download.
 * When the settings or paddle can't be read, a day WITH a short run is
 * refused (it can't be proven short), a day without one is let through so
 * an ordinary edit still saves with poor signal.
 */
export async function assertDayRuns(date, next) {
  const d = next || {};
  const sr = d.shortRun && d.shortRun.runNo ? d.shortRun : null;
  const working = (d.status || (d.runNo ? 'scheduled' : 'off')) === 'scheduled' && !!d.runNo;
  if (sr && !working) throw dayError('A short run can’t be the only run of the day. Enter the regular run first.');
  if (!working) return;
  const s = await loadDistrictSettings();
  if (!s) {
    if (sr) throw dayError('Can’t check the short run right now (district settings did not load). Try again with signal.');
    return;
  }
  const rules = shortRunRules(s, d.depotKey);
  if (!rules.allowsShortRuns && !sr) return;
  const dt = d.runDayType || d.dayType;
  const [main, short] = await Promise.all([
    paddleRun(d.depotKey, dt, d.runNo, date).catch(() => null),
    sr ? paddleRun(d.depotKey, sr.runDayType || dt, sr.runNo, date).catch(() => null) : null
  ]);
  const msg = checkDayRuns({
    runNo: d.runNo, payHours: main ? main.payHours : null, run: main, dayType: d.dayType || null,
    shortRun: sr ? { runNo: sr.runNo, payHours: short ? short.payHours : null, run: short, runDayType: sr.runDayType || dt } : null
  }, rules);
  if (msg) throw dayError(msg);
}

/**
 * The same check for a pick (pattern): every working slot is one day.
 * A short run sits on the weekday slots ({ runNo, shortRun: { runNo,
 * runDayType: 'weekday' } }). Each slot is checked against the paddle of
 * its own schedule, on the first such day of the pick.
 */
export async function assertPatternRuns(p) {
  const days = (p && p.days) || {};
  const slots = Object.keys(days).filter(k => days[k] && days[k].runNo);
  const anyShort = slots.some(k => days[k].shortRun && days[k].shortRun.runNo);
  if (!slots.length) return;
  const s = await loadDistrictSettings();
  if (!s) {
    if (anyShort) throw dayError('Can’t check the short run right now (district settings did not load). Try again with signal.');
    return;
  }
  const rules = shortRunRules(s, p.depotKey);
  if (!rules.allowsShortRuns && !anyShort) return;
  const from = p.effectiveFrom || S.todayIso();
  const seen = new Map();
  for (const k of slots) {
    const slot = days[k], idx = +k;
    const dt = idx === 0 ? 'sunday' : idx === 6 ? 'saturday' : 'weekday';
    const date = S.addDays(from, ((idx - S.dowOf(from)) % 7 + 7) % 7);
    const sr = slot.shortRun && slot.shortRun.runNo ? slot.shortRun : null;
    const key = dt + '|' + slot.runNo + '|' + (sr ? sr.runNo : '');
    if (seen.has(key)) continue;
    const [main, short] = await Promise.all([
      paddleRun(p.depotKey, dt, slot.runNo, date).catch(() => null),
      sr ? paddleRun(p.depotKey, sr.runDayType || dt, sr.runNo, date).catch(() => null) : null
    ]);
    const msg = checkDayRuns({
      runNo: slot.runNo, payHours: main ? main.payHours : null, run: main, dayType: dt,
      shortRun: sr ? { runNo: sr.runNo, payHours: short ? short.payHours : null, run: short, runDayType: sr.runDayType || dt } : null
    }, rules);
    seen.set(key, true);
    if (msg) throw dayError(S.DAY_NAMES[idx] + ': ' + msg);
  }
}

/** The schedule a pattern slot (0 = Sunday .. 6 = Saturday) runs. */
export const slotDayType = k => (+k === 0 ? 'sunday' : +k === 6 ? 'saturday' : 'weekday');

/**
 * Put the pick's short runs on its slots: a weekday short run on every
 * Monday-Friday slot, a Saturday one on Saturday, a Sunday one on Sunday.
 * `shorts` = { weekday, saturday, sunday } (run # or ''), or a run # alone
 * for the weekday one. Slots without a run, or whose kind of day has no
 * short run, carry none.
 */
export function withShortRun(days, shorts) {
  const by = typeof shorts === 'object' && shorts ? shorts : { weekday: shorts || '' };
  const out = {};
  for (const [k, v] of Object.entries(days || {})) {
    const slot = { ...v };
    delete slot.shortRun;
    const dt = slotDayType(k), no = by[dt];
    if (no && slot.runNo) slot.shortRun = { runNo: String(no), runDayType: dt };
    out[k] = slot;
  }
  return out;
}

/** The pick's short runs by kind of day: { weekday, saturday, sunday } ('' = none). */
export function shortRunsOf(p) {
  const d = (p && p.days) || {};
  const out = { weekday: '', saturday: '', sunday: '' };
  for (const k of ['1', '2', '3', '4', '5', '6', '0']) {
    const dt = slotDayType(k);
    if (!out[dt] && d[k] && d[k].shortRun && d[k].shortRun.runNo) out[dt] = String(d[k].shortRun.runNo);
  }
  return out;
}

/** The weekday short run a pattern carries, or ''. */
export const shortRunOf = p => shortRunsOf(p).weekday;
