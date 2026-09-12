// ==========================================================================
// Paddle App — "next run" strip for the paddle viewer.
//
// Loaded by pa-account-ui.js only after sign-in and only on pages that have
// the depot picker. Renders one line under the header: what the operator is
// doing next and a scheduled countdown, linking to home.html. Paddle-level
// only (report / pull-out / piece times) — no GTFS, so the viewer stays light.
// ==========================================================================

import * as S from './pa-schedule.js';
import * as A from './pa-assignments.js';
import { computeState, phaseLabel } from './pa-countdown.js';

let bar = null, timer = null, profile = null, overrides = {};

function css() {
  if (document.getElementById('pa-strip-css')) return;
  const st = document.createElement('style'); st.id = 'pa-strip-css';
  st.textContent = `
  .pa-strip{display:flex;align-items:center;gap:12px;padding:8px 16px;background:var(--pa-ink2);border-bottom:1px solid var(--pa-line);
    font-family:var(--pa-mono);font-size:11px;letter-spacing:.04em;color:var(--pa-mid);flex-wrap:wrap}
  .pa-strip b{color:var(--pa-amber);font-weight:600}
  .pa-strip .pa-strip-cd{color:var(--pa-bright);font-weight:600;font-variant-numeric:tabular-nums}
  .pa-strip a{margin-left:auto;color:var(--pa-mid);text-decoration:none;border:1px solid var(--pa-line2);border-radius:4px;padding:4px 10px}
  .pa-strip a:hover{color:var(--pa-amber);border-color:var(--pa-line3)}`;
  document.head.appendChild(st);
}

export async function mount(uid, prof) {
  profile = prof;
  if (!profile || !profile.depotKey) return;
  const header = document.querySelector('header, .header');
  if (!header) return;
  css();
  overrides = await S.loadCalendarOverrides().catch(() => ({}));
  if (!A.isAttached()) await A.attach(uid);
  A.onChange(render);
  if (!bar) { bar = document.createElement('div'); bar.className = 'pa-strip pa-root'; header.insertAdjacentElement('afterend', bar); }
  render();
  clearInterval(timer); timer = setInterval(render, 30000);
}

export function unmount() {
  clearInterval(timer); timer = null;
  if (bar) { bar.remove(); bar = null; }
  A.detach();
}

async function render() {
  if (!bar) return;
  const today = S.todayIso();
  let r = A.resolve(today, overrides), date = today;
  if (r.off || !r.runNo) {
    for (let i = 1; i <= 14 && (r.off || !r.runNo); i++) { date = S.addDays(today, i); r = A.resolve(date, overrides); }
  }
  if (r.off || !r.runNo) {
    bar.innerHTML = '<span>No run registered</span><a href="home.html">SET UP MY RUN →</a>';
    return;
  }
  const { slug } = await S.slugFor(r.depotKey || profile.depotKey, date);
  let run = slug ? await S.getRun(slug, r.dayType, r.runNo) : null;
  if (run && r.reportMin != null) run = { ...run, reportMin: r.reportMin };
  const nowMin = S.nowMinutes() + (date === today ? 0 : 0);
  let label, target;
  if (date !== today) { label = 'Next · ' + S.fmtDate(date); target = run && run.reportMin != null ? S.minToMs(date, run.reportMin) : null; }
  else if (run) {
    const st = computeState({ run, nowMin, tripsByBlock: new Map() });
    if (st.phase === 'done') { label = 'Done for today'; target = null; }
    else { label = phaseLabel(st); target = st.targetMin != null ? S.minToMs(date, st.targetMin) : null; }
  } else { label = 'Run ' + r.runNo; target = null; }
  const cd = target != null ? (target > Date.now() ? 'in ' + S.fmtDur((target - Date.now()) / 60000) : 'now') : '';
  const route = run && run.pieces[0] ? ' · ' + run.pieces[0].routeLabel : '';
  bar.innerHTML = '<span>MY RUN</span><b>RUN ' + esc(r.runNo) + '</b><span>' + esc(route.replace(/^ · /, '')) + '</span>'
    + '<span>' + esc(label) + '</span><span class="pa-strip-cd">' + esc(cd) + '</span><a href="home.html">OPEN →</a>';
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
