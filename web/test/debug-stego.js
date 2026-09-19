const BWM = require('../src/core.js');
const S = require('../src/stego.js');

let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const W = 64, H = 64;
const planes = [0, 1, 2].map(() => {
  const p = new Float64Array(W * H);
  for (let i = 0; i < p.length; i++) p[i] = Math.round(rnd() * 255);
  return p;
});
const before = planes.map(p => Float64Array.from(p));

const payload = S.utf8Encode('hi');
const container = S._packContainer(S.METHOD_ROBUST, payload);
console.log('payload:', payload.length, '字节; 容器:', container.length, '字节 =',
  container.length * 8, 'bits');
console.log('容量:', S.robustCapacityBits(W, H), 'bits');
console.log('容器十六进制:', Array.from(container).map(b => b.toString(16).padStart(2, '0')).join(' '));

/* ---------- 1. 单块验证：把 bit 写进 LL 的第一个块，立刻读回 ---------- */
console.log('\n--- 1. 单块直通 ---');
{
  const hw = W >> 1, hh = H >> 1;
  const sub = {
    LL: new Float64Array(hw * hh), LH: new Float64Array(hw * hh),
    HL: new Float64Array(hw * hh), HH: new Float64Array(hw * hh),
  };
  S._haarDwt2(before[0], W, H, sub);
  const LLcopy = Float64Array.from(sub.LL);

  const sc = {
    block: new Float64Array(16), dct: new Float64Array(16), tmp: new Float64Array(16),
    rec: new Float64Array(16), U: new Float64Array(16), S: new Float64Array(4),
    V: new Float64Array(16),
  };
  const bw = hw >> 2;
  // 用一个临时的 processBlock 复现逻辑
  function proc(LL, bw, idx, writeBit, delta) {
    const by = (idx / bw) | 0, bx = idx % bw;
    const y0 = by << 2, x0 = bx << 2;
    for (let i = 0; i < 16; i++) sc.block[i] = LL[(y0 + (i >> 2)) * bw + (x0 + (i & 3))];
    // 复制 stego 内部的 dct4/idct4 行为
    const dct = new Float64Array(16), tmp = new Float64Array(16), rec = new Float64Array(16);
    const U = new Float64Array(16), Sv = new Float64Array(4), V = new Float64Array(16);
    S._dct4(sc.block, dct, tmp);
    S._svd4(dct, U, Sv, V);
    if (writeBit >= 0) {
      const delta2 = delta;
      const q = Math.floor(Sv[0] / delta2);
      const q2 = 2 * Math.floor(q / 2) + (writeBit & 1);
      Sv[0] = (q2 + 0.5) * delta2;
      S._svd4Reconstruct(U, Sv, V, rec);
      S._idct4(rec, dct, tmp);
      for (let i = 0; i < 16; i++) LL[(y0 + (i >> 2)) * bw + (x0 + (i & 3))] = dct[i];
      return 0;
    }
    let q = Math.floor(Sv[0] / delta);
    return ((q % 2) + 2) % 2;
  }

  for (const bit of [0, 1]) {
    const LL = Float64Array.from(LLcopy);
    proc(LL, bw, 0, bit, 36);
    const back = proc(LL, bw, 0, -1, 36);
    console.log(`   bit=${bit} → 读回 ${back}  ${back === bit ? 'OK' : '不符'}`);
  }

  // 检查 DWT 往返是否真的无损（用修改后的 LL 重构再分解）
  {
    const LL = Float64Array.from(LLcopy);
    proc(LL, bw, 0, 1, 36);
    const sub2 = { LL: LL, LH: sub.LH, HL: sub.HL, HH: sub.HH };
    const img = new Float64Array(W * H);
    S._haarIdwt2(img, W, H, sub2);
    const sub3 = {
      LL: new Float64Array(hw * hh), LH: new Float64Array(hw * hh),
      HL: new Float64Array(hw * hh), HH: new Float64Array(hw * hh),
    };
    S._haarDwt2(img, W, H, sub3);
    let maxd = 0;
    for (let i = 0; i < LL.length; i++) maxd = Math.max(maxd, Math.abs(LL[i] - sub3.LL[i]));
    console.log(`   经 DWT 往返后 LL 最大变化 = ${maxd.toExponential(3)}`);
    const back = proc(sub3.LL, bw, 0, -1, 36);
    console.log(`   经 DWT 往返后读回 = ${back}  ${back === 1 ? 'OK' : '不符'}`);
  }
}

/* ---------- 2. 整体嵌入 / 提取 ---------- */
console.log('\n--- 2. 整体流程 ---');
S.embedRobust(planes, W, H, payload, 7, 36);
let maxChange = 0;
for (let c = 0; c < 3; c++) {
  for (let i = 0; i < before[c].length; i++) {
    maxChange = Math.max(maxChange, Math.abs(planes[c][i] - before[c][i]));
  }
}
console.log('   嵌入后最大像素改动 =', maxChange.toFixed(3));

const got = S.extractRobust(planes, W, H, 7, 36);
console.log('   提取结果:', got ? JSON.stringify(S.utf8Decode(got)) : 'null');

/* ---------- 3. 直接读回 bit 流，看头部对不对 ---------- */
console.log('\n--- 3. 逐 bit 检查 ---');
{
  const bw = ((W >> 1) >> 2), bh = ((H >> 1) >> 2);
  const cap = bw * bh * 3;
  const order = S.makeOrder(cap, 7);
  const hw = W >> 1, hh = H >> 1;
  const subs = [];
  for (let c = 0; c < 3; c++) {
    const sub = {
      LL: new Float64Array(hw * hh), LH: new Float64Array(hw * hh),
      HL: new Float64Array(hw * hh), HH: new Float64Array(hw * hh),
    };
    S._haarDwt2(planes[c], W, H, sub);
    subs.push(sub);
  }
  const perChannel = bw * bh;
  const bits = [];
  const dct = new Float64Array(16), tmp = new Float64Array(16);
  const U = new Float64Array(16), Sv = new Float64Array(4), V = new Float64Array(16);
  for (let i = 0; i < 80; i++) {
    const p = order[i];
    const c = (p / perChannel) | 0;
    if (c > 2) { bits.push(0); continue; }
    const LL = subs[c].LL, idx = p % perChannel;
    const by = (idx / bw) | 0, bx = idx % bw;
    const y0 = by << 2, x0 = bx << 2;
    const blk = new Float64Array(16);
    for (let m = 0; m < 16; m++) blk[m] = LL[(y0 + (m >> 2)) * bw + (x0 + (m & 3))];
    S._dct4(blk, dct, tmp);
    S._svd4(dct, U, Sv, V);
    bits.push(((Math.floor(Sv[0] / 36) % 2) + 2) % 2);
  }
  // 拼成字节
  const bytes = [];
  for (let i = 0; i < 8; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    bytes.push(v);
  }
  console.log('   读出的前 8 字节:',
    bytes.map(b => b.toString(16).padStart(2, '0')).join(' '));
  console.log('   期望的前 8 字节:',
    Array.from(container.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));

  let match = 0;
  for (let i = 0; i < 8; i++) if (bytes[i] === container[i]) match++;
  console.log(`   前 8 字节中匹配 ${match} 个`);

  // 逐 bit 比对正确性
  const expected = [];
  for (let i = 0; i < container.length; i++) {
    for (let b = 0; b < 8; b++) expected.push((container[i] >> (7 - b)) & 1);
  }
  let bitMatch = 0;
  for (let i = 0; i < 80; i++) if (bits[i] === expected[i]) bitMatch++;
  console.log(`   前 80 个 bit 中匹配 ${bitMatch} 个`);
}
