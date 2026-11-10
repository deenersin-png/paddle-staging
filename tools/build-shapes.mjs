// ==========================================================================
// Build data/shapes/<route>.json from SEPTA's GTFS bus feed, for the
// Leader / Follower view (assets/pa-lf.js projects buses onto these lines).
//
//   node tools/build-shapes.mjs <unzipped google_bus dir> [outDir=data/shapes]
//
// Get the feed from https://www3.septa.org/developer/gtfs_public.zip (unzip
// it, then unzip google_bus.zip inside). Re-run when septa-gtfs moves to a new
// gtfs_version; the client only warns when versions differ, the lines still
// work because shapes rarely change between picks.
//
// One file per route_short_name (same names as septa-gtfs/data/*.json):
//   {
//     v: "v202611010",                       feed_version
//     dirs: {
//       "0": {
//         name: "Eastbound",                 directions.txt
//         main: "317337",                    shape used by the most trips
//         shapes: { "317337": [[lat,lng],…] }  simplified (~6 m), 5 decimals
//         stops: [[stopId, name, lat, lng], …]  route_stops.txt order
//       }, …
//     },
//     alt: { tripId: shapeId }               only trips NOT on their dir's main shape
//   }
// No dependencies: plain Node 18+.
// ==========================================================================

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [, , SRC, OUT = 'data/shapes'] = process.argv;
if (!SRC) { console.error('usage: node tools/build-shapes.mjs <google_bus dir> [outDir]'); process.exit(1); }

const TOLERANCE_M = 6;

function readCSV(file) {
  const text = readFileSync(join(SRC, file), 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = splitLine(lines[0]);
  return lines.slice(1).map(l => {
    const cells = splitLine(l), row = {};
    head.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}
function splitLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Douglas-Peucker on a local flat projection (metres).
function simplify(pts) {
  if (pts.length < 3) return pts;
  const lat0 = pts[0][0] * Math.PI / 180, K = 111320;
  const xy = pts.map(([la, ln]) => [ln * K * Math.cos(lat0), la * K]);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bi = -1;
    const [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > best) { best = d; bi = i; }
    }
    if (best > TOLERANCE_M) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const r5 = n => Math.round(n * 1e5) / 1e5;

const feed = readCSV('feed_info.txt')[0] || {};
const routes = new Map(readCSV('routes.txt').map(r => [r.route_id, r.route_short_name || r.route_id]));
const dirNames = new Map(readCSV('directions.txt').map(d => [d.route_id + '|' + d.direction_id, d.direction]));
const stops = new Map(readCSV('stops.txt').map(s => [s.stop_id, s]));

// route -> dir -> shapeId -> trip count; and every trip's shape.
const use = new Map(), tripShape = new Map();
for (const t of readCSV('trips.txt')) {
  const name = routes.get(t.route_id); if (!name || !t.shape_id) continue;
  const key = name + '|' + t.direction_id;
  if (!use.has(key)) use.set(key, new Map());
  const m = use.get(key); m.set(t.shape_id, (m.get(t.shape_id) || 0) + 1);
  tripShape.set(t.trip_id, { name, dir: t.direction_id, shape: t.shape_id });
}

const needed = new Set([...use.values()].flatMap(m => [...m.keys()]));
const shapePts = new Map();
for (const p of readCSV('shapes.txt')) {
  if (!needed.has(p.shape_id)) continue;
  if (!shapePts.has(p.shape_id)) shapePts.set(p.shape_id, []);
  shapePts.get(p.shape_id).push([+p.shape_pt_sequence, +p.shape_pt_lat, +p.shape_pt_lon]);
}
const simplified = new Map();
for (const [id, arr] of shapePts) {
  arr.sort((a, b) => a[0] - b[0]);
  simplified.set(id, simplify(arr.map(([, la, ln]) => [la, ln])).map(([la, ln]) => [r5(la), r5(ln)]));
}

const files = new Map();     // name -> json
const fileOf = name => {
  if (!files.has(name)) files.set(name, { v: feed.feed_version || '', dirs: {}, alt: {} });
  return files.get(name);
};
for (const [key, counts] of use) {
  const [name, dir] = key.split('|');
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const shapes = {};
  for (const id of counts.keys()) if (simplified.has(id)) shapes[id] = simplified.get(id);
  const routeId = [...routes.entries()].find(([, n]) => n === name)[0];
  fileOf(name).dirs[dir] = { name: dirNames.get(routeId + '|' + dir) || '', main, shapes, stops: [] };
}
for (const [tripId, t] of tripShape) {
  const f = files.get(t.name), d = f && f.dirs[t.dir];
  if (d && t.shape !== d.main) f.alt[tripId] = t.shape;
}
for (const rs of readCSV('route_stops.txt').sort((a, b) => +a.route_stop_sort_order - +b.route_stop_sort_order)) {
  const name = routes.get(rs.route_id), f = name && files.get(name), d = f && f.dirs[rs.direction_id], s = stops.get(rs.stop_id);
  if (d && s) d.stops.push([s.stop_id, s.stop_name, r5(+s.stop_lat), r5(+s.stop_lon)]);
}

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith('.json')) rmSync(join(OUT, f));
let bytes = 0;
for (const [name, json] of files) {
  const s = JSON.stringify(json);
  bytes += s.length;
  writeFileSync(join(OUT, name + '.json'), s);
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify({ v: feed.feed_version || '', generated_at: new Date().toISOString(), routes: [...files.keys()].sort() }));
console.log(files.size + ' routes, ' + Math.round(bytes / 1024) + ' KB, feed ' + feed.feed_version);
