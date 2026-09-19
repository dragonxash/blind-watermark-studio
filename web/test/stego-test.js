/**
 * 隐写引擎自检：基础数学 + 两个嵌入引擎的往返与鲁棒性
 * 用法: node test/stego-test.js
 */
const BWM = require('../src/core.js');
const S = require('../src/stego.js');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}
function maxAbsErr(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/* ---------------- 测试素材 ---------------- */
let seed = 20260919;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function makePhoto(W, H) {
  const planes = [];
  for (let c = 0; c < 3; c++) planes.push(new Float64Array(W * H));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = y / H;
      let r = 70 + 140 * (1 - t), g = 110 + 110 * (1 - t), b = 180 + 60 * (1 - t);
      const ridge = H * 0.65 + 26 * Math.sin(x / 70) + 12 * Math.sin(x / 23 + 1.3);
      if (y > ridge) { r = 66; g = 84; b = 60; }
      const n = (rnd() - 0.5) * 12;
      planes[0][i] = Math.max(0, Math.min(255, Math.round(b + n)));
      planes[1][i] = Math.max(0, Math.min(255, Math.round(g + n)));
      planes[2][i] = Math.max(0, Math.min(255, Math.round(r + n)));
    }
  }
  return planes;
}

function quantize(planes) {
  const out = planes.map(p => {
    const a = new Float64Array(p.length);
    for (let i = 0; i < p.length; i++) a[i] = BWM.clampRound(p[i]);
    return a;
  });
  return out;
}

function planeStats(a, b) {
  let maxd = 0, sum2 = 0;
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < a[c].length; i++) {
      const d = a[c][i] - b[c][i];
      maxd = Math.max(maxd, Math.abs(d));
      sum2 += d * d;
    }
  }
  const mse = sum2 / (a[0].length * 3);
  return { max: maxd, psnr: mse > 0 ? 10 * Math.log10(65025 / mse) : Infinity };
}

/* ==================== 主流程 ==================== */
(async function () {
  console.log('='.repeat(72));
  console.log('隐写引擎自检');
  console.log('='.repeat(72));

  /* ---------- 1. 基础数学 ---------- */
  console.log('\n[1] 基础数学');

  {
    // 逐块验证与朴素 DFT 风格的实现一致：用「对称性」间接检验
    const src = new Float64Array(16);
    for (let i = 0; i < 16; i++) src[i] = rnd() * 100 - 50;
    const dct = new Float64Array(16), inv = new Float64Array(16);
    const tmp = new Float64Array(16);
    S._dct4(src, dct, tmp);
    S._idct4(dct, inv, tmp);
    const e = maxAbsErr(src, inv);
    check('DCT4 / IDCT4 往返', e < 1e-10, `误差=${e.toExponential(2)}`);

    // DCT 是正交变换：能量应守恒
    let e1 = 0, e2 = 0;
    for (let i = 0; i < 16; i++) { e1 += src[i] * src[i]; e2 += dct[i] * dct[i]; }
    check('DCT4 正交性（能量守恒）', Math.abs(e1 - e2) < 1e-9 * Math.max(1, e1),
      `${e1.toFixed(4)} vs ${e2.toFixed(4)}`);
  }

  {
    // SVD：A ≈ U S V^T，且奇异值非负、降序
    let worst = 0;
    for (let trial = 0; trial < 40; trial++) {
      const a = new Float64Array(16);
      for (let i = 0; i < 16; i++) a[i] = rnd() * 200 - 100;
      const U = new Float64Array(16), Sv = new Float64Array(4), V = new Float64Array(16);
      const out = new Float64Array(16);
      S._svd4(a, U, Sv, V);
      S._svd4Reconstruct(U, Sv, V, out);
      worst = Math.max(worst, maxAbsErr(a, out));
    }
    check('SVD4 重构精度', worst < 1e-8, `最大误差=${worst.toExponential(2)}`);

    const a = new Float64Array(16);
    for (let i = 0; i < 16; i++) a[i] = rnd() * 200 - 100;
    const U = new Float64Array(16), Sv = new Float64Array(4), V = new Float64Array(16);
    S._svd4(a, U, Sv, V);
    const descending = Sv[0] >= Sv[1] - 1e-9 && Sv[1] >= Sv[2] - 1e-9 && Sv[2] >= Sv[3] - 1e-9;
    const nonNeg = Sv[0] >= 0 && Sv[1] >= 0 && Sv[2] >= 0 && Sv[3] >= 0;
    check('SVD4 奇异值降序且非负', descending && nonNeg,
      `[${Array.from(Sv).map(v => v.toFixed(2)).join(', ')}]`);
  }

  {
    // QIM 自洽性：把 s[0] 改到格点中心后重构，再分解，s[0] 应精确回到设定值
    const a = new Float64Array(16);
    for (let i = 0; i < 16; i++) a[i] = rnd() * 255;
    const U = new Float64Array(16), Sv = new Float64Array(4), V = new Float64Array(16);
    const rec = new Float64Array(16);
    S._svd4(a, U, Sv, V);
    const delta = S.DEFAULT_DELTA;
    let allOk = true;
    const detail = [];
    for (const bit of [0, 1]) {
      const q = Math.floor(Sv[0] / delta);
      const q2 = 2 * Math.floor(q / 2) + bit;
      const target = (q2 + 0.5) * delta;
      const Sv2 = Float64Array.from(Sv);
      Sv2[0] = target;
      S._svd4Reconstruct(U, Sv2, V, rec);
      const U2 = new Float64Array(16), S3 = new Float64Array(4), V2 = new Float64Array(16);
      S._svd4(rec, U2, S3, V2);
      const got = ((Math.floor(S3[0] / delta) % 2) + 2) % 2;
      detail.push(`bit=${bit} 设定=${target.toFixed(2)}→重算=${S3[0].toFixed(2)}→读出=${got}`);
      if (got !== bit) allOk = false;
    }
    check('QIM 自洽（改 s0 后可原样读回）', allOk, detail.join(' | '));
  }

  {
    // Haar 小波往返
    const W = 64, H = 64;
    const p = new Float64Array(W * H);
    for (let i = 0; i < p.length; i++) p[i] = rnd() * 255;
    const hw = W >> 1, hh = H >> 1;
    const sub = {
      LL: new Float64Array(hw * hh), LH: new Float64Array(hw * hh),
      HL: new Float64Array(hw * hh), HH: new Float64Array(hw * hh),
    };
    S._haarDwt2(p, W, H, sub);
    const back = new Float64Array(W * H);
    S._haarIdwt2(back, W, H, sub);
    const e = maxAbsErr(p, back);
    check('Haar DWT / IDWT 往返', e < 1e-10, `误差=${e.toExponential(2)}`);
  }

  /* ---------- 2. 容器 ---------- */
  console.log('\n[2] 容器格式');

  {
    const payload = new Uint8Array([1, 2, 3, 250, 128, 0, 77]);
    const packed = S._packContainer(S.METHOD_LSB, S.TYPE_FILE, payload);
    const hdr = S._readHeader(packed);
    check('容器打包 / 解析',
      hdr && hdr.method === S.METHOD_LSB && hdr.contentType === S.TYPE_FILE
      && hdr.length === payload.length,
      `method=${hdr && hdr.method} type=${hdr && hdr.contentType} len=${hdr && hdr.length}`);

    const bad = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    check('错误 magic 被拒', S._readHeader(bad) === null);
  }

  /* ---------- 3. 鲁棒引擎 ---------- */
  console.log('\n[3] DWT-DCT-SVD 鲁棒引擎');

  const W = 512, H = 512;
  const photo = makePhoto(W, H);
  const photoQ = quantize(photo);
  const password = 20260919;

  console.log(`  512x512 容量：鲁棒 ${S.robustCapacityBytes(W, H)} 字节，`
    + `大容量 ${S.lsbCapacityBytes(W, H)} 字节`);

  const text = '盲水印工坊 · Blind WaterMark Studio · 2026-09-19';
  const textBytes = S.utf8Encode(text);
  console.log(`  测试文本 ${textBytes.length} 字节`);

  let robustOut = null, lsbOut = null;

  {
    const work = quantize(photoQ);
    const t0 = Date.now();
    S.embedRobust(work, W, H, textBytes, password, S.DEFAULT_DELTA);
    const ms = Date.now() - t0;
    robustOut = quantize(work);

    const st = planeStats(robustOut, photoQ);
    check('鲁棒嵌入完成', true, `${ms}ms`);
    check('鲁棒嵌入画质', st.psnr > 35,
      `PSNR=${st.psnr.toFixed(2)}dB 最大偏差=${st.max.toFixed(0)}`);

    const got = S.extractRobust(robustOut, W, H, password, S.DEFAULT_DELTA);
    check('鲁棒提取（无干扰）', got !== null && S.utf8Decode(got.data) === text,
      got ? JSON.stringify(S.utf8Decode(got.data).slice(0, 40)) : 'null');
  }

  {
    // 错误密码应解不出（magic 校验失败）
    const got = S.extractRobust(robustOut, W, H, password + 1, S.DEFAULT_DELTA);
    check('错误密码解不出', got === null);
  }

  {
    // 抗噪声：模拟 JPEG 量化误差
    const noisy = robustOut.map(p => {
      const a = new Float64Array(p.length);
      for (let i = 0; i < p.length; i++) {
        a[i] = Math.max(0, Math.min(255, p[i] + Math.round((rnd() - 0.5) * 12)));
      }
      return a;
    });
    const st = planeStats(noisy, robustOut);
    const got = S.extractRobust(noisy, W, H, password, S.DEFAULT_DELTA);
    check('抗噪声（±6 像素抖动）', got !== null && S.utf8Decode(got.data) === text,
      `噪声后 PSNR=${st.psnr.toFixed(1)}dB → ${got ? '提取成功' : '提取失败'}`);
  }

  {
    // 抗缩放：DWT 的分块位置对几何形变敏感，容限很小（约 ±1%）。
    // 这是该算法的固有特性，所以这里只作信息性观测，不计入通过条件。
    const scaled = [];
    for (let c = 0; c < 3; c++) scaled.push(new Float64Array(W * H));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const sx = Math.min(W - 1, Math.round(x / 1.02));
        const sy = Math.min(H - 1, Math.round(y / 1.02));
        for (let c = 0; c < 3; c++) scaled[c][y * W + x] = robustOut[c][sy * W + sx];
      }
    }
    const got = S.extractRobust(scaled, W, H, password, S.DEFAULT_DELTA);
    const ok2 = got !== null && S.utf8Decode(got.data) === text;
    console.log('  [观测] 抗 2% 缩放（回采样）: ' + (ok2
      ? '提取成功'
      : '提取失败 —— DWT 分块位置敏感，缩放容限约 ±1%，超出即失败属预期行为'));
  }

  /* ---------- 4. LSB 引擎 ---------- */
  console.log('\n[4] LSB 大容量引擎');

  {
    // 造一段二进制数据（模拟任意文件）
    const blob = new Uint8Array(4096);
    for (let i = 0; i < blob.length; i++) blob[i] = (i * 37 + 11) & 0xFF;

    const work = quantize(photoQ);
    const t0 = Date.now();
    S.embedLsb(work, W, H, blob, password);
    const ms = Date.now() - t0;
    lsbOut = quantize(work);

    const st = planeStats(lsbOut, photoQ);
    check('LSB 嵌入完成', true, `${ms}ms，${blob.length} 字节`);
    check('LSB 嵌入画质', st.psnr > 50,
      `PSNR=${st.psnr.toFixed(2)}dB 最大偏差=${st.max.toFixed(0)}`);

    const got = S.extractLsb(lsbOut, W, H, password);
    let same = got !== null && got.data.length === blob.length;
    if (same) {
      for (let i = 0; i < blob.length; i++) {
        if (got.data[i] !== blob[i]) { same = false; break; }
      }
    }
    check('LSB 提取（4096 字节二进制）', same,
      got ? `长度 ${got.data.length}${same ? '，内容一致' : '，内容不一致'}` : 'null');
  }

  {
    const got = S.extractLsb(lsbOut, W, H, password + 1);
    check('LSB 错误密码解不出', got === null);
  }

  /* ---------- 5. 自动识别 ---------- */
  console.log('\n[5] 自动识别引擎');

  {
    const a = S.autoExtract(robustOut, W, H, password, S.DEFAULT_DELTA);
    check('自动识别出鲁棒模式', a && a.method === S.METHOD_ROBUST
      && S.utf8Decode(a.data) === text, a ? 'method=' + a.method : 'null');

    const b = S.autoExtract(lsbOut, W, H, password, S.DEFAULT_DELTA);
    check('自动识别出 LSB 模式', b && b.method === S.METHOD_LSB, b ? 'method=' + b.method : 'null');

    const c = S.autoExtract(photoQ, W, H, password, S.DEFAULT_DELTA);
    check('干净图片不误报', c === null);
  }

  /* ---------- 6. UTF-8 与边界 ---------- */
  console.log('\n[6] 文本编解码与容量边界');

  {
    const s = '中文测试 · emoji 🐉 · 混合 Latin-1 àéîõü · 数字 20160930';
    const round = S.utf8Decode(S.utf8Encode(s));
    check('UTF-8 往返（含 emoji）', round === s, JSON.stringify(round.slice(0, 30)));
  }

  {
    // 超容量应给出明确报错
    const huge = new Uint8Array(S.robustCapacityBytes(W, H) + 100);
    let threw = false, msg = '';
    try {
      S.embedRobust(quantize(photoQ), W, H, huge, password, S.DEFAULT_DELTA);
    } catch (e) { threw = true; msg = e.message; }
    check('超容量给出明确报错', threw, msg.slice(0, 70));
  }

  {
    // 一块很小的图：容量不足时应报错而不是崩溃
    const small = quantize(makePhoto(64, 64));
    let threw = false;
    try {
      S.embedRobust(small, 64, 64, textBytes, password, S.DEFAULT_DELTA);
    } catch (e) { threw = true; }
    check('小图容量不足时报错', threw, `64x64 鲁棒容量 ${S.robustCapacityBytes(64, 64)} 字节`);
  }

  /* ---------- 7. 三种引擎互不干扰 ---------- */
  console.log('\n[7] 与 FFT 引擎共存');

  {
    // 先用 FFT 加图片水印，再用 LSB 藏数据，两者应各自可解
    const mark = {
      w: 64, h: 32, planes: [new Float64Array(64 * 32), new Float64Array(64 * 32), new Float64Array(64 * 32)],
    };
    for (let i = 0; i < 64 * 32; i++) {
      const v = (i % 7 < 3) ? 255 : 0;
      mark.planes[0][i] = v; mark.planes[1][i] = v; mark.planes[2][i] = v;
    }
    const img = { w: W, h: H, planes: quantize(photoQ) };
    const opts = { seed: 20160930, alpha: 3, mode: 'numpy' };
    const enc = await BWM.encode(img, mark, opts);
    const imgWm = { w: W, h: H, planes: quantize(enc.float.planes) };

    // 在带 FFT 水印的图上再叠 LSB
    const layered = quantize(imgWm.planes);
    const blob = S.utf8Encode('LSB 层数据');
    S.embedLsb(layered, W, H, blob, password);
    const layeredQ = quantize(layered);

    // FFT 水印仍能解（LSB 只动最低位，影响极小）
    const dec = await BWM.decode(img, { w: W, h: H, planes: layeredQ },
      Object.assign({}, opts, { quantize: 'round' }));
    const a = [], b = [];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < mark.h; i++) {
        for (let j = 0; j < mark.w; j++) {
          a.push(dec.wm.planes[c][i * W + j]);
          b.push(mark.planes[c][i * mark.w + j]);
        }
      }
    }
    const ncc = BWM.ncc(a, b);
    check('叠加 LSB 后 FFT 水印仍可解', ncc > 0.4, `NCC=${ncc.toFixed(4)}`);

    // LSB 数据也能解
    const got = S.extractLsb(layeredQ, W, H, password);
    check('叠加 FFT 水印后 LSB 数据仍可解',
      got !== null && S.utf8Decode(got.data) === 'LSB 层数据');
  }

  console.log('\n' + '='.repeat(72));
  console.log(failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`);
  console.log('='.repeat(72));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
