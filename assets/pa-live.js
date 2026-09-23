// ==========================================================================
// Paddle App — live data (TransitView vehicles, bus detours), informational only.
//
// This is the ONLY module that touches live data. It is imported by the
// leader / detours panel on home.html and by nothing else. In particular
// pa-countdown.js and pa-schedule.js never import it: what the leader bus is
// doing right now must never move an operator's countdown.
//
// SEPTA sends no CORS headers for these endpoints, so both are read with
// JSONP - the same three-endpoint fallback block-tracker.html uses for
// TransitView. BusDetours answers JSONP too (verified 2026-09-14), which
// avoids corsproxy.io, now refusing requests without an API key.
// ==========================================================================

const TIMEOUT_MS = 8000;

const TV_ENDPOINTS = [
  r => 'https://www3.septa.org/api/TransitView/index.php?route=' + encodeURIComponent(r) + '&callback=',
  r => 'https://www3.septa.org/hackathon/TransitView/?route=' + encodeURIComponent(r) + '&callback=',
  r => 'https://www3.septa.org/beta/TransitView/?route=' + encodeURIComponent(r) + '&callback='
];
const DETOUR_ENDPOINTS = [
  r => 'https://www3.septa.org/api/BusDetours/index.php?route=' + encodeURIComponent(r) + '&callback=',
  r => 'https://www3.septa.org/api/BusDetours/?route=' + encodeURIComponent(r) + '&callback=',
  r => 'https://www3.septa.org/hackathon/BusDetours/?route=' + encodeURIComponent(r) + '&callback='
];

// SEPTA renamed routes in its network redesign; the feeds may use either
// name. Same table as block-tracker.html.
const ROUTE_ALIASES = {
  '10': ['10','T1'],   'T1': ['T1','10'],
  '11': ['11','T4'],   'T4': ['T4','11'],
  '13': ['13','T3'],   'T3': ['T3','13'],
  '15': ['15','G1','G'],   'G1': ['G1','15'],
  '34': ['34','T2'],   'T2': ['T2','34'],
  '36': ['36','T5'],   'T5': ['T5','36'],
  'G':  ['G','63'],    '63': ['63','G'],
  'H':  ['H','71'],    '71': ['71','H'],
  'J':  ['J','41'],    '41': ['41','J'],
  'L':  ['L','51'],    '51': ['51','L'],
  'R':  ['R','82'],    '82': ['82','R'],
  'XH': ['XH','81'],   '81': ['81','XH'],
};
export const aliasesOf = route => ROUTE_ALIASES[route] || [route];

/**
 * Off a page — the email sender runs this module in Node — there is no
 * document to hang a script tag on, and no CORS rule to dodge either, so the
 * endpoints are simply fetched. Everything below this line (the parsing, the
 * aliases, the detour cards) is then shared by the app and the sender.
 */
async function httpJson(endpoints, arg, idx = 0) {
  if (idx >= endpoints.length) throw new Error('All endpoints failed');
  try {
    const url = endpoints[idx](arg).replace(/[?&]callback=$/, '');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  } catch (_) {
    return httpJson(endpoints, arg, idx + 1);
  }
}

/** Try each endpoint in turn until one calls back. Rejects if all fail. */
function jsonp(endpoints, arg, idx = 0) {
  return new Promise((resolve, reject) => {
    if (idx >= endpoints.length) { reject(new Error('All endpoints failed')); return; }
    const cb = 'pa_jsonp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const el = document.createElement('script');
    let done = false;
    const cleanup = () => {
      if (done) return; done = true;
      try { delete window[cb]; } catch (_) {}
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    const next = () => { cleanup(); jsonp(endpoints, arg, idx + 1).then(resolve, reject); };
    const timer = setTimeout(next, TIMEOUT_MS);
    window[cb] = data => { clearTimeout(timer); if (done) return; cleanup(); resolve(data); };
    el.onerror = () => { clearTimeout(timer); if (!done) next(); };
    el.src = endpoints[idx](arg) + cb;
    document.head.appendChild(el);
  });
}

/** JSONP in a page, a plain fetch anywhere else. */
const request = typeof document !== 'undefined' ? jsonp : httpJson;

// ---- TransitView -----------------------------------------------------------

/** Identical to block-tracker.html's parseTVData, including NOT TRACKING. */
function parseTVData(raw) {
  const buses = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      if (item.lat || item.BlockID || item.label) { buses.push(item); continue; }
      for (const v of Object.values(item)) {
        if (Array.isArray(v)) v.forEach(b => b && typeof b === 'object' && buses.push(b));
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const v of Object.values(raw)) {
      if (Array.isArray(v)) v.forEach(b => b && typeof b === 'object' && buses.push(b));
    }
  }
  return buses.map(b => {
    const offNum = parseFloat(String(b.Offset || ''));
    if (!isNaN(offNum) && Math.abs(offNum) >= 500) b._notTracking = true;
    return b;
  }).filter(b => {
    const ts  = parseInt(b.timestamp) || 0;
    const off = String(b.Offset || '');
    if (b._notTracking && !parseInt(b.next_stop_sequence)) return false;
    return ts > 1000000 || (off && off !== '999');
  });
}

/** Live buses on one route, trying its aliases (empty array on total failure). */
export async function fetchRoute(route) {
  for (const name of aliasesOf(route)) {
    try {
      const buses = parseTVData(await request(TV_ENDPOINTS, name));
      if (buses.length) return buses;
    } catch (_) { /* try the next alias */ }
  }
  return [];
}

/** Live buses on several routes (an interlined run spans two), de-duplicated. */
export async function fetchRoutes(routes) {
  const lists = await Promise.all([...new Set(routes)].map(r => fetchRoute(r)));
  const seen = new Set(), out = [];
  for (const b of lists.flat()) {
    const key = String(b.VehicleID || b.label || '') + '|' + String(b.BlockID || '');
    if (seen.has(key)) continue;
    seen.add(key); out.push(b);
  }
  return out;
}

function normalize(b) {
  return {
    vehicleId: String(b.VehicleID || b.label || ''),
    block: String(b.BlockID || ''),
    direction: b.Direction || '',
    destination: b.destination || '',
    late: parseInt(b.late) || 0,
    nextStop: b.next_stop_name || '',
    lat: parseFloat(b.lat), lng: parseFloat(b.lng),
    trip: b.trip != null ? String(b.trip) : ''
  };
}

/** The vehicle currently signed on to `block` (normalised), or null. */
export async function vehicleForBlock(routes, block) {
  const blk = String(block || '');
  if (!blk) return null;
  const hit = (await fetchRoutes(routes)).find(b => String(b.BlockID || '') === blk);
  return hit ? normalize(hit) : null;
}

/** Plain-language one-liner (kept for callers that want text, not a card). */
export function describe(v) {
  if (!v) return 'No live data for your leader — it may not be in service.';
  const where = v.nextStop ? 'near ' + v.nextStop : (v.destination ? 'toward ' + v.destination : 'on the road');
  const late = v.late > 0 ? v.late + ' min late' : v.late < 0 ? Math.abs(v.late) + ' min early' : 'on time';
  return 'Block ' + v.block + ' · bus ' + v.vehicleId + ' · ' + where + ' · ' + late;
}

// ---- detours ---------------------------------------------------------------

const detourMem = new Map();          // route -> { at, cards }
const DETOUR_TTL_MS = 2 * 60 * 1000;

/**
 * Active detours for the given routes, flattened into the card shape
 * detours.html renders. Resolves { cards, failed } - `failed` lists routes
 * that could not be read at all, so the panel can say so instead of showing
 * "no detours" for a lookup that never happened.
 */
export async function fetchDetours(routes) {
  const cards = [], failed = [], seen = new Set();
  for (const route of [...new Set(routes)]) {
    const hit = detourMem.get(route);
    let routeCards = hit && Date.now() - hit.at < DETOUR_TTL_MS ? hit.cards : null;
    if (!routeCards) {
      routeCards = [];
      let answered = false;
      for (const name of aliasesOf(route)) {
        let data;
        try { data = await request(DETOUR_ENDPOINTS, name); answered = true; } catch (_) { continue; }
        if (!Array.isArray(data)) continue;
        for (const group of data) {
          const rid = String(group.route_id || name);
          // Only this route's groups, even if an endpoint answers with more.
          if (!aliasesOf(route).includes(rid)) continue;
          for (const d of (group.route_info || [])) {
            routeCards.push({
              routeId: rid,
              direction:     String(d.route_direction || '').trim(),
              reason:        String(d.reason || '').trim(),
              startLocation: String(d.start_location || '').trim(),
              endLocation:   String(d.end_location || '').trim(),
              startDate:     String(d.start_date_time || '').trim(),
              endDate:       String(d.end_date_time || '').trim(),
              message:       String(d.current_message || '').trim()
            });
          }
        }
      }
      if (!answered) { failed.push(route); continue; }
      detourMem.set(route, { at: Date.now(), cards: routeCards });
    }
    for (const c of routeCards) {
      const key = c.routeId + '|' + c.direction + '|' + c.reason + '|' + c.message;
      if (seen.has(key)) continue;
      seen.add(key); cards.push(c);
    }
  }
  return { cards, failed };
}
