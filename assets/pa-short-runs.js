// ==========================================================================
// Paddle App — the additional short run: district settings, the runs the
// second-run picker may offer, and the check every day save goes through.
//
// The rules themselves are pure and live in pa-resolve.js (shortRunRules,
// isShortPay, checkDayRuns). This module only fetches what they need:
// data/district-settings.json and the paddle pay of the runs on the day.
// ==========================================================================

import * as S from './pa-schedule.js';
import { shortRunRules, isShortPay, checkDayRuns } from './pa-resolve.js';

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
async function paddleRun(depotKey, dayType, runNo, iso) {
  if (!depotKey || !runNo) return null;
  const { slug } = await S.slugFor(depotKey, iso);
  return slug ? S.getRun(slug, dayType, runNo, iso) : null;
}

/**
 * The runs the second-run picker offers: every SHORT run in the paddle for
 * `dayType` on `iso`, except `exceptRunNo`, earliest start first.
 */
export async function shortRunOptions(depotKey, dayType, iso, exceptRunNo) {
  const rules = await rulesFor(depotKey);
  if (!rules.allowsShortRuns) return [];
  const { slug } = await S.slugFor(depotKey, iso);
  if (!slug) return [];
  const m = await S.loadPaddle(slug, dayType, iso);
  const out = [];
  for (const row of m.values()) {
    const run = S.normalizeRun(row, dayType);
    if (!run || String(run.runNo) === String(exceptRunNo || '')) continue;
    if (isShortPay(run.payHours, rules)) out.push(run);
  }
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
    runNo: d.runNo, payHours: main ? main.payHours : null,
    shortRun: sr ? { runNo: sr.runNo, payHours: short ? short.payHours : null } : null
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
      runNo: slot.runNo, payHours: main ? main.payHours : null,
      shortRun: sr ? { runNo: sr.runNo, payHours: short ? short.payHours : null } : null
    }, rules);
    seen.set(key, true);
    if (msg) throw dayError(S.DAY_NAMES[idx] + ': ' + msg);
  }
}

/** Put `shortRunNo` on every weekday slot of a pattern's days (null removes it). */
export function withShortRun(days, shortRunNo) {
  const out = {};
  for (const [k, v] of Object.entries(days || {})) {
    const slot = { ...v };
    delete slot.shortRun;
    if (shortRunNo && +k >= 1 && +k <= 5 && slot.runNo) slot.shortRun = { runNo: String(shortRunNo), runDayType: 'weekday' };
    out[k] = slot;
  }
  return out;
}

/** The short run a pattern's weekday slots carry, or ''. */
export function shortRunOf(p) {
  const d = (p && p.days) || {};
  for (const k of ['1', '2', '3', '4', '5']) if (d[k] && d[k].shortRun && d[k].shortRun.runNo) return String(d[k].shortRun.runNo);
  return '';
}
