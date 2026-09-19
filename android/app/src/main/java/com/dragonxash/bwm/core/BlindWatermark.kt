package com.dragonxash.bwm.core

import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * 平面图像数据：planes[0]=B, planes[1]=G, planes[2]=R，每个平面长度 w*h（行优先）。
 * 通道顺序与 OpenCV 一致，便于与 Python 版互通。
 */
class Img(val w: Int, val h: Int, val planes: Array<DoubleArray>) {
    val pixelCount: Int get() = w * h

    companion object {
        fun blank(w: Int, h: Int): Img = Img(w, h, Array(3) { DoubleArray(w * h) })
    }
}

/**
 * 变换模式。
 *
 * NUMPY   —— 复刻原作 `np.fft.fft2(img)` 对 (H,W,3) 数组的默认行为。
 *            该调用的默认 axes=(-2,-1)，对三通道数组而言实际变换的是
 *            **宽度轴和通道轴**，等价于逐行做 (W,3) 的二维变换，
 *            而不是"每个颜色通道各做一次空间二维 FFT"。
 *            只有复刻它，本 App 才能与 Python 版互相解出水印。
 * CHANNEL —— 每个颜色通道独立做 (H,W) 空间二维变换（教科书做法）。
 *            画质好得多，但只有本 App 能解。
 */
enum class TransformMode { NUMPY, CHANNEL }

/** 解码结果的量化方式 */
enum class Quantize {
    /** 四舍五入后 clamp 到 [0,255]，视觉最干净 */
    ROUND,

    /** 向零截断，对齐 numpy 的 np.uint8() */
    TRUNC
}

data class BwmOptions(
    val seed: Long = 20160930L,
    val alpha: Double = 3.0,
    val mode: TransformMode = TransformMode.NUMPY,
    val oldSeed: Boolean = false,
)

/** 打散并镜像后的水印图案 */
class Pattern(
    val hwm: Array<DoubleArray>,
    val rwm: Array<DoubleArray>,
    val m: IntArray,
    val n: IntArray,
    val hh: Int,
)

class EncodeResult(val image: Img, val pattern: Pattern)

class DecodeResult(val wm: Img, val raw: Array<DoubleArray>)

class DetectResult(val eRe: Double, val eIm: Double) {
    /** 存在性判据：含水印时频谱差是纯实数，比值会远大于 1；无关图接近 1 */
    val ratio: Double get() = if (eIm > 0.0) sqrt(eRe / eIm) else Double.POSITIVE_INFINITY
}

object BlindWatermark {

    // ------------------------------------------------------------------ 量化

    /** 对齐 OpenCV saturate_cast<uchar>：clamp 到 [0,255] 并做银行家舍入 */
    fun clampRound(x: Double): Double {
        if (x <= 0.0) return 0.0
        if (x >= 255.0) return 255.0
        return Math.rint(x)
    }

    /** 对齐 numpy 的 np.uint8(x)：向零截断 */
    fun pyUint8(x: Double): Double {
        if (x.isNaN() || x.isInfinite()) return 0.0
        if (x <= 0.0) return 0.0
        if (x >= 255.0) return 255.0
        return floor(x)
    }

    // ------------------------------------------------------- 复数图像与变换

    private class ComplexImage(val h: Int, val w: Int) {
        val re = Array(3) { DoubleArray(h * w) }
        val im = Array(3) { DoubleArray(h * w) }
    }

    private fun transformImage(
        cx: ComplexImage,
        invert: Boolean,
        mode: TransformMode,
        onProgress: ((Double) -> Unit)?,
    ) {
        when (mode) {
            TransformMode.CHANNEL -> {
                val fft = Fft2D(cx.h, cx.w)
                for (c in 0 until 3) {
                    fft.transform(cx.re[c], cx.im[c], invert)
                    onProgress?.invoke((c + 1) / 3.0)
                }
            }

            TransformMode.NUMPY -> {
                // 逐行处理 (width, 3) 平面 —— 复刻 numpy 的变换轴选择
                val fft = Fft2D(cx.w, 3)
                val bufRe = DoubleArray(cx.w * 3)
                val bufIm = DoubleArray(cx.w * 3)
                for (row in 0 until cx.h) {
                    for (j in 0 until cx.w) {
                        val base = row * cx.w + j
                        for (c in 0 until 3) {
                            bufRe[j * 3 + c] = cx.re[c][base]
                            bufIm[j * 3 + c] = cx.im[c][base]
                        }
                    }
                    fft.transform(bufRe, bufIm, invert)
                    for (j in 0 until cx.w) {
                        val base = row * cx.w + j
                        for (c in 0 until 3) {
                            cx.re[c][base] = bufRe[j * 3 + c]
                            cx.im[c][base] = bufIm[j * 3 + c]
                        }
                    }
                    if ((row + 1) % 64 == 0) {
                        onProgress?.invoke((row + 1).toDouble() / cx.h)
                    }
                }
                onProgress?.invoke(1.0)
            }
        }
    }

    // ------------------------------------------------------------ 图案构造

    private fun buildPermutation(h: Int, w: Int, o: BwmOptions): Pair<IntArray, IntArray> {
        val hh = h / 2
        val rng = CPrng(o.seed)
        val m = IntArray(hh) { it }
        val n = IntArray(w) { it }
        if (o.oldSeed) {
            rng.oldShuffle(m); rng.oldShuffle(n)
        } else {
            rng.shuffle(m); rng.shuffle(n)
        }
        return m to n
    }

    /** 把水印打散成噪声状图案，再以 180° 翻转镜像铺满整张画布 */
    fun buildPattern(h: Int, w: Int, wm: Img, o: BwmOptions): Pattern {
        val hh = h / 2

        // hwm2：水印贴在 (hh, w) 画布左上角
        val hwm2 = Array(3) { DoubleArray(hh * w) }
        for (i in 0 until wm.h) {
            for (j in 0 until wm.w) {
                for (c in 0 until 3) hwm2[c][i * w + j] = wm.planes[c][i * wm.w + j]
            }
        }

        val (m, n) = buildPermutation(h, w, o)

        // hwm[i][j] = hwm2[m[i]][n[j]]
        val hwm = Array(3) { DoubleArray(hh * w) }
        for (i in 0 until hh) {
            val mi = m[i] * w
            val ii = i * w
            for (j in 0 until w) {
                val src = mi + n[j]
                for (c in 0 until 3) hwm[c][ii + j] = hwm2[c][src]
            }
        }

        // rwm：上半部填 hwm，同时镜像到 (h-1-i, w-1-j)
        // 注意这里用的是"翻转"而不是 DFT 意义上的循环移位 (h-i) mod h，
        // 两者相差 1 个像素，正是解码图出现对角双影的根源（原作行为，已保留）
        val rwm = Array(3) { DoubleArray(h * w) }
        for (i in 0 until hh) {
            val ii = i * w
            val ri = (h - 1 - i) * w
            for (j in 0 until w) {
                val rj = w - 1 - j
                for (c in 0 until 3) {
                    val v = hwm[c][ii + j]
                    rwm[c][ii + j] = v
                    rwm[c][ri + rj] = v
                }
            }
        }
        return Pattern(hwm, rwm, m, n, hh)
    }

    // ---------------------------------------------------------------- 合成

    fun encode(
        img: Img,
        wm: Img,
        o: BwmOptions,
        onProgress: ((Double) -> Unit)? = null,
    ): EncodeResult {
        val h = img.h
        val w = img.w
        val hh = h / 2
        require(wm.h < hh && wm.w < w) {
            "水印尺寸过大：高需小于 $hh、宽需小于 $w（当前水印 ${wm.w}×${wm.h}）"
        }

        val pat = buildPattern(h, w, wm, o)
        val cx = ComplexImage(h, w)
        for (c in 0 until 3) System.arraycopy(img.planes[c], 0, cx.re[c], 0, h * w)

        transformImage(cx, invert = false, mode = o.mode) { onProgress?.invoke(it * 0.5) }

        // f2 = f1 + alpha * rwm（rwm 是实数组，只叠加到频域实部）
        val n = h * w
        for (c in 0 until 3) {
            val rw = pat.rwm[c]
            val re = cx.re[c]
            for (k in 0 until n) re[k] += o.alpha * rw[k]
        }

        transformImage(cx, invert = true, mode = o.mode) { onProgress?.invoke(0.5 + it * 0.5) }

        // 逆变换后只取实部，虚部按算法丢弃
        return EncodeResult(Img(w, h, cx.re), pat)
    }

    // ---------------------------------------------------------------- 分离

    fun decode(
        img: Img,
        imgWm: Img,
        o: BwmOptions,
        quantize: Quantize = Quantize.ROUND,
        onProgress: ((Double) -> Unit)? = null,
    ): DecodeResult {
        val h = img.h
        val w = img.w
        require(imgWm.h == h && imgWm.w == w) {
            "两张图尺寸必须一致（${w}×${h} 与 ${imgWm.w}×${imgWm.h}）"
        }
        val hh = h / 2
        val (m, n) = buildPermutation(h, w, o)

        val c1 = ComplexImage(h, w)
        val c2 = ComplexImage(h, w)
        for (c in 0 until 3) {
            System.arraycopy(img.planes[c], 0, c1.re[c], 0, h * w)
            System.arraycopy(imgWm.planes[c], 0, c2.re[c], 0, h * w)
        }

        transformImage(c1, invert = false, mode = o.mode) { onProgress?.invoke(it * 0.45) }
        transformImage(c2, invert = false, mode = o.mode) { onProgress?.invoke(0.45 + it * 0.45) }

        // rwm = real((f2 - f1) / alpha)
        val np = h * w
        val raw = Array(3) { DoubleArray(np) }
        val invAlpha = 1.0 / o.alpha
        for (c in 0 until 3) {
            val f1 = c1.re[c]
            val f2 = c2.re[c]
            val out = raw[c]
            for (k in 0 until np) out[k] = (f2[k] - f1[k]) * invAlpha
        }
        onProgress?.invoke(0.9)

        val wmPlanes = Array(3) { DoubleArray(np) }
        for (i in 0 until hh) {
            val src = i * w
            for (j in 0 until w) {
                val dst = m[i] * w + n[j]
                for (c in 0 until 3) {
                    val v = raw[c][src + j]
                    wmPlanes[c][dst] = if (quantize == Quantize.ROUND) clampRound(v) else pyUint8(v)
                }
            }
        }
        for (i in 0 until hh) {
            val s2 = i * w
            val d2 = (h - 1 - i) * w
            for (j in 0 until w) {
                val dj = w - 1 - j
                for (c in 0 until 3) wmPlanes[c][d2 + dj] = wmPlanes[c][s2 + j]
            }
        }
        onProgress?.invoke(1.0)
        return DecodeResult(Img(w, h, wmPlanes), raw)
    }

    // ---------------------------------------------------------------- 检测

    /**
     * 精确检测（需要原图）。
     *
     * 判据：水印只叠加在频域的实部上，所以 d = fft(imgWm) - fft(img) 在理想情况下
     * 是纯实数；若图中没有水印，d 只剩量化/压缩噪声，实部虚部能量相当。
     * 于是 sqrt(E_re / E_im) 是干净的存在性指标：无关图约 1.0，含水印图远大于 1。
     */
    fun detectPair(
        img: Img,
        imgWm: Img,
        o: BwmOptions,
        onProgress: ((Double) -> Unit)? = null,
    ): DetectResult {
        val h = img.h
        val w = img.w
        require(imgWm.h == h && imgWm.w == w) {
            "原图与待检图尺寸不一致（${w}×${h} 与 ${imgWm.w}×${imgWm.h}）"
        }

        val c1 = ComplexImage(h, w)
        val c2 = ComplexImage(h, w)
        for (c in 0 until 3) {
            System.arraycopy(img.planes[c], 0, c1.re[c], 0, h * w)
            System.arraycopy(imgWm.planes[c], 0, c2.re[c], 0, h * w)
        }

        transformImage(c1, invert = false, mode = o.mode) { onProgress?.invoke(it * 0.45) }
        transformImage(c2, invert = false, mode = o.mode) { onProgress?.invoke(0.45 + it * 0.45) }

        var eRe = 0.0
        var eIm = 0.0
        val np = h * w
        for (c in 0 until 3) {
            val a = c1.re[c]; val b = c1.im[c]
            val d = c2.re[c]; val e = c2.im[c]
            for (k in 0 until np) {
                val dr = d[k] - a[k]
                val di = e[k] - b[k]
                eRe += dr * dr
                eIm += di * di
            }
        }
        onProgress?.invoke(1.0)
        return DetectResult(eRe, eIm)
    }

    /** 归一化互相关，用于把还原出的水印与候选水印比对 */
    fun ncc(a: DoubleArray, b: DoubleArray): Double {
        val n = minOf(a.size, b.size)
        if (n == 0) return 0.0
        var ma = 0.0
        var mb = 0.0
        for (i in 0 until n) { ma += a[i]; mb += b[i] }
        ma /= n
        mb /= n
        var num = 0.0
        var da = 0.0
        var db = 0.0
        for (i in 0 until n) {
            val x = a[i] - ma
            val y = b[i] - mb
            num += x * y
            da += x * x
            db += y * y
        }
        if (da == 0.0 || db == 0.0) return 0.0
        return num / sqrt(da * db)
    }

    // ------------------------------------------------------- 无原图盲检

    class RadialProfile(val profile: DoubleArray, val excess: Double) {
        val bins: Int get() = profile.size
    }

    /**
     * 径向平均功率谱（供无原图时的启发式盲检使用）。
     * 对灰度图加 Hann 窗后做空间二维 FFT，按半径环带统计平均功率，
     * 用低频段拟合自然图像的幂律基线，再看高频段超出基线的倍数。
     *
     * 注意：这只是参考性指标，会被图像自身的噪声和纹理干扰，**不能作为判定依据**。
     */
    fun radialSpectrum(img: Img, onProgress: ((Double) -> Unit)? = null): RadialProfile {
        val h = img.h
        val w = img.w
        val np = h * w
        val g = DoubleArray(np)
        for (k in 0 until np) {
            g[k] = (img.planes[0][k] + img.planes[1][k] + img.planes[2][k]) / 3.0
        }
        var mean = 0.0
        for (k in 0 until np) mean += g[k]
        mean /= np
        for (i in 0 until h) {
            val wy = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * i / (h - 1))
            for (j in 0 until w) {
                val wx = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * j / (w - 1))
                g[i * w + j] = (g[i * w + j] - mean) * wx * wy
            }
        }
        onProgress?.invoke(0.2)

        val im = DoubleArray(np)
        Fft2D(h, w).transform(g, im, invert = false)
        onProgress?.invoke(0.8)

        val nb = 48
        val sum = DoubleArray(nb)
        val cnt = DoubleArray(nb)
        val maxR = minOf(h, w) / 2.0
        for (i in 0 until h) {
            val fy = if (i <= h / 2) i else i - h
            for (j in 0 until w) {
                val fx = if (j <= w / 2) j else j - w
                val r = sqrt((fx * fx + fy * fy).toDouble()) / maxR
                if (r >= 1.0) continue
                val bi = minOf(nb - 1, (r * nb).toInt())
                sum[bi] += g[i * w + j] * g[i * w + j] + im[i * w + j] * im[i * w + j]
                cnt[bi] += 1.0
            }
        }
        val prof = DoubleArray(nb)
        for (k in 0 until nb) prof[k] = if (cnt[k] > 0) sum[k] / cnt[k] else 0.0
        onProgress?.invoke(1.0)

        // 用低频段拟合 log-log 直线，再看高频段超出多少
        val logs = DoubleArray(nb) { log10(maxOf(prof[it], 1e-12)) }
        val nf = maxOf(4, nb / 3)
        var sx = 0.0; var sy = 0.0; var sxx = 0.0; var sxy = 0.0
        for (i in 0 until nf) {
            val lx = log10((i + 1).toDouble() / nb)
            sx += lx; sy += logs[i]; sxx += lx * lx; sxy += lx * logs[i]
        }
        val den = nf * sxx - sx * sx
        val slope = if (den != 0.0) (nf * sxy - sx * sy) / den else 0.0
        val inter = (sy - slope * sx) / nf
        val tail = maxOf(1, (nb * 0.15).toInt())
        var sumA = 0.0; var sumB = 0.0
        for (i in nb - tail until nb) {
            sumA += logs[i]
            sumB += inter + slope * log10((i + 1).toDouble() / nb)
        }
        val excess = Math.pow(10.0, (sumA - sumB) / tail)
        return RadialProfile(prof, excess)
    }
}
