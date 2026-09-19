const fs = require('fs');
const path = require('path');
const BWM = require('../src/core.js');
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'ref.json'), 'utf8'));
const { H, W } = ref.meta;

// --- 1. n=4 手算对照 ---
{
  const plan = BWM.makeFft1D(4);
  const re = Float64Array.from([1, 2, 3, 4]);
  const im = new Float64Array(4);
  plan.forward(re, im);
  console.log('n=4 FFT of [1,2,3,4]:');
  console.log('  js   :', Array.from(re).map((v, i) => `${v.toFixed(6)}${im[i] >= 0 ? '+' : '-'}${Math.abs(im[i]).toFixed(6)}i`).join('  '));
  console.log('  truth: 10+0i  -2+2i  -2+0i  -2-2i');
}

// --- 2. 2D FFT 前几个值对照 ---
{
  const plan = BWM.makeFft2D(H, W);
  const re = new Float64Array(W * H), im = new Float64Array(W * H);
  const ch0 = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) ch0[i] = ref.input_img[i * 3 + 0];
  re.set(ch0);
  plan.transform(re, im, false);
  console.log('\nfft2(img) 通道0 前 8 个频点:');
  for (let k = 0; k < 8; k++) {
    const pyR = ref.f1_re[k * 3 + 0], pyI = ref.f1_im[k * 3 + 0];
    console.log(`  [${k}] js=(${re[k].toFixed(3)}, ${im[k].toFixed(3)})   py=(${pyR.toFixed(3)}, ${pyI.toFixed(3)})`);
  }
  // 有没有可能是"共轭"或者"频域平移"的差异？
  let conjErr = 0, shiftErr = 0;
  for (let i = 0; i < W * H; i++) {
    const pyR = ref.f1_re[i * 3 + 0], pyI = ref.f1_im[i * 3 + 0];
    conjErr = Math.max(conjErr, Math.abs(re[i] - pyR), Math.abs(im[i] + pyI));
  }
  console.log('  若 js 是 py 的共轭，误差 =', conjErr.toExponential(2));

  // 反转频率轴
  let flipErr = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fy = (H - y) % H, fx = (W - x) % W;
    const jsR = re[fy * W + fx], jsI = im[fy * W + fx];
    const pyR = ref.f1_re[(y * W + x) * 3 + 0], pyI = ref.f1_im[(y * W + x) * 3 + 0];
    flipErr = Math.max(flipErr, Math.abs(jsR - pyR), Math.abs(jsI - pyI));
  }
  console.log('  若 js 是 py 的频率翻转，误差 =', flipErr.toExponential(2));

  // 只做行变换（1D 每行）与 numpy 的 rfft 对照意义不大；改为检查 0 号频点
  let sum = 0;
  for (let i = 0; i < W * H; i++) sum += ch0[i];
  console.log(`  DC 应为 sum(img)=${sum}，js 得到 ${re[0].toFixed(3)}，py 为 ${ref.f1_re[0].toFixed(3)}`);
}
