// ==========================================================================
// The pre-run email.
//
// It is read on a phone, in a depot, a minute or two before signing on, often
// one-handed. So: the run and the report time first, then the two things that
// are worth knowing before pulling out and that change by the minute — the
// bus ahead, and any detour on the routes being worked. Everything else is
// one tap away in the app.
//
// Styles are inline on every element: Gmail and Outlook drop <style> blocks.
// The palette is the app's, and the layout is a single column that survives
// being squeezed to 320 px.
// ==========================================================================

import * as S from '../vendor/pa-schedule.js';

const INK = '#0f1115', CARD = '#171a20', LINE = '#272b33';
const TEXT = '#c8cdd8', BRIGHT = '#e8ecf4', DIM = '#8a909f';
const AMBER = '#f5a623', GREEN = '#3dd68c', RED = '#ff6b6b';
const MONO = "'SF Mono',Menlo,Consolas,monospace";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "4 min late" / "2 min early" / "on time", or null when not tracking. */
export function lateText(late) {
  if (late == null) return null;
  if (late > 0) return late + ' min late';
  if (late < 0) return Math.abs(late) + ' min early';
  return 'on time';
}

/** Subject line: the three things worth seeing on a lock screen. */
export function subjectFor({ resolved, run, reportMin, minutesAway, live }) {
  // The run number is typed by the operator and this is an email HEADER, where
  // a line break would start a new header. Keep to what a run number is.
  const bits = ['Run ' + String(resolved.runNo).replace(/[^A-Za-z0-9 -]/g, '').slice(0, 12)];
  bits.push('report ' + S.fmtClock(reportMin) + (minutesAway > 0 ? ' · in ' + minutesAway + ' min' : ' · now'));
  const lt = live && live.leader ? lateText(live.leader.late) : null;
  if (lt && lt !== 'on time') bits.push('leader ' + lt);
  else if (live && live.detours.length) bits.push(live.detours.length + ' detour' + (live.detours.length === 1 ? '' : 's'));
  return bits.join(' · ');
}

function section(title, inner) {
  return `<tr><td style="padding:0 0 10px 0">
    <div style="font:600 11px ${MONO};letter-spacing:.12em;text-transform:uppercase;color:${DIM};padding:0 0 6px 2px">${esc(title)}</div>
    <div style="background:${CARD};border:1px solid ${LINE};border-radius:6px;padding:14px">${inner}</div>
  </td></tr>`;
}

function kv(k, v, colour) {
  return `<tr>
    <td style="padding:3px 12px 3px 0;font:400 13px ${SANS};color:${DIM};white-space:nowrap">${esc(k)}</td>
    <td style="padding:3px 0;font:600 14px ${MONO};color:${colour || BRIGHT}">${esc(v)}</td>
  </tr>`;
}

/**
 * The whole email. `minutesAway` is how far off the report time is right now,
 * which is what the operator actually wants confirmed at a glance.
 */
export function buildEmail({ resolved, run, reportMin, minutesAway, live, profile, appUrl }) {
  const depot = profile.depotLabel || profile.depotKey || '';
  const date = S.fmtDate(resolved.date);
  const away = minutesAway > 0 ? 'in ' + minutesAway + ' min' : 'now';

  // ---- the run
  let runRows = kv('Report', S.fmtClock(reportMin) + ' · ' + away, AMBER);
  if (run) {
    runRows += kv('Pull out', S.fmtClock(run.pullOutMin));
    runRows += kv('Finish', S.fmtClock(run.finishMin));
    if (run.payHours) runRows += kv('Pay hours', run.payHours.toFixed(1));
    if (run.pieces && run.pieces.length) {
      const pieces = run.pieces.map(p =>
        `<div style="font:600 13px ${MONO};color:${TEXT};padding:3px 0">
           <span style="color:${AMBER}">${esc(p.routeLabel)}</span>
           <span style="color:${DIM}"> · blk ${esc(p.block)} · </span>
           ${esc(S.fmtClock(p.startMin))} → ${esc(S.fmtClock(p.endMin))}
         </div>`).join('');
      runRows += `<tr><td colspan="2" style="padding:8px 0 0 0;border-top:1px solid ${LINE}">${pieces}</td></tr>`;
    }
  } else {
    runRows += `<tr><td colspan="2" style="padding:6px 0 0 0;font:400 13px ${SANS};color:${DIM}">
      This run is not in the ${esc(depot)} ${esc(resolved.dayType)} paddle, so only your own report time is known.</td></tr>`;
  }

  // ---- the bus ahead
  let leaderInner;
  if (live.leader) {
    const lt = lateText(live.leader.late);
    const colour = live.leader.late > 5 ? RED : live.leader.late > 0 ? AMBER : GREEN;
    let rows = kv('Block', live.leader.block + (live.leader.vehicleId ? ' · bus ' + live.leader.vehicleId : ''));
    if (live.leaderTrip) rows += kv('Scheduled out', S.fmtClock(live.leaderTrip.s));
    if (lt) rows += kv('Running', lt, colour);
    if (live.leader.nextStop) rows += kv('Next stop', live.leader.nextStop);
    if (live.leader.destination) rows += kv('To', live.leader.destination);
    if (live.leader.offline) {
      rows += `<tr><td colspan="2" style="padding:6px 0 0 0;font:400 13px ${SANS};color:${DIM}">
        Not sending live data right now — it may not be in service yet.</td></tr>`;
    }
    leaderInner = `<table cellpadding="0" cellspacing="0" border="0">${rows}</table>`;
  } else if (live.leaderUnavailable) {
    leaderInner = `<div style="font:400 13px ${SANS};color:${DIM}">Could not load the bus ahead of you in time — open the app to see it.</div>`;
  } else {
    leaderInner = `<div style="font:400 13px ${SANS};color:${DIM}">No bus is scheduled ahead of you in this direction.</div>`;
  }

  // ---- detours
  let detourInner;
  if (live.detours.length) {
    detourInner = live.detours.map((d, i) => `
      <div style="padding:${i ? '12px 0 0 0;border-top:1px solid ' + LINE : '0'}">
        <div style="font:600 13px ${MONO};color:${AMBER};padding-bottom:4px${i ? ';padding-top:12px' : ''}">
          Route ${esc(d.routeId)}${d.direction ? ' · ' + esc(d.direction) : ''}
        </div>
        ${d.reason ? `<div style="font:600 14px ${SANS};color:${BRIGHT};padding-bottom:4px">${esc(d.reason)}</div>` : ''}
        ${d.startLocation ? `<div style="font:400 13px ${SANS};color:${TEXT};padding-bottom:2px">From ${esc(d.startLocation)}${d.endLocation ? ' to ' + esc(d.endLocation) : ''}</div>` : ''}
        ${d.message ? `<div style="font:400 13px ${SANS};color:${TEXT};line-height:1.5">${esc(d.message)}</div>` : ''}
        ${d.startDate ? `<div style="font:400 12px ${SANS};color:${DIM};padding-top:4px">${esc(d.startDate)}${d.endDate ? ' → ' + esc(d.endDate) : ''}</div>` : ''}
      </div>`).join('');
  } else if (live.detoursFailed.length) {
    detourInner = `<div style="font:400 13px ${SANS};color:${DIM}">Could not reach SEPTA's detour feed just now — check the app before you pull out.</div>`;
  } else {
    detourInner = `<div style="font:400 13px ${SANS};color:${GREEN}">No detours on your routes.</div>`;
  }

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:${INK}">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${INK};padding:18px 12px">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px">
      <tr><td style="padding:0 0 14px 2px">
        <div style="font:700 22px ${MONO};letter-spacing:.04em;color:${BRIGHT}">RUN ${esc(resolved.runNo)}</div>
        <div style="font:400 13px ${SANS};color:${DIM};padding-top:4px">
          ${esc(date)} · ${esc(depot)}${live.routes.length ? ' · Route ' + esc(live.routes.join(' / ')) : ''}
        </div>
      </td></tr>
      ${section('Your run', `<table cellpadding="0" cellspacing="0" border="0">${runRows}</table>`)}
      ${section('The bus ahead of you · live', leaderInner)}
      ${section('Detours on your routes · live', detourInner)}
      <tr><td style="padding:4px 2px 0 2px">
        <div style="font:400 12px ${SANS};color:${DIM};line-height:1.6">
          Times here are the scheduled ones. The bus ahead is shown so you know what you are walking into — it never changes when you are due out.
        </div>
        <div style="padding-top:12px">
          <a href="${esc(appUrl)}" style="display:inline-block;font:600 12px ${MONO};letter-spacing:.06em;color:${INK};background:${AMBER};text-decoration:none;padding:10px 16px;border-radius:5px">OPEN MY RUN</a>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  return { subject: subjectFor({ resolved, run, reportMin, minutesAway, live }), html, text: plainText({ resolved, run, reportMin, away, depot, live }) };
}

/** A plain-text copy, for clients that refuse HTML. */
function plainText({ resolved, run, reportMin, away, depot, live }) {
  const out = [`RUN ${resolved.runNo} — ${S.fmtDate(resolved.date)} — ${depot}`, ''];
  out.push(`Report ${S.fmtClock(reportMin)} (${away})`);
  if (run) {
    out.push(`Pull out ${S.fmtClock(run.pullOutMin)} · finish ${S.fmtClock(run.finishMin)}`);
    (run.pieces || []).forEach(p => out.push(`  ${p.routeLabel} · blk ${p.block} · ${S.fmtClock(p.startMin)} → ${S.fmtClock(p.endMin)}`));
  }
  out.push('', 'THE BUS AHEAD OF YOU');
  if (live.leader) {
    const lt = lateText(live.leader.late);
    out.push(`  Block ${live.leader.block}${live.leader.vehicleId ? ' · bus ' + live.leader.vehicleId : ''}${lt ? ' · ' + lt : ''}`);
    if (live.leader.nextStop) out.push(`  Next stop ${live.leader.nextStop}`);
  } else if (live.leaderUnavailable) {
    out.push('  Could not load the bus ahead of you in time — open the app to see it.');
  } else {
    out.push('  No bus is scheduled ahead of you in this direction.');
  }
  out.push('', 'DETOURS');
  if (live.detours.length) {
    live.detours.forEach(d => {
      out.push(`  Route ${d.routeId}${d.direction ? ' · ' + d.direction : ''}${d.reason ? ' — ' + d.reason : ''}`);
      if (d.message) out.push(`    ${d.message}`);
    });
  } else if (live.detoursFailed.length) {
    out.push('  Could not reach the detour feed just now.');
  } else {
    out.push('  None on your routes.');
  }
  out.push('', 'Times are the scheduled ones; the bus ahead never moves them.');
  return out.join('\n');
}
