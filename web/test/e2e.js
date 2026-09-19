/**
 * 端到端实测：合成一张 512x512 的图 + 水印，跑完整 encode/decode，
 * 输出 PNG 供目视检查，并报告性能与质量指标。
 * 用法: node test/e2e.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const BWM = require('../src/core.js');

/* ---------------- 极简 PNG 编码器 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig, chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 构造测试素材 ---------------- */
function makePhoto(w, h) {
  // 天空渐变 + 两座山 + 细纹理，模拟一张有结构也有高频细节的照片
  const px = new Float64Array(w * h * 3);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y / h;
      let r = 60 + 150 * (1 - t), g = 110 + 120 * (1 - t), b = 190 + 65 * (1 - t);
      const h1 = h * 0.62 + 40 * Math.sin(x / 90) + 18 * Math.sin(x / 31 + 1.7);
      if (y > h1) { r = 70; g = 88; b = 62; }
      const h2 = h * 0.48 + 26 * Math.sin(x / 140 + 2.3);
      if (y > h2 && y <= h1) { r = 96; g = 104; b = 92; }
      const n = (rnd() - 0.5) * 9;
      const i = (y * w + x) * 3;
      px[i] = Math.max(0, Math.min(255, r + n));
      px[i + 1] = Math.max(0, Math.min(255, g + n));
      px[i + 2] = Math.max(0, Math.min(255, b + n));
    }
  }
  return { w, h, planes: planesFromInterleaved(px, w * h) };
}

const FONT = {
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  W: ['10001', '10001', '10001', '10001', '10101', '11011', '10001'],
  M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
};
function makeWatermark(text, scale) {
  const glyphW = 5, glyphH = 7, gap = 1;
  const cols = text.length * (glyphW + gap) - gap;
  const w = cols * scale + 2 * scale, h = (glyphH + 2) * scale;
  const px = new Uint8Array(w * h * 3).fill(0);   // 黑底
  let ox = scale;
  for (const ch of text) {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < glyphH; r++) {
      for (let c = 0; c < glyphW; c++) {
        if (g[r][c] === '1') {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const x = ox + c * scale + dx, y = (r + 1) * scale + dy;
              const i = (y * w + x) * 3;
              px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
            }
          }
        }
      }
    }
    ox += (glyphW + gap) * scale;
  }
  const f = new Float64Array(w * h * 3);
  for (let i = 0; i < f.length; i++) f[i] = px[i];
  return { w, h, planes: planesFromInterleaved(f, w * h) };
}

function planesFromInterleaved(flat, n) {
  const out = [];
  for (let c = 0; c < 3; c++) {
    const p = new Float64Array(n);
    for (let i = 0; i < n; i++) p[i] = flat[i * 3 + c];
    out.push(p);
  }
  return out;
}
function interleavedFromPlanes(planes, n) {
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = planes[0][i] < 0 ? 0 : planes[0][i] > 255 ? 255 : planes[0][i];
    out[i * 3 + 1] = planes[1][i] < 0 ? 0 : planes[1][i] > 255 ? 255 : planes[1][i];
    out[i * 3 + 2] = planes[2][i] < 0 ? 0 : planes[2][i] > 255 ? 255 : planes[2][i];
  }
  return out;
}
function toRGBA(planes, w, h) {
  const n = w * h, out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = Math.round(planes[0][i]);
    out[i * 4 + 1] = Math.round(planes[1][i]);
    out[i * 4 + 2] = Math.round(planes[2][i]);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/* ---------------- 主流程 ---------------- */
const OUT = path.join(__dirname, 'out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

(async function () {
  const W = 512, H = 512;
  const seed = 20160930, alpha = 3;

  const img = makePhoto(W, H);
  const wm = makeWatermark('BWM', 8);
  console.log(`原图 ${W}x${H}   水印 ${wm.w}x${wm.h}`);

  fs.writeFileSync(path.join(OUT, '0-original.png'), encodePNG(W, H, toRGBA(img.planes, W, H)));
  fs.writeFileSync(path.join(OUT, '1-watermark.png'), encodePNG(wm.w, wm.h, toRGBA(wm.planes, wm.w, wm.h)));

  const opts = { seed, alpha, oldSeed: false, transform: 'numpy' };

  /* --- 两种变换模式各跑一次，便于对比 --- */
  for (const mode of ['numpy', 'channel']) {
    const o = Object.assign({}, opts, { transform: mode });
    const t0 = Date.now();
    const enc = await BWM.encode(img, wm, o);
    const tEnc = Date.now() - t0;

    // 量化成 uint8（对齐 OpenCV saturate_cast）
    const q = enc.float.planes.map(p => {
      const a = new Float64Array(p.length);
      for (let i = 0; i < p.length; i++) a[i] = BWM.clampRound(p[i]);
      return a;
    });
    const imgWm = { w: W, h: H, planes: q };

    let sum2 = 0, maxd = 0;
    for (let i = 0; i < W * H * 3; i++) {
      const d = q[Math.floor(i / (W * H))][i % (W * H)] - img.planes[Math.floor(i / (W * H))][i % (W * H)];
      sum2 += d * d;
      maxd = Math.max(maxd, Math.abs(d));
    }
    const mse = sum2 / (W * H * 3);
    const psnr = 10 * Math.log10(255 * 255 / mse);

    const t1 = Date.now();
    const dec = await BWM.decode(img, imgWm, Object.assign({}, o, { quantize: 'round' }));
    const tDec = Date.now() - t1;

    fs.writeFileSync(path.join(OUT, `2-encoded-${mode}.png`), encodePNG(W, H, toRGBA(q, W, H)));
    fs.writeFileSync(path.join(OUT, `3-decoded-${mode}.png`),
      encodePNG(W, H, toRGBA(dec.wm.planes, W, H)));

    // 残差增强图：把 (encoded - original) 放大 8 倍 + 128 偏置，便于目视判断水印痕迹
    const res = [];
    for (let c = 0; c < 3; c++) {
      const p = new Float64Array(W * H);
      for (let i = 0; i < W * H; i++) p[i] = 128 + (q[c][i] - img.planes[c][i]) * 8;
      res.push(p);
    }
    fs.writeFileSync(path.join(OUT, `4-residual-${mode}.png`), encodePNG(W, H, toRGBA(res, W, H)));

    // 解码图左上角（水印实际落点）与原水印的 NCC
    const a = [], b = [];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < wm.h; i++) {
        for (let j = 0; j < wm.w; j++) {
          a.push(dec.wm.planes[c][i * W + j]);
          b.push(wm.planes[c][i * wm.w + j]);
        }
      }
    }
    const ncc = BWM.ncc(a, b);

    // 精确检测指标
    const det = await BWM.detectPair(img, imgWm, o);
    // 反例：拿两张无关图做同样的检测
    const noise = makePhoto(W, H);
    for (let i = 0; i < noise.planes[0].length; i++) noise.planes[0][i] = (noise.planes[0][i] * 7 + 31) % 256;
    const detNeg = await BWM.detectPair(img, noise, o);

    console.log(`\n--- transform=${mode} ---`);
    console.log(`  合成耗时 ${tEnc}ms   分离耗时 ${tDec}ms`);
    console.log(`  与原图差异: 最大 ${maxd.toFixed(1)} / MSE ${mse.toFixed(3)} / PSNR ${psnr.toFixed(2)} dB`);
    console.log(`  解码水印 NCC = ${ncc.toFixed(4)}`);
    console.log(`  检测指标 sqrt(E_re/E_im): 含水印图 ${det.ratio.toFixed(3)}   无关图 ${detNeg.ratio.toFixed(3)}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
