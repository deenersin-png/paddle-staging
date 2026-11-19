// node assets/tests/qr.test.mjs
// Checks the QR generator (assets/pa-qr.js): Reed-Solomon against the
// textbook "HELLO WORLD" 1-M example, the format bits against the standard
// table, and a full read-back (unmask + zigzag) of several symbols.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const QR = require('../pa-qr.js');

let fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok  ', name);
}

// 1. Reed-Solomon: data codewords of "HELLO WORLD" at 1-M -> 10 EC codewords.
eq('RS HELLO WORLD 1-M',
  QR._ecBytes([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10),
  [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);

// 2. Format bits at level M, read back from the symbol (top-left copy).
const FORMAT_M = [0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0];
function readFormat(mx) {
  const pos = [];
  for (let i = 0; i <= 5; i++) pos.push([i, 8]);
  pos.push([7, 8], [8, 8], [8, 7]);
  for (let i = 9; i < 15; i++) pos.push([8, 14 - i]);
  let bits = 0;
  pos.forEach(([r, c], i) => { if (mx.dark(r, c)) bits |= 1 << i; });
  // second copy must match
  let b2 = 0, n = mx.size;
  for (let i = 0; i < 8; i++) if (mx.dark(8, n - 1 - i)) b2 |= 1 << i;
  for (let i = 8; i < 15; i++) if (mx.dark(n - 15 + i, 8)) b2 |= 1 << i;
  return { bits, b2 };
}

// 3. Full read-back: find the mask from the format bits, rebuild the
// function-pattern map, unmask, walk the zigzag, de-interleave, check the
// byte-mode payload equals the input.
const TABLE = [null, [26,10,1,16,0],[44,16,1,28,0],[70,26,1,44,0],[100,18,2,32,0],[134,24,2,43,0],
  [172,16,4,27,0],[196,18,4,31,0],[242,22,2,38,2],[292,22,3,36,2],[346,26,4,43,1]];
const ALIGN = [null, [], [6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];
function isFunction(n, v) {
  const f = Array.from({ length: n }, () => Array(n).fill(false));
  for (let i = 0; i < n; i++) { f[6][i] = f[i][6] = true; }
  for (const [r0, c0] of [[0, 0], [0, n - 8], [n - 8, 0]])
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) f[r0 + r][c0 + c] = true;
  const al = ALIGN[v], L = al.length - 1;
  al.forEach((ar, a) => al.forEach((ac, b) => {
    if ((a === 0 && b === 0) || (a === 0 && b === L) || (a === L && b === 0)) return;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) f[ar + r][ac + c] = true;
  }));
  for (let i = 0; i < 9; i++) { f[8][i] = f[i][8] = true; }
  for (let i = 0; i < 8; i++) { f[8][n - 1 - i] = f[n - 1 - i][8] = true; }
  if (v >= 7) for (let i = 0; i < 18; i++) { const a = n - 11 + (i % 3), b = Math.floor(i / 3); f[a][b] = f[b][a] = true; }
  return f;
}
const MASKS = [(r,c)=>(r+c)%2===0,(r)=>r%2===0,(r,c)=>c%3===0,(r,c)=>(r+c)%3===0,
  (r,c)=>(Math.floor(r/2)+Math.floor(c/3))%2===0,(r,c)=>(r*c)%2+(r*c)%3===0,
  (r,c)=>((r*c)%2+(r*c)%3)%2===0,(r,c)=>((r+c)%2+(r*c)%3)%2===0];
function decode(mx) {
  const n = mx.size, v = (n - 17) / 4, { bits } = readFormat(mx);
  const mask = FORMAT_M.indexOf(bits);
  if (mask < 0) return { error: 'format ' + bits.toString(2) };
  const f = isFunction(n, v), raw = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
      const c = right - j, up = ((right + 1) & 2) === 0, r = up ? n - 1 - vert : vert;
      if (f[r][c]) continue;
      raw.push(mx.dark(r, c) !== MASKS[mask](r, c) ? 1 : 0);
    }
  }
  const cw = [];
  for (let i = 0; i + 8 <= raw.length; i += 8) cw.push(parseInt(raw.slice(i, i + 8).join(''), 2));
  const t = TABLE[v], nb = t[2] + t[4], blocks = Array.from({ length: nb }, () => ({ d: [], e: [] }));
  let k = 0;
  for (let i = 0; i <= t[3]; i++) for (let b = 0; b < nb; b++) if (i < t[3] + (b < t[2] ? 0 : 1)) blocks[b].d.push(cw[k++]);
  for (let i = 0; i < t[1]; i++) for (let b = 0; b < nb; b++) blocks[b].e.push(cw[k++]);
  for (const b of blocks) if (JSON.stringify(QR._ecBytes(b.d, t[1])) !== JSON.stringify(b.e)) return { error: 'EC mismatch' };
  const data = blocks.flatMap(b => b.d), bitstr = data.map(x => x.toString(2).padStart(8, '0')).join('');
  if (bitstr.slice(0, 4) !== '0100') return { error: 'mode' };
  const lenBits = v < 10 ? 8 : 16, len = parseInt(bitstr.slice(4, 4 + lenBits), 2), bytes = [];
  for (let i = 0; i < len; i++) bytes.push(parseInt(bitstr.slice(4 + lenBits + i * 8, 12 + lenBits + i * 8), 2));
  return { text: Buffer.from(bytes).toString('utf8'), mask, version: v };
}

const samples = [
  'https://paddleapp.github.io/?utm_source=gg',
  'https://bit.ly/4jkDQr8',
  'https://deenersin-png.github.io/septa-scheduler/?utm_source=app&utm_medium=app&utm_campaign=app',
  'https://deenersin-png.github.io/septa-scheduler/',
  'https://deenersin-png.github.io/paddle-staging/',
  'http://localhost:8080/',
  'A',
  'Paddle App – café ✓ ' + 'x'.repeat(120),   // multi-block, version 7+
  'y'.repeat(200)                              // version 10 (16-bit length)
];
for (const s of samples) {
  const mx = QR.matrix(s), { bits, b2 } = readFormat(mx);
  eq('format copies match (v' + mx.version + ')', bits, b2);
  const d = decode(mx);
  eq('read-back v' + mx.version + ' mask ' + d.mask + ': ' + s.slice(0, 40), d.text, s);
}
eq('dark module', QR.matrix('A').dark(21 - 8, 8), true);
eq('svg starts', QR.svg('A').slice(0, 4), '<svg');

if (fail) { console.log(fail + ' failed'); process.exit(1); }
console.log('all passed');
