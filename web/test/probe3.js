const BWM = require('../src/core.js');

const W = 256, H = 256, L = W * H;

let seed = 99;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function makeIntPlanes() {
  const out = [];
  for (let c = 0; c < 3; c++) {
    const p = new Float64Array(L);
    for (let i = 0; i < L; i++) p[i] = Math.floor(rnd() * 256);
    out.push(p);
  }
  return out;
}
function makeMark(w, h) {
  const out = [];
  for (let c = 0; c < 3; c++) {
    const p = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) p[i] = ((i * 7 + c * 3) % 11 < 5) ? 255 : 0;
    out.push(p);
  }
  return { w, h, planes: out };
}

(async function () {
  const img = { w: W, h: H, planes: makeIntPlanes() };
  const wm = makeMark(72, 36);

  for (const mode of ['numpy', 'channel']) {
    const o = { seed: 20160930, alpha: 3, transform: mode };
    const enc = await BWM.encode(img, wm, o);

    let qmax = 0;
    const q = enc.float.planes.map((p, ci) => {
      const a = new Float64Array(p.length);
      for (let i = 0; i < p.length; i++) {
        a[i] = BWM.clampRound(p[i]);
        qmax = Math.max(qmax, Math.abs(a[i] - img.planes[ci][i]));
      }
      return a;
    });
    const encInt = { w: W, h: H, planes: q };

    const det = await BWM.detectPair(img, encInt, o);
    console.log(`[${mode}] 与原图最大差=${qmax}  eRe=${det.eRe.toExponential(3)}  eIm=${det.eIm.toExponential(3)}  ratio=${det.ratio.toExponential(3)}`);

    // 对照：两张完全无关的整数图
    const other = { w: W, h: H, planes: makeIntPlanes() };
    const detN = await BWM.detectPair(img, other, o);
    console.log(`[${mode}] 对照组(无关图)             eRe=${detN.eRe.toExponential(3)}  eIm=${detN.eIm.toExponential(3)}  ratio=${detN.ratio.toExponential(3)}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
