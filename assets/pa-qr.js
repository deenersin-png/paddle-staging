// Small self-contained QR code generator (no library, works offline).
//
// Used by the Share > Show QR code popup (assets/pa-share.js) to draw the
// app's link. Byte mode, error correction level M, versions 1-10 (up to 213
// bytes - plenty for a web address). Follows the QR standard (ISO 18004):
// Reed-Solomon over GF(256), the 8 masks scored by the usual penalty rules.
//
//   PaQR.matrix(text) -> { size, dark(row, col) -> bool }
//   PaQR.svg(text, { quiet: 4, label: '...' }) -> '<svg ...>' string
(function (root) {
  'use strict';

  // Level M, per version: [total codewords, EC codewords per block, blocks in
  // group 1, data codewords per group-1 block, blocks in group 2] (group-2
  // blocks hold one more data codeword).
  var TABLE = [null,
    [26, 10, 1, 16, 0], [44, 16, 1, 28, 0], [70, 26, 1, 44, 0], [100, 18, 2, 32, 0],
    [134, 24, 2, 43, 0], [172, 16, 4, 27, 0], [196, 18, 4, 31, 0], [242, 22, 2, 38, 2],
    [292, 22, 3, 36, 2], [346, 26, 4, 43, 1]
  ];
  var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  function dataCapacity(v) { var t = TABLE[v]; return t[2] * t[3] + t[4] * (t[3] + 1); }

  function utf8(text) {
    var s = unescape(encodeURIComponent(String(text))), out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  // ---- Reed-Solomon over GF(256), polynomial 0x11D ----
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11D; }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function mul(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }
  function generator(n) {          // coefficients, highest power first, leading 1 dropped
    var g = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(g.length + 1).fill(0);
      for (var j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
      g = next;
    }
    return g.slice(1);
  }
  function ecBytes(data, n) {
    var g = generator(n), r = new Array(n).fill(0);
    data.forEach(function (d) {
      var f = d ^ r.shift();
      r.push(0);
      for (var i = 0; i < n; i++) r[i] ^= mul(g[i], f);
    });
    return r;
  }

  // ---- data codewords: mode, length, bytes, terminator, padding ----
  function codewords(bytes, v) {
    var cap = dataCapacity(v), bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4);
    put(bytes.length, v < 10 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    put(0, Math.min(4, cap * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    var out = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      out.push(b);
    }
    for (var p = 0; out.length < cap; p++) out.push(p % 2 ? 0x11 : 0xEC);
    // Split into blocks, add EC to each, interleave.
    var t = TABLE[v], blocks = [], k = 0;
    for (var bi = 0; bi < t[2] + t[4]; bi++) {
      var len = t[3] + (bi < t[2] ? 0 : 1);
      var d = out.slice(k, k + len); k += len;
      blocks.push({ d: d, e: ecBytes(d, t[1]) });
    }
    var res = [];
    for (i = 0; i <= t[3]; i++) blocks.forEach(function (b) { if (i < b.d.length) res.push(b.d[i]); });
    for (i = 0; i < t[1]; i++) blocks.forEach(function (b) { res.push(b.e[i]); });
    return res;
  }

  // ---- the symbol ----
  function build(bytes, v) {
    var n = v * 4 + 17, m = [], fn = [], r, c;
    for (r = 0; r < n; r++) { m.push(new Array(n).fill(false)); fn.push(new Array(n).fill(false)); }
    function set(row, col, dark) { m[row][col] = !!dark; fn[row][col] = true; }

    // Timing lines, then finders (with their white separators) on top.
    for (var i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    [[3, 3], [3, n - 4], [n - 4, 3]].forEach(function (p) {
      for (var dr = -4; dr <= 4; dr++) for (var dc = -4; dc <= 4; dc++) {
        var rr = p[0] + dr, cc = p[1] + dc;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
        var d = Math.max(Math.abs(dr), Math.abs(dc));
        set(rr, cc, d !== 2 && d !== 4);
      }
    });
    // Alignment patterns, except where they would overlap a finder.
    var al = ALIGN[v], last = al.length - 1;
    al.forEach(function (ar, a) {
      al.forEach(function (ac, b) {
        if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) return;
        for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++)
          set(ar + dr, ac + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      });
    });
    // Reserve the format areas (written for real after masking) + version info.
    drawFormat(set, n, 0);
    if (v >= 7) {
      var rem = v;
      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vbits = (v << 12) | rem;
      for (i = 0; i < 18; i++) {
        var bit = (vbits >>> i) & 1, aa = n - 11 + (i % 3), bb = Math.floor(i / 3);
        set(bb, aa, bit); set(aa, bb, bit);
      }
    }

    // Data, in the zigzag from the bottom-right corner.
    var data = codewords(bytes, v), bitIx = 0, total = data.length * 8;
    for (var right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < n; vert++) {
        for (var j = 0; j < 2; j++) {
          c = right - j;
          var upward = ((right + 1) & 2) === 0;
          r = upward ? n - 1 - vert : vert;
          if (fn[r][c]) continue;
          if (bitIx < total) m[r][c] = ((data[bitIx >>> 3] >>> (7 - (bitIx & 7))) & 1) === 1;
          bitIx++;
        }
      }
    }

    // Try every mask, keep the one with the lowest penalty.
    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var t = m.map(function (row) { return row.slice(); });
      applyMask(t, fn, mask, n);
      drawFormat(function (row, col, dark) { t[row][col] = !!dark; }, n, mask);
      var s = penalty(t, n);
      if (s < bestScore) { bestScore = s; best = t; }
    }
    return best;
  }

  function maskBit(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return (r * c) % 2 + (r * c) % 3 === 0;
      case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
      default: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
    }
  }
  function applyMask(t, fn, mask, n) {
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++)
      if (!fn[r][c] && maskBit(mask, r, c)) t[r][c] = !t[r][c];
  }

  // 15 format bits: level M (00) + mask, BCH-protected, XOR 0x5412.
  function drawFormat(set, n, mask) {
    var d = mask, rem = d;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((d << 10) | rem) ^ 0x5412;
    function b(i) { return (bits >>> i) & 1; }
    for (i = 0; i <= 5; i++) set(i, 8, b(i));
    set(7, 8, b(6)); set(8, 8, b(7)); set(8, 7, b(8));
    for (i = 9; i < 15; i++) set(8, 14 - i, b(i));
    for (i = 0; i < 8; i++) set(8, n - 1 - i, b(i));
    for (i = 8; i < 15; i++) set(n - 15 + i, 8, b(i));
    set(n - 8, 8, 1);                                   // the always-dark module
  }

  function penalty(t, n) {
    var score = 0, r, c, dark = 0;
    function lines(get) {
      for (var a = 0; a < n; a++) {
        var run = 1, s = '';
        for (var b = 0; b < n; b++) {
          var x = get(a, b);
          s += x ? '1' : '0';
          if (b > 0) {
            if (x === get(a, b - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
            else run = 1;
          }
        }
        s = '0000' + s + '0000';
        var re = /(?=(10111010000|00001011101))/g, mm;
        while ((mm = re.exec(s))) { score += 40; re.lastIndex++; }
      }
    }
    lines(function (a, b) { return t[a][b]; });
    lines(function (a, b) { return t[b][a]; });
    for (r = 0; r < n; r++) for (c = 0; c < n; c++) {
      if (t[r][c]) dark++;
      if (r < n - 1 && c < n - 1 && t[r][c] === t[r][c + 1] && t[r][c] === t[r + 1][c] && t[r][c] === t[r + 1][c + 1]) score += 3;
    }
    score += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
    return score;
  }

  function matrix(text) {
    var bytes = utf8(text);
    for (var v = 1; v <= 10; v++) {
      var head = 4 + (v < 10 ? 8 : 16);
      if (Math.ceil((head + bytes.length * 8) / 8) <= dataCapacity(v)) {
        var m = build(bytes, v);
        return { size: m.length, version: v, dark: function (r, c) { return !!(m[r] && m[r][c]); } };
      }
    }
    throw new Error('QR: text too long');
  }

  function svg(text, opts) {
    opts = opts || {};
    var q = opts.quiet == null ? 4 : opts.quiet, mx = matrix(text), n = mx.size, w = n + q * 2, d = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++)
      if (mx.dark(r, c)) d += 'M' + (c + q) + ' ' + (r + q) + 'h1v1h-1z';
    var label = String(opts.label || 'QR code').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + w + '" role="img" aria-label="' + label +
      '" shape-rendering="crispEdges"><rect width="' + w + '" height="' + w + '" fill="#fff"/><path fill="#000" d="' + d + '"/></svg>';
  }

  var api = { matrix: matrix, svg: svg, _ecBytes: ecBytes };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PaQR = api;
})(typeof self !== 'undefined' ? self : this);
