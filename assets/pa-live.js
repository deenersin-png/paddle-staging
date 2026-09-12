// ==========================================================================
// Paddle App — live vehicle lookup (TransitView), informational only.
//
// This is the ONLY module that touches live data. It is imported by the
// leader panel on home.html and by nothing else. In particular
// pa-countdown.js and pa-schedule.js never import it: what the leader bus is
// doing right now must never move an operator's countdown.
//
// TransitView requires JSONP — SEPTA does not send CORS headers. Endpoints
// and parsing are the same three-endpoint fallback block-tracker.html uses.
// ==========================================================================

const TV_ENDPOINTS = [
  r => 'https://www3.septa.org/api/TransitView/index.php?route=' + encodeURIComponent(r) + '&callback=',
  r => 'https://www3.septa.org/hackathon/TransitView/?route=' + encodeURIComponent(r) + '&callback=',
  r => 'https://www3.septa.org/beta/TransitView/?route=' + encodeURIComponent(r) + '&callback='
];
const TIMEOUT_MS = 8000;

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
  return buses.filter(b => {
    const ts  = parseInt(b.timestamp) || 0;
    const off = String(b.Offset || '');
    return ts > 1000000 || (off && off !== '999');
  });
}

function jsonp(route, idx = 0) {
  return new Promise((resolve, reject) => {
    if (idx >= TV_ENDPOINTS.length) { reject(new Error('All TransitView endpoints failed')); return; }
    const cb = 'pa_tv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const el = document.createElement('script');
    let done = false;
    const cleanup = () => {
      if (done) return; done = true;
      try { delete window[cb]; } catch (_) {}
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    const next = () => { cleanup(); jsonp(route, idx + 1).then(resolve, reject); };
    const timer = setTimeout(next, TIMEOUT_MS);
    window[cb] = data => { clearTimeout(timer); if (done) return; cleanup(); resolve(parseTVData(data)); };
    el.onerror = () => { clearTimeout(timer); if (!done) next(); };
    el.src = TV_ENDPOINTS[idx](route) + cb;
    document.head.appendChild(el);
  });
}

/** Live buses on one route (empty array on total failure). */
export async function fetchRoute(route) {
  try { return await jsonp(route); } catch (_) { return []; }
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

/** The vehicle currently signed on to `block`, searching each route it may
 *  be running. null when no live data (not in service, or not tracking). */
export async function vehicleForBlock(routes, block) {
  const blk = String(block || '');
  if (!blk) return null;
  for (const r of routes) {
    const buses = await fetchRoute(r);
    const hit = buses.find(b => String(b.BlockID || '') === blk);
    if (hit) return normalize(hit);
  }
  return null;
}

/** Plain-language one-liner for the leader panel. */
export function describe(v) {
  if (!v) return 'No live data for your leader — it may not be in service.';
  const where = v.nextStop ? 'near ' + v.nextStop : (v.destination ? 'toward ' + v.destination : 'on the road');
  const late = v.late > 0 ? v.late + ' min late' : v.late < 0 ? Math.abs(v.late) + ' min early' : 'on time';
  return 'Block ' + v.block + ' · bus ' + v.vehicleId + ' · ' + where + ' · ' + late;
}
