/*!
 * BlindWaterMark Web — 核心算法库
 * ---------------------------------------------------------------------------
 * 严格复刻 https://github.com/chishaxie/BlindWaterMark 的 bwmforpy3.py。
 *
 * 算法要点：
 *   1. 取一个 (floor(H/2), W) 的空矩阵 hwm，把水印贴到它的左上角；
 *   2. 用 seed 驱动 CPython 的 random.shuffle 生成两个排列 m / n，
 *      以 hwm[i][j] = hwm2[m[i]][n[j]] 把水印"打散"成噪声状图案；
 *   3. 再把 hwm 以「180° 翻转」的方式镜像到 rwm 的整个画布：
 *         rwm[i][j] = hwm[i][j],  rwm[H-1-i][W-1-j] = hwm[i][j]
 *   4. 对每个通道做 img_wm = real( ifft2( fft2(img) + alpha * rwm ) )
 *      —— 水印是直接加到频域上的，因此肉眼几乎不可见。
 *
 *   解码时反过来：rwm = real( (fft2(img_wm) - fft2(img)) / alpha )，
 *   再按 m/n 逆排列还原出水印。
 *
 * 说明：由于第 3 步用的是 H-1-i（翻转）而不是 DFT 意义上的 (H-i) mod H
 *（循环移位），二者相差 1 像素，会有一半能量不能被逆变换还原，
 * 表现为解码结果出现"对角方向 1 像素双影 + 边界半亮度"。
 * 这是原作的固有行为，本实现为保证互通而忠实保留。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BWM = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* =========================================================================
   * 1. CPython 兼容随机数（MT19937）
   *    必须与 CPython 的 random.seed(int) / getrandbits / _randbelow / shuffle
   *    逐位一致，否则网页端与 Python 端无法互通。
   * ======================================================================= */

  var MT_N = 624, MT_M = 397;
  var MT_MATRIX_A = 0x9908b0df;
  var MT_UPPER_MASK = 0x80000000;
  var MT_LOWER_MASK = 0x7fffffff;

  function CPrng() {
    this.mt = new Uint32Array(MT_N);
    this.mti = MT_N + 1;
  }

  /** CPython: init_genrand(s) */
  CPrng.prototype._initGenrand = function (s) {
    var mt = this.mt, i, prev;
    mt[0] = s >>> 0;
    for (i = 1; i < MT_N; i++) {
      prev = (mt[i - 1] ^ (mt[i - 1] >>> 30)) >>> 0;
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = MT_N;
  };

  /** CPython: init_by_array(key, key_length) */
  CPrng.prototype._initByArray = function (key) {
    var mt = this.mt, i, j, k, len = key.length;
    this._initGenrand(19650218);
    i = 1; j = 0;
    for (k = Math.max(MT_N, len); k > 0; k--) {
      mt[i] = (((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) >>> 0)
        + key[j] + j) >>> 0;
      i++; j++;
      if (i >= MT_N) { mt[0] = mt[MT_N - 1]; i = 1; }
      if (j >= len) j = 0;
    }
    for (k = MT_N - 1; k > 0; k--) {
      mt[i] = (((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) >>> 0)
        - i) >>> 0;
      i++;
      if (i >= MT_N) { mt[0] = mt[MT_N - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
    this.mti = MT_N;
  };

  /**
   * 等价于 CPython 的 random.seed(a)。
   * 整数 a 会被转成绝对值，并按 32 位小端字拆成 key 数组。
   */
  CPrng.prototype.seed = function (a) {
    var n = Math.abs(Math.trunc(Number(a) || 0));
    var key = [], v = n;
    do {
      key.push((v % 4294967296) >>> 0);
      v = Math.floor(v / 4294967296);
    } while (v > 0);
    this._initByArray(key);
    return this;
  };

  /** CPython: genrand_uint32() */
  CPrng.prototype._next = function () {
    var mt = this.mt, y, kk;
    if (this.mti >= MT_N) {
      for (kk = 0; kk < MT_N - MT_M; kk++) {
        y = (mt[kk] & MT_UPPER_MASK) | (mt[kk + 1] & MT_LOWER_MASK);
        mt[kk] = (mt[kk + MT_M] ^ (y >>> 1) ^ ((y & 1) ? MT_MATRIX_A : 0)) >>> 0;
      }
      for (; kk < MT_N - 1; kk++) {
        y = (mt[kk] & MT_UPPER_MASK) | (mt[kk + 1] & MT_LOWER_MASK);
        mt[kk] = (mt[kk + (MT_M - MT_N)] ^ (y >>> 1) ^ ((y & 1) ? MT_MATRIX_A : 0)) >>> 0;
      }
      y = (mt[MT_N - 1] & MT_UPPER_MASK) | (mt[0] & MT_LOWER_MASK);
      mt[MT_N - 1] = (mt[MT_M - 1] ^ (y >>> 1) ^ ((y & 1) ? MT_MATRIX_A : 0)) >>> 0;
      this.mti = 0;
    }
    y = mt[this.mti++];
    y = (y ^ (y >>> 11)) >>> 0;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y = (y ^ (y >>> 18)) >>> 0;
    return y;
  };

  /** CPython: getrandbits(k)，k <= 53 时结果精确 */
  CPrng.prototype.getrandbits = function (k) {
    var words = Math.floor((k - 1) / 32) + 1;
    var result = 0, shift = 0, kk = k, i, r;
    for (i = 0; i < words; i++, kk -= 32) {
      r = this._next();
      if (kk < 32) r = r >>> (32 - kk);
      result += r * Math.pow(2, shift);
      shift += 32;
    }
    return result;
  };

  /** CPython: Random._randbelow_with_getrandbits(n) */
  CPrng.prototype.randbelow = function (n) {
    if (!n) return 0;
    var k = 32 - Math.clz32(n);
    var r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  };

  /** CPython 3.x: random.shuffle(x) —— 原地洗牌 */
  CPrng.prototype.shuffle = function (x) {
    var i, j, t;
    for (i = x.length - 1; i > 0; i--) {
      j = this.randbelow(i + 1);
      t = x[i]; x[i] = x[j]; x[j] = t;
    }
    return x;
  };

  /** CPython: random.random()（53 位精度，供 py2 兼容模式使用） */
  CPrng.prototype.random = function () {
    var a = this._next() >>> 5, b = this._next() >>> 6;
    return (a * 67108864 + b) * (1 / 9007199254740992);
  };

  /** Python 2 版 shuffle：x[i], x[j] = x[j], x[i]，其中 j = int(random()*(i+1)) */
  CPrng.prototype.oldShuffle = function (x) {
    var i, j, t;
    for (i = x.length - 1; i > 0; i--) {
      j = Math.trunc(this.random() * (i + 1));
      t = x[i]; x[i] = x[j]; x[j] = t;
    }
    return x;
  };

  /* =========================================================================
   * 2. FFT —— 任意长度一维 FFT（radix-2 + Bluestein）与二维 FFT
   * ======================================================================= */

  function nextPow2(n) {
    var m = 1;
    while (m < n) m <<= 1;
    return m;
  }

  /** radix-2 迭代 FFT，复杂度 O(n log n)，n 必须是 2 的幂 */
  function makeRadix2(n) {
    var levels = Math.round(Math.log2(n));
    var rev = new Uint32Array(n);
    var i, b, r;
    for (i = 0; i < n; i++) {
      r = 0;
      for (b = 0; b < levels; b++) if (i & (1 << b)) r |= 1 << (levels - 1 - b);
      rev[i] = r;
    }
    // 每一级的旋转因子表
    var cosT = [], sinT = [], s, half, k;
    for (s = 1; s <= levels; s++) {
      half = 1 << (s - 1);
      var c = new Float64Array(half), si = new Float64Array(half);
      for (k = 0; k < half; k++) {
        var ang = -2 * Math.PI * k / (1 << s);
        c[k] = Math.cos(ang);
        si[k] = Math.sin(ang);
      }
      cosT.push(c); sinT.push(si);
    }

    function transform(re, im, invert) {
      var i, j, t, s, m, half, k, jj, c, si, wr, wi, a, bb, tr, ti;
      for (i = 0; i < n; i++) {
        j = rev[i];
        if (j > i) {
          t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (s = 1; s <= levels; s++) {
        m = 1 << s; half = m >> 1;
        c = cosT[s - 1]; si = sinT[s - 1];
        for (k = 0; k < n; k += m) {
          for (jj = 0; jj < half; jj++) {
            wr = c[jj];
            wi = invert ? -si[jj] : si[jj];
            a = k + jj; bb = a + half;
            tr = re[bb] * wr - im[bb] * wi;
            ti = re[bb] * wi + im[bb] * wr;
            re[bb] = re[a] - tr; im[bb] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
      if (invert) {
        var inv = 1 / n;
        for (i = 0; i < n; i++) { re[i] *= inv; im[i] *= inv; }
      }
    }

    return {
      n: n,
      forward: function (re, im) { transform(re, im, false); },
      inverse: function (re, im) { transform(re, im, true); }
    };
  }

  /**
   * Bluestein（chirp-z）变换：把任意长度的 DFT 转成 2 的幂次长度的循环卷积。
   *   X[k] = e^{-i·pi·k^2/N} · Σ_n (x[n]·e^{-i·pi·n^2/N}) · e^{+i·pi·(k-n)^2/N}
   */
  function makeBluestein(n) {
    var m = nextPow2(2 * n - 1);
    var fft = makeRadix2(m);
    var chirpRe = new Float64Array(n), chirpIm = new Float64Array(n);
    var k, k2, ang;
    for (k = 0; k < n; k++) {
      k2 = (k * k) % (2 * n);          // 用取模保证相位参数始终是小量，避免精度损失
      ang = -Math.PI * k2 / n;
      chirpRe[k] = Math.cos(ang);
      chirpIm[k] = Math.sin(ang);
    }
    // 卷积核 B = FFT(conj(chirp)) 的对称扩展，预先算好
    var Br = new Float64Array(m), Bi = new Float64Array(m);
    Br[0] = chirpRe[0];
    Bi[0] = -chirpIm[0];
    for (k = 1; k < n; k++) {
      Br[k] = chirpRe[k]; Bi[k] = -chirpIm[k];
      Br[m - k] = chirpRe[k]; Bi[m - k] = -chirpIm[k];
    }
    fft.forward(Br, Bi);

    var ar = new Float64Array(m), ai = new Float64Array(m);

    function forward(re, im) {
      var k, xr, xi, cr, ci;
      for (k = 0; k < n; k++) {
        xr = re[k]; xi = im[k];
        cr = chirpRe[k]; ci = chirpIm[k];
        ar[k] = xr * cr - xi * ci;
        ai[k] = xr * ci + xi * cr;
      }
      ar.fill(0, n); ai.fill(0, n);
      fft.forward(ar, ai);
      for (k = 0; k < m; k++) {
        xr = ar[k]; xi = ai[k];
        ar[k] = xr * Br[k] - xi * Bi[k];
        ai[k] = xr * Bi[k] + xi * Br[k];
      }
      fft.inverse(ar, ai);
      for (k = 0; k < n; k++) {
        xr = ar[k]; xi = ai[k];
        cr = chirpRe[k]; ci = chirpIm[k];
        re[k] = xr * cr - xi * ci;
        im[k] = xr * ci + xi * cr;
      }
    }

    function inverse(re, im) {
      // ifft(X) = conj( fft( conj(X) ) ) / n
      var i;
      for (i = 0; i < n; i++) im[i] = -im[i];
      forward(re, im);
      var inv = 1 / n;
      for (i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
    }

    return { n: n, forward: forward, inverse: inverse };
  }

  /** 按长度选择合适的 1D FFT 实现 */
  function makeFft1D(n) {
    if (n > 0 && (n & (n - 1)) === 0) return makeRadix2(n);
    return makeBluestein(n);
  }

  /**
   * 二维 FFT 计划。数据为一维 Float64Array（行优先，长度 H*W）。
   * 先对每一行做长度为 W 的 1D FFT，再对每一列做长度为 H 的 1D FFT。
   * 同步版本与异步版本共用同一份实现。
   */
  function makeFft2D(H, W) {
    var fw = makeFft1D(W);
    var fh = makeFft1D(H);
    var bufLen = Math.max(H, W);
    var bufRe = new Float64Array(bufLen);
    var bufIm = new Float64Array(bufLen);
    var sre = bufRe.subarray(0, W), sim = bufIm.subarray(0, W);
    var cre = bufRe.subarray(0, H), cim = bufIm.subarray(0, H);

    function rows(re, im, invert) {
      var h, i, off;
      for (h = 0; h < H; h++) {
        off = h * W;
        for (i = 0; i < W; i++) { sre[i] = re[off + i]; sim[i] = im[off + i]; }
        if (invert) fw.inverse(sre, sim); else fw.forward(sre, sim);
        for (i = 0; i < W; i++) { re[off + i] = sre[i]; im[off + i] = sim[i]; }
      }
    }

    function cols(re, im, invert) {
      var w, i;
      for (w = 0; w < W; w++) {
        for (i = 0; i < H; i++) { cre[i] = re[i * W + w]; cim[i] = im[i * W + w]; }
        if (invert) fh.inverse(cre, cim); else fh.forward(cre, cim);
        for (i = 0; i < H; i++) { re[i * W + w] = cre[i]; im[i * W + w] = cim[i]; }
      }
    }

    function transform(re, im, invert) { rows(re, im, invert); cols(re, im, invert); }

    /** 异步版本：按行/列分块，块之间 await 让出主线程，便于刷新进度条 */
    function transformAsync(re, im, invert, tick) {
      var CHUNK = 24;
      var step = 0;
      var h = 0, w = 0, i, off;
      function next() {
        if (step === 0) {
          while (h < H) {
            off = h * W;
            for (i = 0; i < W; i++) { sre[i] = re[off + i]; sim[i] = im[off + i]; }
            if (invert) fw.inverse(sre, sim); else fw.forward(sre, sim);
            for (i = 0; i < W; i++) { re[off + i] = sre[i]; im[off + i] = sim[i]; }
            h++;
            if (h % CHUNK === 0 && h < H) return tick(0.5 * h / H).then(next);
          }
          step = 1;
        }
        if (step === 1) {
          while (w < W) {
            for (i = 0; i < H; i++) { cre[i] = re[i * W + w]; cim[i] = im[i * W + w]; }
            if (invert) fh.inverse(cre, cim); else fh.forward(cre, cim);
            for (i = 0; i < H; i++) { re[i * W + w] = cre[i]; im[i * W + w] = cim[i]; }
            w++;
            if (w % CHUNK === 0 && w < W) return tick(0.5 + 0.5 * w / W).then(next);
          }
        }
        return Promise.resolve();
      }
      return next();
    }

    return { H: H, W: W, transform: transform, transformAsync: transformAsync };
  }

  /* =========================================================================
   * 3. 图像数据工具（RGBA <-> BGR 平面）
   *    OpenCV 用 BGR 顺序，这里保持一致，便于与 Python 端互通。
   * ======================================================================= */

  /**
   * @param {Uint8ClampedArray} rgba 长度 w*h*4
   * @param {number} w
   * @param {number} h
   * @param {{r:number,g:number,b:number}|null} backdrop 透明像素的合成底色，null 表示忽略 alpha
   * @returns {{w:number,h:number,planes:Float64Array[]}} planes[0]=B, [1]=G, [2]=R
   */
  function rgbaToPlanes(rgba, w, h, backdrop) {
    var n = w * h;
    var B = new Float64Array(n), G = new Float64Array(n), R = new Float64Array(n);
    var i, p, r, g, b, a, br, bg, bb;
    if (backdrop) { br = backdrop.r; bg = backdrop.g; bb = backdrop.b; }
    for (i = 0, p = 0; i < n; i++, p += 4) {
      r = rgba[p]; g = rgba[p + 1]; b = rgba[p + 2]; a = rgba[p + 3];
      if (a !== 255 && backdrop) {
        var t = a / 255;
        r = r * t + br * (1 - t);
        g = g * t + bg * (1 - t);
        b = b * t + bb * (1 - t);
      }
      B[i] = b; G[i] = g; R[i] = r;
    }
    return { w: w, h: h, planes: [B, G, R] };
  }

  /** 平面数据写回 RGBA（自动 clamp + 四舍五入） */
  function planesToRgba(img, out) {
    var n = img.w * img.h;
    var B = img.planes[0], G = img.planes[1], R = img.planes[2];
    var rgba = out || new Uint8ClampedArray(n * 4);
    var i, p;
    for (i = 0, p = 0; i < n; i++, p += 4) {
      rgba[p] = clampRound(R[i]);
      rgba[p + 1] = clampRound(G[i]);
      rgba[p + 2] = clampRound(B[i]);
      rgba[p + 3] = 255;
    }
    return rgba;
  }

  /** 对齐 OpenCV saturate_cast<uchar>：clamp 到 [0,255] 并取整（银行家舍入） */
  function clampRound(x) {
    if (x <= 0) return 0;
    if (x >= 255) return 255;
    var f = Math.floor(x), diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }

  /**
   * 对齐 numpy 的 np.uint8(x)：向零截断（实测 np.uint8(127.5)==127）。
   * numpy 对越界值会抛 OverflowError，这里取更宽容的 clamp 行为。
   */
  function pyUint8(x) {
    if (!isFinite(x)) return 0;
    if (x <= 0) return 0;
    if (x >= 255) return 255;
    return Math.trunc(x);
  }

  /* =========================================================================
   * 3.5 复数图像变换
   *
   *  原作 bwmforpy3.py 里写的是 np.fft.fft2(img)，而 img 的形状是 (H, W, 3)。
   *  numpy 的 fft2 默认 axes=(-2, -1)，也就是 (1, 2) 两根轴 ——
   *  于是实际的变换轴是「宽度轴」和「通道轴」，等价于对每一行独立做 (W, 3)
   *  的二维变换，而不是"每个颜色通道各做一次空间二维变换"。
   *
   *  这一点必须复刻，否则网页端与 Python 端互不相通，所以提供两种模式：
   *    transform: 'numpy'   —— 复刻上述行为（默认，可与 Python 互解）
   *    transform: 'channel' —— 每通道独立空间二维变换（教科书做法）
   * ======================================================================= */

  function zerosPlanes(L) {
    return [new Float64Array(L), new Float64Array(L), new Float64Array(L)];
  }

  /**
   * 对 (H, W, 3) 的复数图像数据做二维正/逆变换，原地修改 cx。
   * @param {{re: Float64Array[], im: Float64Array[]}} cx
   */
  function transformImage(cx, H, W, invert, mode, tick) {
    var tickFn = tick || function () { return Promise.resolve(); };
    var c, k;

    if (mode === 'channel') {
      var plan = makeFft2D(H, W);
      c = 0;
      function stepC() {
        if (c >= 3) return Promise.resolve();
        var idx = c;
        return plan.transformAsync(cx.re[idx], cx.im[idx], invert, function (p) {
          return tickFn((idx + p) / 3);
        }).then(function () {
          c++;
          return tickFn(c / 3).then(stepC);
        });
      }
      return stepC();
    }

    // numpy 模式：逐行处理 (W, 3) 平面
    var planRow = makeFft2D(W, 3);
    var bufRe = new Float64Array(W * 3), bufIm = new Float64Array(W * 3);
    var h = 0, CHUNK = 64;
    function nextRow() {
      while (h < H) {
        var j, base;
        for (j = 0; j < W; j++) {
          base = h * W + j;
          for (k = 0; k < 3; k++) {
            bufRe[j * 3 + k] = cx.re[k][base];
            bufIm[j * 3 + k] = cx.im[k][base];
          }
        }
        planRow.transform(bufRe, bufIm, invert);
        for (j = 0; j < W; j++) {
          base = h * W + j;
          for (k = 0; k < 3; k++) {
            cx.re[k][base] = bufRe[j * 3 + k];
            cx.im[k][base] = bufIm[j * 3 + k];
          }
        }
        h++;
        if (h % CHUNK === 0 && h < H) return tickFn(h / H).then(nextRow);
      }
      return Promise.resolve();
    }
    return nextRow();
  }

  /** 把平面像素装进复数容器 */
  function planesToComplex(planes, H, W) {
    var L = H * W;
    var cx = { re: zerosPlanes(L), im: zerosPlanes(L) };
    for (var c = 0; c < 3; c++) cx.re[c].set(planes[c]);
    return cx;
  }

  /* =========================================================================
   * 4. 水印图案构造
   * ======================================================================= */

  /**
   * 生成被打散的半高图案 hwm（长度 Hh*W*3）以及镜像后的 rwm（长度 H*W*3）。
   * 完全对应 bwmforpy3.py 中 encode 的前半部分。
   */
  function buildPattern(H, W, wm, opts) {
    var Hh = Math.floor(H * 0.5);
    var wh = wm.h, ww = wm.w;
    var C = 3, c, i, j;

    // hwm2：把水印贴到 (Hh, W) 画布的左上角
    var hwm2 = [];
    for (c = 0; c < C; c++) hwm2.push(new Float64Array(Hh * W));
    for (i = 0; i < wh; i++) {
      for (j = 0; j < ww; j++) {
        for (c = 0; c < C; c++) hwm2[c][i * W + j] = wm.planes[c][i * ww + j];
      }
    }

    // 随机排列
    var rng = new CPrng().seed(opts.seed);
    var m = new Array(Hh), n = new Array(W);
    for (i = 0; i < Hh; i++) m[i] = i;
    for (j = 0; j < W; j++) n[j] = j;
    if (opts.oldSeed) { rng.oldShuffle(m); rng.oldShuffle(n); }
    else { rng.shuffle(m); rng.shuffle(n); }

    // hwm[i][j] = hwm2[m[i]][n[j]]
    var hwm = [];
    for (c = 0; c < C; c++) hwm.push(new Float64Array(Hh * W));
    for (i = 0; i < Hh; i++) {
      var mi = m[i] * W;
      var ii = i * W;
      for (j = 0; j < W; j++) {
        var src = mi + n[j];
        for (c = 0; c < C; c++) hwm[c][ii + j] = hwm2[c][src];
      }
    }

    // rwm：上半部填 hwm，同时镜像到 (H-1-i, W-1-j)
    var rwm = [];
    for (c = 0; c < C; c++) rwm.push(new Float64Array(H * W));
    for (i = 0; i < Hh; i++) {
      var ii2 = i * W;
      var ri = (H - 1 - i) * W;
      for (j = 0; j < W; j++) {
        var rj = W - 1 - j;
        for (c = 0; c < C; c++) {
          var v = hwm[c][ii2 + j];
          rwm[c][ii2 + j] = v;
          rwm[c][ri + rj] = v;
        }
      }
    }
    return { hwm: hwm, rwm: rwm, m: m, n: n, Hh: Hh };
  }

  /** 生成 m / n 排列（decode 端只需要排列，不需要图案） */
  function buildPermutation(H, W, opts) {
    var Hh = Math.floor(H * 0.5);
    var rng = new CPrng().seed(opts.seed);
    var m = new Array(Hh), n = new Array(W), i;
    for (i = 0; i < Hh; i++) m[i] = i;
    for (i = 0; i < W; i++) n[i] = i;
    if (opts.oldSeed) { rng.oldShuffle(m); rng.oldShuffle(n); }
    else { rng.shuffle(m); rng.shuffle(n); }
    return { m: m, n: n, Hh: Hh };
  }

  /* =========================================================================
   * 5. 合成（encode）
   * ======================================================================= */

  /**
   * 合成：image + watermark -> image(encoded)
   * @param {{w,h,planes}} img   原图（0..255）
   * @param {{w,h,planes}} wm    水印图（0..255）
   * @param {{seed:number, alpha:number, oldSeed:boolean, transform:string}} opts
   * @returns {Promise<{float:{w,h,planes}, hwm, rwm, m, n}>}
   */
  function encode(img, wm, opts, tick) {
    var H = img.h, W = img.w;
    var Hh = Math.floor(H * 0.5);
    if (wm.h >= Hh || wm.w >= W) {
      throw new Error('水印尺寸过大：需要高 < ' + Hh + ' 且宽 < ' + W
        + '（当前原图 ' + W + '×' + H + '，水印 ' + wm.w + '×' + wm.h + '）');
    }
    var tickFn = tick || function () { return Promise.resolve(); };
    var mode = opts.transform === 'channel' ? 'channel' : 'numpy';
    var L = H * W;
    var pat = buildPattern(H, W, wm, opts);
    var cx = planesToComplex(img.planes, H, W);
    var c, k;

    return transformImage(cx, H, W, false, mode, function (p) {
      return tickFn(p * 0.5);
    }).then(function () {
      // f2 = f1 + alpha * rwm（rwm 是实数组，只加到频域实部上）
      for (c = 0; c < 3; c++) {
        var rw = pat.rwm[c], re = cx.re[c], alpha = opts.alpha;
        for (k = 0; k < L; k++) re[k] += alpha * rw[k];
      }
      return transformImage(cx, H, W, true, mode, function (p) {
        return tickFn(0.5 + p * 0.5);
      });
    }).then(function () {
      // img_wm = real(ifft2(f2))，虚部按算法被丢弃
      return {
        float: { w: W, h: H, planes: cx.re.slice() },
        hwm: pat.hwm, rwm: pat.rwm, m: pat.m, n: pat.n
      };
    });
  }

  /* =========================================================================
   * 6. 分离（decode）
   * ======================================================================= */

  /**
   * 分离：image + image(encoded) -> watermark
   * @param {{w,h,planes}} img    原图
   * @param {{w,h,planes}} imgWm  含水印图
   * @param {{seed,alpha,oldSeed,transform,quantize}} opts
   *        quantize: 'py'（取模，对齐 numpy.uint8）| 'clamp'
   */
  function decode(img, imgWm, opts, tick) {
    var H = img.h, W = img.w;
    var tickFn = tick || function () { return Promise.resolve(); };
    var mode = opts.transform === 'channel' ? 'channel' : 'numpy';
    var perm = buildPermutation(H, W, opts);
    var m = perm.m, n = perm.n, Hh = perm.Hh;
    var useRound = opts.quantize === 'round';
    var L = H * W;

    var c1 = planesToComplex(img.planes, H, W);
    var c2 = planesToComplex(imgWm.planes, H, W);

    return transformImage(c1, H, W, false, mode, function (p) {
      return tickFn(p * 0.45);
    }).then(function () {
      return transformImage(c2, H, W, false, mode, function (p) {
        return tickFn(0.45 + p * 0.45);
      });
    }).then(function () {
      // rwm = real((f2 - f1) / alpha)
      var rawPlanes = zerosPlanes(L);
      var inv = 1 / opts.alpha, c, k;
      for (c = 0; c < 3; c++) {
        var f1 = c1.re[c], f2 = c2.re[c], out = rawPlanes[c];
        for (k = 0; k < L; k++) out[k] = (f2[k] - f1[k]) * inv;
      }
      return tickFn(0.9).then(function () { return rawPlanes; });
    }).then(function (rawPlanes) {
      // 逆排列：wm[m[i]][n[j]] = uint8(rwm[i][j])
      var wmPlanes = zerosPlanes(L), i, j, c2i;
      for (i = 0; i < Hh; i++) {
        var src = i * W;
        for (j = 0; j < W; j++) {
          var dst = m[i] * W + n[j];
          for (c2i = 0; c2i < 3; c2i++) {
            var v = rawPlanes[c2i][src + j];
            wmPlanes[c2i][dst] = useRound ? clampRound(v) : pyUint8(v);
          }
        }
      }
      // 下半部镜像
      for (i = 0; i < Hh; i++) {
        var s2 = i * W, d2 = (H - 1 - i) * W;
        for (j = 0; j < W; j++) {
          var dj = W - 1 - j;
          for (c2i = 0; c2i < 3; c2i++) wmPlanes[c2i][d2 + dj] = wmPlanes[c2i][s2 + j];
        }
      }
      return {
        wm: { w: W, h: H, planes: wmPlanes },
        raw: rawPlanes,
        f1: c1, f2: c2,
        Hh: Hh
      };
    });
  }

  /* =========================================================================
   * 7. 检测
   * ======================================================================= */

  /** 归一化互相关系数 */
  function ncc(a, b) {
    var n = a.length, i, ma = 0, mb = 0;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var num = 0, da = 0, db = 0, x, y;
    for (i = 0; i < n; i++) {
      x = a[i] - ma; y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    if (da === 0 || db === 0) return 0;
    return num / Math.sqrt(da * db);
  }

  /**
   * 精确检测：需要原图。
   * 核心判据 —— 该算法把水印直接叠加在频域的"实部"上，
   * 因此 d = fft(img_wm) - fft(img) 在理想情况下是纯实数的；
   * 若图中没有水印，d 完全来自量化/压缩误差，实部与虚部能量相当。
   * 于是 sqrt(E_re / E_im) 就是一个干净的存在性指标：
   *   ≈ 1        —— 没有水印（残差是复噪声）
   *   >> 1       —— 存在水印（残差被强制成实值）
   */
  function detectPair(img, imgWm, opts, tick) {
    var H = img.h, W = img.w;
    var tickFn = tick || function () { return Promise.resolve(); };
    var mode = opts.transform === 'channel' ? 'channel' : 'numpy';
    var L = H * W;
    var c1 = planesToComplex(img.planes, H, W);
    var c2 = planesToComplex(imgWm.planes, H, W);

    return transformImage(c1, H, W, false, mode, function (p) {
      return tickFn(p * 0.45);
    }).then(function () {
      return transformImage(c2, H, W, false, mode, function (p) {
        return tickFn(0.45 + p * 0.45);
      });
    }).then(function () {
      var eRe = 0, eIm = 0, c, k;
      for (c = 0; c < 3; c++) {
        var a = c1.re[c], b = c1.im[c], d = c2.re[c], e = c2.im[c];
        for (k = 0; k < L; k++) {
          var dr = d[k] - a[k], di = e[k] - b[k];
          eRe += dr * dr;
          eIm += di * di;
        }
      }
      var ratio = eIm > 0 ? Math.sqrt(eRe / eIm) : Infinity;
      return tickFn(1).then(function () {
        return { eRe: eRe, eIm: eIm, ratio: ratio };
      });
    });
  }

  /** 计算径向平均功率谱（用于无原图时的启发式盲检） */
  function radialSpectrum(img, tick) {
    var H = img.h, W = img.w;
    var tickFn = tick || function () { return Promise.resolve(); };
    // 灰度化 + 去均值 + Hann 窗
    var L = H * W;
    var g = new Float64Array(L), i, j, k;
    for (k = 0; k < L; k++) g[k] = (img.planes[0][k] + img.planes[1][k] + img.planes[2][k]) / 3;
    var mean = 0;
    for (k = 0; k < L; k++) mean += g[k];
    mean /= L;
    for (i = 0; i < H; i++) {
      var wy = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (H - 1));
      for (j = 0; j < W; j++) {
        var wx = 0.5 - 0.5 * Math.cos(2 * Math.PI * j / (W - 1));
        g[i * W + j] = (g[i * W + j] - mean) * wx * wy;
      }
    }
    var im = new Float64Array(L);
    var plan = makeFft2D(H, W);
    return plan.transformAsync(g, im, false, tickFn).then(function () {
      var nb = 48;
      var sum = new Float64Array(nb), cnt = new Float64Array(nb);
      var maxR = Math.min(H, W) / 2;
      for (i = 0; i < H; i++) {
        var fy = i <= H / 2 ? i : i - H;
        for (j = 0; j < W; j++) {
          var fx = j <= W / 2 ? j : j - W;
          var r = Math.sqrt(fx * fx + fy * fy) / maxR;
          if (r >= 1) continue;
          var bi = Math.min(nb - 1, Math.floor(r * nb));
          sum[bi] += g[i * W + j] * g[i * W + j] + im[i * W + j] * im[i * W + j];
          cnt[bi]++;
        }
      }
      var prof = new Float64Array(nb);
      for (k = 0; k < nb; k++) prof[k] = cnt[k] > 0 ? sum[k] / cnt[k] : 0;
      return { profile: prof, bins: nb };
    });
  }

  return {
    CPrng: CPrng,
    makeFft1D: makeFft1D,
    makeFft2D: makeFft2D,
    makeRadix2: makeRadix2,
    makeBluestein: makeBluestein,
    zerosPlanes: zerosPlanes,
    planesToComplex: planesToComplex,
    transformImage: transformImage,
    rgbaToPlanes: rgbaToPlanes,
    planesToRgba: planesToRgba,
    buildPattern: buildPattern,
    buildPermutation: buildPermutation,
    encode: encode,
    decode: decode,
    detectPair: detectPair,
    radialSpectrum: radialSpectrum,
    ncc: ncc,
    clampRound: clampRound,
    pyUint8: pyUint8
  };
});
