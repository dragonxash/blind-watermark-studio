const BWM = require('../src/core.js');

const W = 64, H = 64;
const L = W * H;

// 造一张整数灰度/彩色图
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function makePlanes() {
  const out = [];
  for (let c = 0; c < 3; c++) {
    const p = new Float64Array(L);
    for (let i = 0; i < L; i++) p[i] = Math.floor(rnd() * 256);
    out.push(p);
  }
  return out;
}

(async function () {
  const planes = makePlanes();

  for (const mode of ['numpy', 'channel']) {
    const cx = BWM.planesToComplex(planes, H, W);
    await BWM.transformImage(cx, H, W, false, mode);

    let eRe = 0, eIm = 0, maxIm = 0;
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < L; k++) {
        eRe += cx.re[c][k] * cx.re[c][k];
        eIm += cx.im[c][k] * cx.im[c][k];
        maxIm = Math.max(maxIm, Math.abs(cx.im[c][k]));
      }
    }
    console.log(`[${mode}] 变换后 实部能量=${eRe.toExponential(3)} 虚部能量=${eIm.toExponential(3)} 最大虚部=${maxIm.toExponential(3)}`);

    // 逆变换应还原
    await BWM.transformImage(cx, H, W, true, mode);
    let err = 0;
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < L; k++) err = Math.max(err, Math.abs(cx.re[c][k] - planes[c][k]));
    }
    console.log(`[${mode}] 逆变换还原误差=${err.toExponential(3)}`);
    console.log(`[${mode}] 逆变换后虚部最大=${Math.max(...[0, 1, 2].map(c => Math.max(...Array.from(cx.im[c]).map(Math.abs)))).toExponential(3)}`);
  }

  // 直接比对：两张只差 1 的图，频谱差的虚部应该非零
  const planes2 = planes.map(p => Float64Array.from(p));
  planes2[0][5] += 1;
  for (const mode of ['numpy', 'channel']) {
    const a = BWM.planesToComplex(planes, H, W);
    const b = BWM.planesToComplex(planes2, H, W);
    await BWM.transformImage(a, H, W, false, mode);
    await BWM.transformImage(b, H, W, false, mode);
    let eRe = 0, eIm = 0;
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < L; k++) {
        const dr = b.re[c][k] - a.re[c][k], di = b.im[c][k] - a.im[c][k];
        eRe += dr * dr; eIm += di * di;
      }
    }
    console.log(`[${mode}] 单像素扰动1: 实部能量=${eRe.toExponential(3)} 虚部能量=${eIm.toExponential(3)} ratio=${Math.sqrt(eRe / Math.max(eIm, 1e-300)).toExponential(3)}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
