/*!
 * 生成隐写引擎的跨语言参考向量（供 Kotlin 单元测试比对）。
 *
 * 输入图由固定 LCG 生成，Kotlin 端用同一算法复现，因此不必把像素写进 JSON。
 * 输出包含：
 *   - makeOrder 的置换参考（前 32 项 + 加权校验和）
 *   - LSB 嵌入后的整数量化像素（hex）—— LSB 全是整数运算，两端应当逐字节相等
 *   - robust 嵌入后的整数量化像素（hex）—— 供 Kotlin 端做「JS 嵌入 → Kotlin 提取」
 *
 * 用法：node test/make-stego-ref.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const S = require(path.join(__dirname, '..', 'src', 'stego.js'));

const W = 128;
const H = 128;
const NPX = W * H;

const LCG_SEED = 20260919;
const PASSWORD = 20260919;
const DELTA = S.DEFAULT_DELTA;

const OUT = path.join(__dirname, 'stego-ref.json');

/* ---------------- 确定性输入图（Kotlin 端用同一 LCG 复现） ---------------- */

let lcg = LCG_SEED | 0;
function nextRand() {
  lcg = (Math.imul(lcg, 1103515245) + 12345) & 0x7fffffff;
  return lcg;
}

const srcPix = new Uint8Array(NPX * 3);
for (let i = 0; i < srcPix.length; i++) srcPix[i] = nextRand() % 256;

/* ---------------- 工具（与 Kotlin 侧保持同一布局：index = i*3 + c） ---------------- */

function toPlanes(pix) {
  const out = [];
  for (let c = 0; c < 3; c++) {
    const p = new Float64Array(NPX);
    for (let i = 0; i < NPX; i++) p[i] = pix[i * 3 + c];
    out.push(p);
  }
  return out;
}

function quantize(planes) {
  const out = new Uint8Array(NPX * 3);
  for (let i = 0; i < NPX; i++) {
    for (let c = 0; c < 3; c++) {
      let v = Math.floor(planes[c][i]);
      if (!(v >= 0)) v = 0;
      if (v > 255) v = 255;
      out[i * 3 + c] = v;
    }
  }
  return out;
}

const hex = (u8) => Buffer.from(u8).toString('hex');

function orderRef(n, password) {
  const o = S.makeOrder(n, password);
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += o[i] * (i + 1);
  return {
    n: n,
    password: password,
    head: Array.from(o.slice(0, 32)),
    weighted: weighted,
  };
}

/* ---------------- 1. 置换参考 ---------------- */

const robustCapBits = S.robustCapacityBits(W, H);
const lsbCapBits = S.lsbCapacityBits(W, H);

const orders = [
  orderRef(robustCapBits, PASSWORD),
  orderRef(lsbCapBits, PASSWORD),
  orderRef(1024, PASSWORD),
  orderRef(300, 777),
  orderRef(500, 0),
];

console.log('鲁棒容量 =', robustCapBits, 'bit (' + S.robustCapacityBytes(W, H) + ' 字节)');
console.log('LSB 容量 =', lsbCapBits, 'bit (' + S.lsbCapacityBytes(W, H) + ' 字节)');

/* ---------------- 2. LSB：嵌入 ---------------- */

const lsbPayload = new Uint8Array(512);
for (let i = 0; i < lsbPayload.length; i++) lsbPayload[i] = (i * 37 + 11) & 0xFF;

const lsbPlanes = toPlanes(srcPix);
S.embedLsb(lsbPlanes, W, H, lsbPayload, PASSWORD, null, S.TYPE_FILE);
const lsbOut = quantize(lsbPlanes);

// 自检：JS 自己能解回来
const lsbBack = S.extractLsb(toPlanes(lsbOut), W, H, PASSWORD);
let lsbOk = lsbBack && lsbBack.data.length === lsbPayload.length;
if (lsbOk) {
  for (let i = 0; i < lsbPayload.length; i++) {
    if (lsbBack.data[i] !== lsbPayload[i]) { lsbOk = false; break; }
  }
}
console.log('LSB 自检 =', lsbOk ? 'OK' : '失败', ' contentType =', lsbBack && lsbBack.contentType);

let changedBits = 0;
for (let i = 0; i < srcPix.length; i++) {
  const d = srcPix[i] ^ lsbOut[i];
  let v = d;
  while (v) { changedBits += v & 1; v >>= 1; }
}
console.log('LSB 改动的像素位 =', changedBits);

/* ---------------- 3. 鲁棒：嵌入 ---------------- */

const robustText = '盲水印工坊 · 跨语言互操作 · 龙000';
const robustPayload = S.utf8Encode(robustText);
console.log('鲁棒 payload =', robustPayload.length, '字节（UTF-8）');
if (robustPayload.length + S.HEADER_BYTES > S.robustCapacityBytes(W, H)) {
  throw new Error('测试用文本超出鲁棒容量');
}

const rPlanes = toPlanes(srcPix);
S.embedRobust(rPlanes, W, H, robustPayload, PASSWORD, DELTA, null, S.TYPE_TEXT);
const robustOut = quantize(rPlanes);

const rBack = S.extractRobust(toPlanes(robustOut), W, H, PASSWORD, DELTA);
const rBackText = rBack ? S.utf8Decode(rBack.data) : null;
console.log('鲁棒自检 =', rBackText === robustText ? 'OK' : '失败',
  JSON.stringify(rBackText), ' contentType =', rBack && rBack.contentType);

/* ---------------- 4. 错误密码应当解不出 ---------------- */

const wrongLsb = S.extractLsb(toPlanes(lsbOut), W, H, PASSWORD + 1);
const wrongRobust = S.extractRobust(toPlanes(robustOut), W, H, PASSWORD + 1, DELTA);
console.log('错误密码：LSB =', wrongLsb ? '解出了（异常）' : 'null（符合预期）',
  ' 鲁棒 =', wrongRobust ? '解出了（异常）' : 'null（符合预期）');

/* ---------------- 5. 导出 ---------------- */

const ref = {
  meta: {
    W: W,
    H: H,
    lcgSeed: LCG_SEED,
    password: PASSWORD,
    delta: DELTA,
    robustCapBits: robustCapBits,
    lsbCapBits: lsbCapBits,
  },
  orders: orders,
  lsb: {
    payloadHex: hex(lsbPayload),
    contentType: S.TYPE_FILE,
    outHex: hex(lsbOut),
    changedBits: changedBits,
  },
  robust: {
    payloadHex: hex(robustPayload),
    text: robustText,
    contentType: S.TYPE_TEXT,
    outHex: hex(robustOut),
  },
};

fs.writeFileSync(OUT, JSON.stringify(ref), 'utf8');
console.log('\n已写出', OUT, (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
