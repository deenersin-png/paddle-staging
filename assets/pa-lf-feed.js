// ==========================================================================
// Paddle App — Leader / Follower data access: the route lines
// (data/shapes/<route>.json) and live buses from SEPTA TransitView through
// pa-live.js (JSONP, three-endpoint fallback, route aliases), or mocked
// answers (pa-lf-mock.js) when a staging page runs with ?lfmock=<scenario>.
//
// Informational only: nothing here is read by the countdown.
// ==========================================================================

import * as L from './pa-live.js';
import { prepShapes, normalizeBus } from './pa-lf.js';
import { mockTransitView, SCENARIOS } from './pa-lf-mock.js';

export { SCENARIOS };

const SHAPES_BASE = new URL('../data/shapes/', import.meta.url).href;
const shapeMem = new Map();

/** The prepared route line for a GTFS route name, trying its aliases; null if none. */
export function loadShapes(route) {
  const key = String(route || '');
  if (!shapeMem.has(key)) {
    const p = (async () => {
      const names = [...new Set([key, ...L.aliasesOf(key), key.replace(/_/g, ' ')])];
      for (const name of names) {
        try {
          const res = await fetch(SHAPES_BASE + encodeURIComponent(name) + '.json');
          if (res.ok) return prepShapes(await res.json());
        } catch (_) { /* next name */ }
      }
      return null;
    })();
    p.then(v => { if (!v) shapeMem.delete(key); }, () => shapeMem.delete(key));   // retry a miss next time
    shapeMem.set(key, p);
  }
  return shapeMem.get(key);
}

/** The mock scenario named in the page URL (?lfmock=…), or null. */
export function mockFromUrl(search = typeof location !== 'undefined' ? location.search : '') {
  const v = new URLSearchParams(search).get('lfmock');
  return v && SCENARIOS[v] ? v : null;
}

/**
 * A live-bus reader that remembers the last good answer.
 * read(ctx, shapes) -> { buses, ok, fetchedAt, raw }
 *   buses     normalised buses (the last good ones when ok is false), or null
 *             if there has never been a good answer
 *   ok        false when TransitView did not answer this time (outage)
 *   fetchedAt ms of the last good answer (0 = never)
 */
export function createFeed({ mock = null } = {}) {
  let call = 0, last = null, fetchedAt = 0;
  return {
    mock,
    async read(ctx, shapes) {
      let raw = null, ok = false;
      if (mock) {
        try { raw = mockTransitView(mock, { shapes, myBlock: ctx.block, myTrip: ctx.myTrip, trips: ctx.trips, pullIns: ctx.pullIns, call }).bus; ok = true; }
        catch (_) { ok = false; }
      } else {
        try { const r = await L.fetchRoutesChecked(ctx.routes); raw = r.buses; ok = r.ok; }
        catch (_) { ok = false; }
        // Keep the shared block <-> bus pairing current (never with test data).
        if (ok) L.learnPairs(ctx.routes, raw, ctx.block).catch(() => {});
      }
      call++;
      if (ok) {
        last = raw.map(b => normalizeBus(b, ctx.routes[0] || ''));
        fetchedAt = Date.now();
      }
      return { buses: last, ok, fetchedAt, raw };
    }
  };
}
