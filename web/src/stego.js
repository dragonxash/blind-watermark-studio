/*!
 * 盲水印工坊 — 隐写引擎
 * ---------------------------------------------------------------------------
 * 提供两条与 FFT 加法式互补的嵌入路线（两者都**不需要原图**就能提取）：
 *
 *  1) DWT-DCT-SVD（鲁棒模式）
 *     对每个通道做一级 Haar 小波取 LL 子带 -> 分 4x4 块 -> 每块做 DCT ->
 *     对 DCT 系数矩阵做 SVD -> 用 QIM 把 1 bit 写进最大奇异值 s[0]。
 *
 *     QIM（量化索引调制）是关键：
 *       q  = floor(s0 / delta)
 *       q' = 2*floor(q/2) + bit          // 只改 s0 所在格点序号的奇偶
 *       s0' = (q' + 0.5) * delta         // 落在格点中心，离边界有 delta/2 余量
 *     提取时 s0'/delta 四舍五入回 q'，其奇偶即 bit —— 不需要原始 s0。
 *     又因为奇异值对图像扰动不敏感，它能扛住 JPEG 压缩与轻微缩放。
 *
 *     容量约 (H/8)*(W/8)*3 bit，1024x1024 约 6 KB。
 *
 *  2) LSB（大容量模式）
 *     把数据按位写进像素最低有效位。容量 = W*H*3 bit（1024x1024 约 393 KB），
 *     同样免原图，但任何有损压缩都会摧毁它 —— 输出必须保持 PNG。
 *
 *  两者共用一个 8 字节容器头部，提取时可自动识别用的哪种引擎。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.BWMStego = factory(root.BWM);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (BWM) {
  'use strict';

  /* =========================================================================
   * 1. 基础数学：4x4 DCT、4x4 SVD、一级 Haar 小波
   * ======================================================================= */

  // 正交 DCT-II 变换矩阵（N=4）：C[k][n] = sqrt(2/N) * a(k) * cos(pi*(2n+1)k/(2N))
  var DCT4 = (function () {
    var N = 4, C = new Float64Array(16), k, n;
    for (k = 0; k < N; k++) {
      var a = (k === 0) ? Math.SQRT1_2 : 1.0;
      for (n = 0; n < N; n++) {
        C[k * N + n] = Math.sqrt(2.0 / N) * a * Math.cos(Math.PI * (2 * n + 1) * k / (2 * N));
      }
    }
    return C;
  })();

  /** 2D DCT：dst = C * src * C^T（均按行优先 4x4） */
  function dct4(src, dst, tmp) {
    var i, j, k, s;
    for (i = 0; i < 4; i++) {
      for (j = 0; j < 4; j++) {
        s = 0;
        for (k = 0; k < 4; k++) s += DCT4[i * 4 + k] * src[k * 4 + j];
        tmp[i * 4 + j] = s;
      }
    }
    for (i = 0; i < 4; i++) {
      for (j = 0; j < 4; j++) {
        s = 0;
        for (k = 0; k < 4; k++) s += tmp[i * 4 + k] * DCT4[j * 4 + k];
        dst[i * 4 + j] = s;
      }
    }
  }

  /** 逆 2D DCT：dst = C^T * src * C */
  function idct4(src, dst, tmp) {
    var i, j, k, s;
    for (i = 0; i < 4; i++) {
      for (j = 0; j < 4; j++) {
        s = 0;
        for (k = 0; k < 4; k++) s += DCT4[k * 4 + i] * src[k * 4 + j];
        tmp[i * 4 + j] = s;
      }
    }
    for (i = 0; i < 4; i++) {
      for (j = 0; j < 4; j++) {
        s = 0;
        for (k = 0; k < 4; k++) s += tmp[i * 4 + k] * DCT4[k * 4 + j];
        dst[i * 4 + j] = s;
      }
    }
  }

  /**
   * 4x4 实矩阵的单边 Jacobi SVD：a = U * diag(S) * V^T
   * 只有 4x4，扫几轮就收敛，开销可忽略。
   */
  function svd4(a, U, S, V) {
    var i, j, p, q, sweep;
    for (i = 0; i < 16; i++) { U[i] = a[i]; V[i] = 0; }
    V[0] = V[5] = V[10] = V[15] = 1;

    for (sweep = 0; sweep < 30; sweep++) {
      var off = 0.0;
      for (p = 0; p < 3; p++) {
        for (q = p + 1; q < 4; q++) {
          var alpha = 0.0, beta = 0.0, gamma = 0.0;
          for (i = 0; i < 4; i++) {
            var uip = U[i * 4 + p], uiq = U[i * 4 + q];
            alpha += uip * uip;
            beta += uiq * uiq;
            gamma += uip * uiq;
          }
          off += gamma * gamma;
          if (gamma === 0 || Math.abs(gamma) < 1e-14 * Math.sqrt(alpha * beta)) continue;

          var zeta = (beta - alpha) / (2.0 * gamma);
          var t = (zeta >= 0 ? 1.0 : -1.0) / (Math.abs(zeta) + Math.sqrt(1.0 + zeta * zeta));
          var c = 1.0 / Math.sqrt(1.0 + t * t);
          var s = c * t;

          for (i = 0; i < 4; i++) {
            var a1 = U[i * 4 + p], a2 = U[i * 4 + q];
            U[i * 4 + p] = c * a1 - s * a2;
            U[i * 4 + q] = s * a1 + c * a2;
            var b1 = V[i * 4 + p], b2 = V[i * 4 + q];
            V[i * 4 + p] = c * b1 - s * b2;
            V[i * 4 + q] = s * b1 + c * b2;
          }
        }
      }
      if (off < 1e-24) break;
    }

    for (j = 0; j < 4; j++) {
      var norm = 0.0;
      for (i = 0; i < 4; i++) norm += U[i * 4 + j] * U[i * 4 + j];
      norm = Math.sqrt(norm);
      S[j] = norm;
      if (norm > 1e-300) {
        for (i = 0; i < 4; i++) U[i * 4 + j] /= norm;
      }
    }

    // Jacobi 不保证列的顺序，但 QIM 依赖 s[0] 是最大奇异值，
    // 所以这里按降序重排，并同步交换 U、V 的对应列（不改变 A = U S V^T）。
    for (i = 0; i < 3; i++) {
      var mi = i;
      for (j = i + 1; j < 4; j++) if (S[j] > S[mi]) mi = j;
      if (mi !== i) {
        var ts = S[i]; S[i] = S[mi]; S[mi] = ts;
        for (var r = 0; r < 4; r++) {
          var tu = U[r * 4 + i]; U[r * 4 + i] = U[r * 4 + mi]; U[r * 4 + mi] = tu;
          var tv = V[r * 4 + i]; V[r * 4 + i] = V[r * 4 + mi]; V[r * 4 + mi] = tv;
        }
      }
    }
  }

  /** 由 U, S, V 重构：out = U * diag(S) * V^T */
  function svd4Reconstruct(U, S, V, out) {
    var i, j, k, sum;
    for (i = 0; i < 4; i++) {
      for (j = 0; j < 4; j++) {
        sum = 0.0;
        for (k = 0; k < 4; k++) sum += U[i * 4 + k] * S[k] * V[j * 4 + k];
        out[i * 4 + j] = sum;
      }
    }
  }

  /** 一级 Haar 二维小波分解，输入 W*H，输出四个 (W/2)*(H/2) 子带 */
  function haarDwt2(plane, W, H, sub) {
    var hw = W >> 1, hh = H >> 1;
    var LL = sub.LL, LH = sub.LH, HL = sub.HL, HH = sub.HH;
    for (var y = 0; y < hh; y++) {
      var r0 = (y << 1) * W, r1 = r0 + W, o = y * hw;
      for (var x = 0; x < hw; x++) {
        var c0 = x << 1;
        var a = plane[r0 + c0], b = plane[r0 + c0 + 1];
        var c = plane[r1 + c0], d = plane[r1 + c0 + 1];
        LL[o + x] = (a + b + c + d) * 0.5;
        LH[o + x] = (a - b + c - d) * 0.5;
        HL[o + x] = (a + b - c - d) * 0.5;
        HH[o + x] = (a - b - c + d) * 0.5;
      }
    }
  }

  /** 一级 Haar 重构 */
  function haarIdwt2(out, W, H, sub) {
    var hw = W >> 1, hh = H >> 1;
    var LL = sub.LL, LH = sub.LH, HL = sub.HL, HH = sub.HH;
    for (var y = 0; y < hh; y++) {
      var r0 = (y << 1) * W, r1 = r0 + W, o = y * hw;
      for (var x = 0; x < hw; x++) {
        var c0 = x << 1;
        var l = LL[o + x], p = LH[o + x], q = HL[o + x], s = HH[o + x];
        out[r0 + c0] = (l + p + q + s) * 0.5;
        out[r0 + c0 + 1] = (l - p + q - s) * 0.5;
        out[r1 + c0] = (l + p - q - s) * 0.5;
        out[r1 + c0 + 1] = (l - p - q + s) * 0.5;
      }
    }
  }

  /* =========================================================================
   * 2. 容器格式
   * ======================================================================= */

  var MAGIC0 = 0xB7, MAGIC1 = 0x4D;
  var METHOD_ROBUST = 1, METHOD_LSB = 2;
  var TYPE_TEXT = 0, TYPE_FILE = 1, TYPE_IMAGE = 2;
  var HEADER_BYTES = 10;
  var DEFAULT_DELTA = 36.0;

  function packContainer(method, contentType, payload) {
    var out = new Uint8Array(HEADER_BYTES + payload.length);
    out[0] = MAGIC0;
    out[1] = MAGIC1;
    out[2] = 1;
    out[3] = method;
    out[4] = contentType;
    out[5] = 0;
    var len = payload.length;
    out[6] = (len >>> 24) & 0xFF;
    out[7] = (len >>> 16) & 0xFF;
    out[8] = (len >>> 8) & 0xFF;
    out[9] = len & 0xFF;
    out.set(payload, HEADER_BYTES);
    return out;
  }

  function readHeader(bytes) {
    if (!bytes || bytes.length < HEADER_BYTES) return null;
    if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) return null;
    var len = ((bytes[6] << 24) | (bytes[7] << 16) | (bytes[8] << 8) | bytes[9]) >>> 0;
    return { version: bytes[2], method: bytes[3], contentType: bytes[4], length: len };
  }

  /* =========================================================================
   * 3. 工具
   * ======================================================================= */

  function bytesToBits(bytes) {
    var bits = new Uint8Array(bytes.length * 8), i, b;
    for (i = 0; i < bytes.length; i++) {
      for (b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
    }
    return bits;
  }

  function bitsToBytes(bits, byteCount) {
    var out = new Uint8Array(byteCount), i, b;
    for (i = 0; i < byteCount; i++) {
      var v = 0;
      for (b = 0; b < 8; b++) v = (v << 1) | (bits[i * 8 + b] & 1);
      out[i] = v;
    }
    return out;
  }

  /** 用密码驱动的置换打散写入位置，避免局部损坏波及连续的一段数据 */
  function makeOrder(n, password, cache) {
    var key = 'o' + n + '_' + (password >>> 0);
    if (cache && cache[key]) return cache[key];
    var order = new Int32Array(n), i;
    for (i = 0; i < n; i++) order[i] = i;
    if (password) {
      // 注意：core.js 里的 CPrng 构造函数不接收种子，必须用 .seed() 播种。
      // 若写成 new CPrng(seed) 会得到一个未播种的实例，导致所有密码产生同一乱序。
      var rng = new BWM.CPrng().seed(password >>> 0);
      for (i = n - 1; i > 0; i--) {
        var j = rng.randbelow(i + 1);
        var t = order[i]; order[i] = order[j]; order[j] = t;
      }
    }
    if (cache) cache[key] = order;
    return order;
  }

  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var bytes = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0xD800 || c >= 0xE000) {
        bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else {
        i++;
        var cc = 0x10000 + (((c & 0x3FF) << 10) | (str.charCodeAt(i) & 0x3FF));
        bytes.push(0xF0 | (cc >> 18), 0x80 | ((cc >> 12) & 63),
          0x80 | ((cc >> 6) & 63), 0x80 | (cc & 63));
      }
    }
    return new Uint8Array(bytes);
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') {
      try {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } catch (e) { /* 落到下面的兜底实现 */ }
    }
    var s = '', i = 0;
    while (i < bytes.length) {
      var c = bytes[i++];
      if (c < 0x80) s += String.fromCharCode(c);
      else if (c < 0xE0) s += String.fromCharCode(((c & 31) << 6) | (bytes[i++] & 63));
      else if (c < 0xF0) {
        s += String.fromCharCode(((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      } else {
        var cc = ((c & 7) << 18) | ((bytes[i++] & 63) << 12)
          | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
        cc -= 0x10000;
        s += String.fromCharCode(0xD800 + (cc >> 10), 0xDC00 + (cc & 0x3FF));
      }
    }
    return s;
  }

  /* =========================================================================
   * 4. 鲁棒引擎：DWT-DCT-SVD + QIM
   * ======================================================================= */

  function robustBlocks(W, H) {
    return { bw: (W >> 1) >> 2, bh: (H >> 1) >> 2 };
  }

  function robustCapacityBits(W, H) {
    var b = robustBlocks(W, H);
    return b.bw * b.bh * 3;
  }

  function robustCapacityBytes(W, H) {
    return Math.floor(robustCapacityBits(W, H) / 8) - HEADER_BYTES;
  }

  var _scratch = null;
  function scratch() {
    if (!_scratch) {
      _scratch = {
        block: new Float64Array(16),
        dct: new Float64Array(16),
        tmp: new Float64Array(16),
        rec: new Float64Array(16),
        U: new Float64Array(16),
        S: new Float64Array(4),
        V: new Float64Array(16),
      };
    }
    return _scratch;
  }

  /**
   * 读/写一个 4x4 块的最大奇异值。
   * @param LL      LL 子带缓冲
   * @param stride  LL 的**实际行宽**（= W/2），不是块的列数，别混用
   * @param bw      每行有多少个 4x4 块
   * @param blockIdx 块序号
   * @param writeBit >=0 表示写入该 bit；传 -1 表示读取
   */
  function processBlock(LL, stride, bw, blockIdx, sc, writeBit, delta) {
    var by = (blockIdx / bw) | 0, bx = blockIdx % bw;
    var y0 = by << 2, x0 = bx << 2;
    var i, bit = 0;

    for (i = 0; i < 16; i++) {
      sc.block[i] = LL[(y0 + (i >> 2)) * stride + (x0 + (i & 3))];
    }
    dct4(sc.block, sc.dct, sc.tmp);
    svd4(sc.dct, sc.U, sc.S, sc.V);

    var q = Math.floor(sc.S[0] / delta);
    if (writeBit >= 0) {
      var q2 = 2 * Math.floor(q / 2) + (writeBit & 1);
      sc.S[0] = (q2 + 0.5) * delta;
      svd4Reconstruct(sc.U, sc.S, sc.V, sc.rec);
      idct4(sc.rec, sc.dct, sc.tmp);
      for (i = 0; i < 16; i++) {
        LL[(y0 + (i >> 2)) * stride + (x0 + (i & 3))] = sc.dct[i];
      }
      return 0;
    }
    // 读取：s0' 落在格点中心 (q' + 0.5)，因此 floor(s0'/delta) 恰为 q'。
    // 注意这里必须用 floor —— 用 Math.round 会撞上「.5 向上取整」而错位一格。
    // 容错半径是 ±delta/2。
    q = Math.floor(sc.S[0] / delta);
    bit = ((q % 2) + 2) % 2;
    return bit;
  }

  /**
   * 鲁棒嵌入。
   * @param planes 三个 Float64Array（BGR 平面）
   * @returns 实际写入的 bit 数
   */
  function embedRobust(planes, W, H, payload, password, delta, cache, contentType) {
    delta = delta || DEFAULT_DELTA;
    if (contentType === undefined) contentType = TYPE_TEXT;
    var b = robustBlocks(W, H);
    var cap = b.bw * b.bh * 3;
    var bytes = packContainer(METHOD_ROBUST, contentType, payload);
    var bits = bytesToBits(bytes);
    if (bits.length > cap) {
      throw new Error('数据过大：需要 ' + bits.length + ' bit（' + bytes.length
        + ' 字节），当前图片的鲁棒容量只有 ' + cap + ' bit（'
        + robustCapacityBytes(W, H) + ' 字节）');
    }

    var hw = W >> 1, hh = H >> 1, c, i;
    var subs = [];
    for (c = 0; c < 3; c++) {
      var sub = {
        LL: new Float64Array(hw * hh),
        LH: new Float64Array(hw * hh),
        HL: new Float64Array(hw * hh),
        HH: new Float64Array(hw * hh),
      };
      haarDwt2(planes[c], W, H, sub);
      subs.push(sub);
    }

    var order = makeOrder(cap, password, cache);
    var sc = scratch();
    var perChannel = b.bw * b.bh;

    for (i = 0; i < bits.length; i++) {
      var p = order[i];
      c = (p / perChannel) | 0;
      if (c > 2) continue;
      processBlock(subs[c].LL, hw, b.bw, p % perChannel, sc, bits[i], delta);
    }

    for (c = 0; c < 3; c++) haarIdwt2(planes[c], W, H, subs[c]);
    return bits.length;
  }

  /**
   * 鲁棒提取。返回 payload 的字节数组；若头部校验不通过则返回 null。
   */
  function extractRobust(planes, W, H, password, delta, cache) {
    delta = delta || DEFAULT_DELTA;
    var b = robustBlocks(W, H);
    var cap = b.bw * b.bh * 3;
    if (cap < HEADER_BYTES * 8) return null;

    var hw = W >> 1, hh = H >> 1, c, i;
    var subs = [];
    for (c = 0; c < 3; c++) {
      var sub = {
        LL: new Float64Array(hw * hh),
        LH: new Float64Array(hw * hh),
        HL: new Float64Array(hw * hh),
        HH: new Float64Array(hw * hh),
      };
      haarDwt2(planes[c], W, H, sub);
      subs.push(sub);
    }

    var order = makeOrder(cap, password, cache);
    var sc = scratch();
    var perChannel = b.bw * b.bh;
    var bits = new Uint8Array(cap);

    for (i = 0; i < cap; i++) {
      var p = order[i];
      c = (p / perChannel) | 0;
      if (c > 2) { bits[i] = 0; continue; }
      bits[i] = processBlock(subs[c].LL, hw, b.bw, p % perChannel, sc, -1, delta);
    }

    var maxBytes = Math.floor(cap / 8);
    var bytes = bitsToBytes(bits, maxBytes);
    var hdr = readHeader(bytes);
    if (!hdr || hdr.method !== METHOD_ROBUST) return null;
    if (hdr.length > maxBytes - HEADER_BYTES) return null;

    var out = new Uint8Array(hdr.length);
    out.set(bytes.subarray(HEADER_BYTES, HEADER_BYTES + hdr.length));
    return { method: METHOD_ROBUST, contentType: hdr.contentType, data: out };
  }

  /* =========================================================================
   * 5. LSB 引擎
   * ======================================================================= */

  function lsbCapacityBits(W, H) {
    return W * H * 3;
  }

  function lsbCapacityBytes(W, H) {
    return Math.floor(lsbCapacityBits(W, H) / 8) - HEADER_BYTES;
  }

  function embedLsb(planes, W, H, payload, password, cache, contentType) {
    if (contentType === undefined) contentType = TYPE_TEXT;
    var total = lsbCapacityBits(W, H);
    var bytes = packContainer(METHOD_LSB, contentType, payload);
    var bits = bytesToBits(bytes);
    if (bits.length > total) {
      throw new Error('数据过大：需要 ' + bytes.length + ' 字节，当前图片的大容量通道只能容纳 '
        + lsbCapacityBytes(W, H) + ' 字节');
    }
    var order = makeOrder(total, password, cache);
    for (var i = 0; i < bits.length; i++) {
      var p = order[i];
      var c = p % 3;
      var px = (p / 3) | 0;
      planes[c][px] = (Math.floor(planes[c][px]) & ~1) | bits[i];
    }
    return bits.length;
  }

  function extractLsb(planes, W, H, password, cache) {
    var total = lsbCapacityBits(W, H);
    var hb = HEADER_BYTES * 8;
    if (total < hb) return null;
    var order = makeOrder(total, password, cache);
    var i, p;

    var headBits = new Uint8Array(hb);
    for (i = 0; i < hb; i++) {
      p = order[i];
      headBits[i] = Math.floor(planes[p % 3][(p / 3) | 0]) & 1;
    }
    var hdr = readHeader(bitsToBytes(headBits, HEADER_BYTES));
    if (!hdr || hdr.method !== METHOD_LSB) return null;

    var need = HEADER_BYTES + hdr.length;
    if (need * 8 > total) return null;

    var allBits = new Uint8Array(need * 8);
    for (i = 0; i < need * 8; i++) {
      p = order[i];
      allBits[i] = Math.floor(planes[p % 3][(p / 3) | 0]) & 1;
    }
    var bytes = bitsToBytes(allBits, need);
    var out = new Uint8Array(hdr.length);
    out.set(bytes.subarray(HEADER_BYTES, need));
    return { method: METHOD_LSB, contentType: hdr.contentType, data: out };
  }

  /* =========================================================================
   * 6. 自动提取
   * ======================================================================= */

  /**
   * 先试 LSB（快且不会误判），再试鲁棒模式。
   * @returns {method, contentType, data} 或 null
   */
  function autoExtract(planes, W, H, password, delta, cache) {
    var r = extractLsb(planes, W, H, password, cache);
    if (r) return r;
    return extractRobust(planes, W, H, password, delta, cache);
  }

  /* =========================================================================
   * 对外接口
   * ======================================================================= */

  return {
    HEADER_BYTES: HEADER_BYTES,
    METHOD_ROBUST: METHOD_ROBUST,
    METHOD_LSB: METHOD_LSB,
    TYPE_TEXT: TYPE_TEXT,
    TYPE_FILE: TYPE_FILE,
    TYPE_IMAGE: TYPE_IMAGE,
    DEFAULT_DELTA: DEFAULT_DELTA,

    robustCapacityBits: robustCapacityBits,
    robustCapacityBytes: robustCapacityBytes,
    lsbCapacityBits: lsbCapacityBits,
    lsbCapacityBytes: lsbCapacityBytes,

    embedRobust: embedRobust,
    extractRobust: extractRobust,
    embedLsb: embedLsb,
    extractLsb: extractLsb,
    autoExtract: autoExtract,

    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    makeOrder: makeOrder,

    // 供测试使用
    _dct4: dct4,
    _idct4: idct4,
    _svd4: svd4,
    _svd4Reconstruct: svd4Reconstruct,
    _haarDwt2: haarDwt2,
    _haarIdwt2: haarIdwt2,
    _packContainer: packContainer,
    _readHeader: readHeader,
  };
});
