// ==========================================================================
// Paddle App — the run scorecard, the same card the paddle viewer
// (index.html render()) draws for every run: run number, day, PADDLE button,
// routes, Start / Finish / Pay hrs, swing, and one timeline row per piece.
//
// Used by My Run (home.html) and the Swap board (pa-swap-ui.js). Styles are
// in pa-run-card.css. stack() puts a block on top of the card as one piece
// (My Run's countdown, a swap offer's details).
// DOM only; no Firebase, no live data.
// ==========================================================================

import { fmtClock, dayLabel } from './pa-schedule.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Day class the card is colored by: 'Weekday' | 'Saturday' | 'Sunday'. */
export const dayClass = dayType => dayLabel(dayType || 'weekday');

/**
 * The card's content from a pa-schedule run (normalizeRun), using the times
 * as the paddle prints them. `run` may be null: then only what `fallback`
 * ({ runNo, dayType, reportMin, finishMin, payHours, routeLabel }) knows is shown.
 */
export function modelFromRun(run, fallback = {}) {
  const r = run || {};
  const pieces = r.pieces || [];
  const labels = pieces.length ? pieces.map(p => p.routeLabel) : String(fallback.routeLabel || '').split(' / ').filter(Boolean);
  const rep = r.reportMin != null ? r.reportMin : fallback.reportMin;
  const fin = r.finishMin != null ? r.finishMin : fallback.finishMin;
  const pay = r.payText || (r.payHours || fallback.payHours ? (r.payHours || fallback.payHours).toFixed(1) : '');
  return {
    runNo: r.runNo || fallback.runNo || '',
    dayType: r.dayType || fallback.dayType || 'weekday',
    routes: [...new Set(labels)].join(' | '),
    // A report time typed in on the day replaces the paddle's start.
    start: r.overridden || !r.startText ? (rep != null ? fmtClock(rep) : '') : r.startText,
    finish: r.finishText || (fin != null ? fmtClock(fin) : ''),
    pay,
    swing: r.swingDur || '',
    segments: pieces.map(p => ({
      route: p.routeLabel, block: p.block, sched: p.durLabel, s: p.startMin, e: p.endMin,
      startType: p.startType, startTime: p.startClock || fmtClock(p.startMin),
      endType: p.endType, endTime: p.endClock || fmtClock(p.endMin)
    }))
  };
}

/** The card element. opts.paddleUrl: the run's official paddle page. */
// The design system's tags (assets/pa-tags.js, a classic script the page
// loads); the old look if a page doesn't have it.
const T = () => window.PaTags || null;
const blockHtml = (s, dayType) => T()
  ? T().blockTag(null, s.block, { label: s.route, day: dayType, at: s.s, s: s.s, e: s.e })
  : `<span class="prc-seg-block-label">BLK</span><span class="prc-seg-block">${esc(s.block)}</span>`;
const runHtml = (runNo, day, url) => T()
  ? T().runTag(runNo, day, url)
  : (url ? `<a class="prc-num" href="${esc(url)}" target="_blank" rel="noopener">${esc(runNo)}</a>` : `<div class="prc-num">${esc(runNo)}</div>`) +
    `<div class="prc-day">${esc(day)}</div>`;

export function card(m, opts = {}) {
  const day = dayClass(m.dayType);
  const url = opts.paddleUrl || '';
  const n = document.createElement('div');
  n.className = 'prc day-' + day;
  // Each piece: the block tag ("21/9901"), which names the route too.
  const segs = (m.segments || []).map(s => `
      <div class="prc-seg">
        <div class="prc-seg-connector"><div class="prc-seg-dot"></div><div class="prc-seg-line"></div></div>
        <div class="prc-seg-body">
          <div class="prc-seg-top">
            ${T() ? '' : `<span class="prc-seg-route">${esc(s.route)}</span>`}
            ${blockHtml(s, m.dayType)}
            <span class="prc-seg-sched">${esc(s.sched)}</span>
          </div>
          <div class="prc-seg-times">
            <span class="prc-seg-time-tag">${esc(s.startType)}</span>
            <span>${esc(s.startTime)}</span>
            <span class="prc-seg-arrow">-&gt;</span>
            <span class="prc-seg-time-tag">${esc(s.endType)}</span>
            <span>${esc(s.endTime)}</span>
          </div>
        </div>
      </div>`).join('');
  n.innerHTML = `
    <div class="prc-head">
      <div class="prc-head-top">
        ${runHtml(m.runNo, day, url)}
        <div class="prc-actions">${url ? `<a class="prc-paddle" href="${esc(url)}" target="_blank" rel="noopener">PADDLE</a>` : ''}</div>
      </div>
      <div class="prc-head-bottom">
        <div class="prc-routes">${esc(m.routes) || '&mdash;'}</div>
      </div>
    </div>
    <div class="prc-stats">
      <div class="prc-stat"><div class="prc-stat-label">Start</div><div class="prc-stat-val">${esc(m.start) || '&mdash;'}</div></div>
      <div class="prc-stat"><div class="prc-stat-label">Finish</div><div class="prc-stat-val">${esc(m.finish) || '&mdash;'}</div></div>
      <div class="prc-stat"><div class="prc-stat-label">Pay hrs</div><div class="prc-stat-val pay">${esc(m.pay) || '&mdash;'}</div></div>
    </div>
    ${m.swing ? `<div class="prc-swing"><div class="prc-swing-label">Swing:</div><div class="prc-swing-value">${esc(m.swing)}</div></div>` : ''}
    ${segs ? `<div class="prc-timeline">${segs}</div>` : ''}`;
  if (T()) T().resolveBlockTags(n);
  return n;
}

/** Turn the run number and PADDLE button into links once the URL is known. */
export function setPaddleUrl(n, url) {
  if (!n || !url) return;
  // The run tag becomes the link to the paddle.
  const tag = n.querySelector('.prc-head-top .pa-run.nolink');
  if (tag) {
    const a = document.createElement('a');
    a.className = tag.className.replace(/\s*nolink/, ''); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.innerHTML = tag.innerHTML;
    tag.replaceWith(a);
  }
  const num = n.querySelector('.prc-num');
  if (num && num.tagName !== 'A') {
    const a = document.createElement('a');
    a.className = 'prc-num'; a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = num.textContent;
    num.replaceWith(a);
  }
  const acts = n.querySelector('.prc-actions');
  if (acts && !acts.querySelector('.prc-paddle')) {
    const b = document.createElement('a');
    b.className = 'prc-paddle'; b.href = url; b.target = '_blank'; b.rel = 'noopener'; b.textContent = 'PADDLE';
    acts.appendChild(b);
  }
}

/** `top` on `cardEl`, drawn as one piece in the card's day color. */
export function stack(top, cardEl, dayType) {
  const s = document.createElement('div');
  s.className = 'prc-stack day-' + dayClass(dayType);
  top.classList.add('prc-top');
  s.append(top, cardEl);
  return s;
}
