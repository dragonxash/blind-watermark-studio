# -*- coding: utf-8 -*-
"""
参考实现：严格复刻 chishaxie/BlindWaterMark 的 bwmforpy3.py 算法，
导出测试向量供 JavaScript 端比对。

输出的 ref.json 包含：
  - rng_*        : CPython random 序列探针（用于验证 MT19937 / shuffle 复刻）
  - input        : 输入图像与输入水印（uint8）
  - m, n         : encode 阶段的随机排列
  - enc_float    : encode 输出（未经 uint8 量化，float）
  - dec_float    : decode 输出（未经 uint8 量化，float）
  - dec_uint8    : decode 输出经 np.uint8（Python 取模语义）
"""
import json
import random
import numpy as np

SEED = 20160930
ALPHA = 3.0

H, W = 32, 32          # 原图尺寸
WH, WW = 10, 8         # 水印尺寸


# --------------------------------------------------------------------------
# 算法本体（逐行对齐 bwmforpy3.py）
# --------------------------------------------------------------------------
def encode(img, wm, seed=SEED, alpha=ALPHA):
    h, w = img.shape[0], img.shape[1]
    hwm = np.zeros((int(h * 0.5), w, img.shape[2]))
    assert hwm.shape[0] > wm.shape[0]
    assert hwm.shape[1] > wm.shape[1]
    hwm2 = np.copy(hwm)
    for i in range(wm.shape[0]):
        for j in range(wm.shape[1]):
            hwm2[i][j] = wm[i][j]

    random.seed(seed)
    m, n = list(range(hwm.shape[0])), list(range(hwm.shape[1]))
    random.shuffle(m)
    random.shuffle(n)

    for i in range(hwm.shape[0]):
        for j in range(hwm.shape[1]):
            hwm[i][j] = hwm2[m[i]][n[j]]

    rwm = np.zeros(img.shape)
    for i in range(hwm.shape[0]):
        for j in range(hwm.shape[1]):
            rwm[i][j] = hwm[i][j]
            rwm[rwm.shape[0] - i - 1][rwm.shape[1] - j - 1] = hwm[i][j]

    f1 = np.fft.fft2(img)
    f2 = f1 + alpha * rwm
    img_wm = np.real(np.fft.ifft2(f2))
    return img_wm, m, n, hwm, rwm


def decode(img, img_wm, seed=SEED, alpha=ALPHA):
    random.seed(seed)
    m = list(range(int(img.shape[0] * 0.5)))
    n = list(range(img.shape[1]))
    random.shuffle(m)
    random.shuffle(n)

    f1 = np.fft.fft2(img)
    f2 = np.fft.fft2(img_wm)
    rwm = (f2 - f1) / alpha
    rwm = np.real(rwm)

    wm = np.zeros(rwm.shape)
    for i in range(int(rwm.shape[0] * 0.5)):
        for j in range(rwm.shape[1]):
            wm[m[i]][n[j]] = np.uint8(rwm[i][j])
    for i in range(int(rwm.shape[0] * 0.5)):
        for j in range(rwm.shape[1]):
            wm[rwm.shape[0] - i - 1][rwm.shape[1] - j - 1] = wm[i][j]
    return wm, rwm, m, n


# --------------------------------------------------------------------------
# 生成确定性输入
# --------------------------------------------------------------------------
rs = np.random.RandomState(20260919)
img = rs.randint(0, 256, size=(H, W, 3)).astype(np.float64)
wm = rs.randint(0, 256, size=(WH, WW, 3)).astype(np.float64)

enc_float, m_enc, n_enc, hwm_ref, rwm_ref = encode(img, wm)
dec_uint8, dec_float, m_dec, n_dec = decode(img, enc_float)

assert m_enc == m_dec and n_enc == n_dec, "encode/decode 排列不一致"

f1_ref = np.fft.fft2(img)


# --------------------------------------------------------------------------
# RNG 探针
# --------------------------------------------------------------------------
rng = {}
random.seed(SEED)
x = list(range(1000))
random.shuffle(x)
rng["shuffle1000_head"] = x[:40]
rng["shuffle1000_ck"] = int(sum(v * (i + 1) for i, v in enumerate(x)))

R = random.Random(SEED)
rng["randbelow100"] = [R._randbelow(100) for _ in range(24)]

R = random.Random(SEED)
rng["getrandbits20"] = [R.getrandbits(20) for _ in range(12)]

R = random.Random(SEED)
rng["random_seq"] = [R.random() for _ in range(6)]

R = random.Random(SEED)
y = list(range(17))
R.shuffle(y)
rng["shuffle17"] = y


# --------------------------------------------------------------------------
# 导出
# --------------------------------------------------------------------------
def flatf(a):
    """float 数组 -> 紧凑列表（10 位有效数字）"""
    return [float("%.10g" % v) for v in np.asarray(a).reshape(-1)]


out = {
    "meta": {"H": H, "W": W, "WH": WH, "WW": WW, "seed": SEED, "alpha": ALPHA},
    "rng": rng,
    "input_img": np.asarray(img, dtype=int).reshape(-1).tolist(),
    "input_wm": np.asarray(wm, dtype=int).reshape(-1).tolist(),
    "m": m_enc,
    "n": n_enc,
    "hwm": flatf(hwm_ref),
    "rwm": flatf(rwm_ref),
    "f1_re": flatf(np.real(f1_ref)),
    "f1_im": flatf(np.imag(f1_ref)),
    "enc_float": flatf(enc_float),
    "dec_float": flatf(dec_float),
    "dec_uint8": np.asarray(dec_uint8, dtype=int).reshape(-1).tolist(),
}

with open(r"ref.json", "w", encoding="utf-8") as f:
    json.dump(out, f, separators=(",", ":"))

# 打印摘要
print("encode 输出范围: %.4f .. %.4f" % (enc_float.min(), enc_float.max()))
print("decode 输出(float)范围: %.4f .. %.4f" % (dec_float.min(), dec_float.max()))
print("原图 min/max:", img.min(), img.max())
print("enc 与原图最大偏差: %.4f" % np.abs(enc_float - img).max())
print("decode 恢复水印左上 10x8 与原水印最大偏差: %.2f"
      % np.abs(dec_float[:WH, :WW, :] - wm).max())
print("水印结构是否可见(解码左上区 std): %.2f" % dec_float[:WH, :WW, :].std())
print("噪声区 std: %.2f" % dec_float[WH + 4:H - WH - 4, WW + 4:W - WW - 4, :].std())
print("m[:8] =", m_enc[:8])
print("n[:8] =", n_enc[:8])
print("ref.json 已写出")
