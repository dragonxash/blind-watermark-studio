/**
 * 验证 JS 核心实现与 Python 参考实现（bwmforpy3.py）逐位一致。
 * 用法: node test/verify.js
 */
const fs = require('fs');
const path = require('path');
const BWM = require('../src/core.js');

const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'ref.json'), 'utf8'));
const { H, W, WH, WW, seed, alpha } = ref.meta;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}
function maxAbsErr(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

(async function main() {
  console.log('='.repeat(72));
  console.log('BlindWaterMark Web — JS 核心 vs Python 参考实现');
  console.log(`图像 ${W}x${H}  水印 ${WW}x${WH}  seed=${seed}  alpha=${alpha}`);
  console.log('='.repeat(72));

  /* ---------------- 1. 随机数 ---------------- */
  console.log('\n[1] CPython MT19937 随机序列');

  let rng = new BWM.CPrng().seed(seed);
  let x = Array.from({ length: 1000 }, (_, i) => i);
  rng.shuffle(x);
  check('shuffle(1000) 前 40 项',
    JSON.stringify(x.slice(0, 40)) === JSON.stringify(ref.rng.shuffle1000_head));
  const ck = x.reduce((s, v, i) => s + v * (i + 1), 0);
  check('shuffle(1000) 加权校验和',
    ck === ref.rng.shuffle1000_ck, `js=${ck} py=${ref.rng.shuffle1000_ck}`);

  rng = new BWM.CPrng().seed(seed);
  const rb = Array.from({ length: 24 }, () => rng.randbelow(100));
  check('randbelow(100) x24', JSON.stringify(rb) === JSON.stringify(ref.rng.randbelow100));

  rng = new BWM.CPrng().seed(seed);
  const gb = Array.from({ length: 12 }, () => rng.getrandbits(20));
  check('getrandbits(20) x12', JSON.stringify(gb) === JSON.stringify(ref.rng.getrandbits20));

  rng = new BWM.CPrng().seed(seed);
  const rs = Array.from({ length: 6 }, () => rng.random());
  check('random() x6', maxAbsErr(rs, ref.rng.random_seq) === 0,
    `maxerr=${maxAbsErr(rs, ref.rng.random_seq)}`);

  rng = new BWM.CPrng().seed(seed);
  const y17 = Array.from({ length: 17 }, (_, i) => i);
  rng.shuffle(y17);
  check('shuffle(17)', JSON.stringify(y17) === JSON.stringify(ref.rng.shuffle17));

  // 多种子交叉验证
  let seedOk = true;
  for (const s of [0, 1, 42, 20160930, 123456789, 2147483647, -7]) {
    const r = new BWM.CPrng().seed(s);
    const arr = Array.from({ length: 30 }, () => r.randbelow(1000));
    // 与 Python 端无法即席比对，这里只检查分布合理性
    if (arr.some(v => !(v >= 0 && v < 1000))) seedOk = false;
  }
  check('多种子无越界', seedOk);

  /* ---------------- 2. 排列 ---------------- */
  console.log('\n[2] 水印置换排列 m / n');
  const perm = BWM.buildPermutation(H, W, { seed, oldSeed: false });
  check('m 排列', JSON.stringify(perm.m) === JSON.stringify(ref.m));
  check('n 排列', JSON.stringify(perm.n) === JSON.stringify(ref.n));

  /* ---------------- 2.5 图案构造与 FFT ---------------- */
  console.log('\n[2.5] 中间量逐步定位');

  const planesOf = (flat, w, h) => {
    const n = w * h, out = [];
    for (let c = 0; c < 3; c++) {
      const p = new Float64Array(n);
      for (let i = 0; i < n; i++) p[i] = flat[i * 3 + c];
      out.push(p);
    }
    return { w, h, planes: out };
  };
  const toInterleaved = (planes, n) => {
    const out = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = planes[c][i];
    return out;
  };

  const img = planesOf(ref.input_img, W, H);
  const wm = planesOf(ref.input_wm, WW, WH);

  const pat = BWM.buildPattern(H, W, wm, { seed, oldSeed: false });
  const hwmFlat = toInterleaved(pat.hwm, pat.Hh * W);
  const rwmFlat = toInterleaved(pat.rwm, W * H);
  check('图案 hwm（打散后的半高图案）', maxAbsErr(hwmFlat, ref.hwm) === 0,
    `误差=${maxAbsErr(hwmFlat, ref.hwm)}`);
  check('图案 rwm（镜像后的全画布）', maxAbsErr(rwmFlat, ref.rwm) === 0,
    `误差=${maxAbsErr(rwmFlat, ref.rwm)}`);

  // 二维 FFT 与 numpy 直接对照（复刻 axes=(-2,-1) 的行为）
  {
    const pickChannel = (flat, n, c) => {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = flat[i * 3 + c];
      return out;
    };
    const cx = BWM.planesToComplex(img.planes, H, W);
    await BWM.transformImage(cx, H, W, false, 'numpy');
    for (let c = 0; c < 3; c++) {
      const eR = maxAbsErr(cx.re[c], pickChannel(ref.f1_re, W * H, c));
      const eI = maxAbsErr(cx.im[c], pickChannel(ref.f1_im, W * H, c));
      check(`fft2(img) 通道${c} vs numpy`, eR < 1e-6 && eI < 1e-6,
        `实部误差=${eR.toExponential(2)} 虚部误差=${eI.toExponential(2)}`);
    }
  }

  /* ---------------- 3. encode / decode ---------------- */
  console.log('\n[3] encode / decode 数值一致性');

  const t0 = Date.now();
  const enc = await BWM.encode(img, wm, { seed, alpha, oldSeed: false, transform: 'numpy' });
  const tEnc = Date.now() - t0;

  const encFlat = toInterleaved(enc.float.planes, W * H);
  const encErr = maxAbsErr(encFlat, ref.enc_float);
  check('encode 输出（float）', encErr < 1e-5, `最大绝对误差=${encErr.toExponential(3)}  (${tEnc}ms)`);

  const t1 = Date.now();
  const dec = await BWM.decode(img, enc.float,
    { seed, alpha, oldSeed: false, transform: 'numpy', quantize: 'trunc' });
  const tDec = Date.now() - t1;

  // ref.dec_float 是未量化的 rwm（即 real((f2-f1)/alpha)），对应 JS 的 dec.raw
  const rawFlat = toInterleaved(dec.raw, W * H);
  const rawErr = maxAbsErr(rawFlat, ref.dec_float);
  check('decode 中间量 rwm（float）', rawErr < 1e-5,
    `最大绝对误差=${rawErr.toExponential(3)}  (${tDec}ms)`);

  // uint8 量化只在 rwm 落在整数边界时敏感；JS 与 numpy 的 FFT 舍入方向不同，
  // 会在这类边界上产生 ±1 的差异。水印区域约占 1/6，故差异比例上限设为 20%。
  const decFlat = toInterleaved(dec.wm.planes, W * H);
  let diffU8 = 0, maxU8 = 0;
  for (let i = 0; i < decFlat.length; i++) {
    const d = Math.abs(decFlat[i] - ref.dec_uint8[i]);
    if (d > 0) { diffU8++; if (d > maxU8) maxU8 = d; }
  }
  check('decode 输出（uint8，容差 ±1）', maxU8 <= 1 && diffU8 / decFlat.length < 0.2,
    `差异元素 ${diffU8}/${decFlat.length} (${(diffU8 / decFlat.length * 100).toFixed(1)}%)，最大差 ${maxU8}`);

  /* ---------------- 4. FFT 自检 ---------------- */
  console.log('\n[4] FFT 自检（任意长度）');
  for (const n of [16, 17, 60, 64, 100, 128, 210, 256]) {
    const plan = BWM.makeFft1D(n);
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.7) * 10 + i * 0.3;
    const orig = Float64Array.from(re);
    plan.forward(re, im);
    plan.inverse(re, im);
    const e = maxAbsErr(re, orig);
    check(`FFT round-trip n=${n} ${(n & (n - 1)) === 0 ? '(radix-2)' : '(Bluestein)'}`,
      e < 1e-9, `误差=${e.toExponential(2)}`);
  }

  // 与朴素 DFT 对照
  {
    const n = 17;
    const plan = BWM.makeFft1D(n);
    const sig = new Float64Array(n);
    for (let i = 0; i < n; i++) sig[i] = Math.cos(i * 1.1) * 5;
    const re = Float64Array.from(sig), im = new Float64Array(n);
    plan.forward(re, im);
    let e = 0;
    for (let k = 0; k < n; k++) {
      let sr = 0, si = 0;
      for (let t = 0; t < n; t++) {
        const a = -2 * Math.PI * k * t / n;
        sr += sig[t] * Math.cos(a);
        si += sig[t] * Math.sin(a);
      }
      e = Math.max(e, Math.abs(sr - re[k]), Math.abs(si - im[k]));
    }
    check('Bluestein vs 朴素 DFT (n=17)', e < 1e-9, `误差=${e.toExponential(2)}`);
  }

  /* ---------------- 5. 端到端质量 ---------------- */
  console.log('\n[5] 端到端质量指标');
  const encOut = enc.float;
  let maxDev = 0;
  for (let i = 0; i < W * H * 3; i++) maxDev = Math.max(maxDev, Math.abs(encFlat[i] - ref.input_img[i]));
  console.log(`  encode 后与原图的最大像素偏差: ${maxDev.toFixed(3)}`);

  // 解码图左上 WH x WW 与原始水印的 NCC
  const aArr = [], bArr = [];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < WH; i++) {
      for (let j = 0; j < WW; j++) {
        aArr.push(dec.wm.planes[c][i * W + j]);
        bArr.push(ref.input_wm[(i * WW + j) * 3 + c]);
      }
    }
  }
  const nccVal = BWM.ncc(aArr, bArr);
  console.log(`  解码水印 vs 原始水印 NCC: ${nccVal.toFixed(4)}`);
  console.log(`  (理论上限 ≈ 0.5~0.7，源于原作镜像错位 1 像素造成的对角双影)`);

  console.log('\n' + '='.repeat(72));
  console.log(failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`);
  console.log('='.repeat(72));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
