package com.dragonxash.bwm.core

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

private interface FftImpl {
    fun forward(re: DoubleArray, im: DoubleArray)
    fun inverse(re: DoubleArray, im: DoubleArray)
}

private fun isPow2(v: Int): Boolean = v > 0 && (v and (v - 1)) == 0

private fun nextPow2(v: Int): Int {
    var m = 1
    while (m < v) m = m shl 1
    return m
}

/**
 * 一维复数 FFT，长度任意。
 * n 为 2 的幂时用 radix-2 DIT，否则用 Bluestein（chirp-z）把它转成卷积。
 * 实部虚部分开存放，原地变换。
 */
class Fft1D(val n: Int) {

    private val impl: FftImpl = if (isPow2(n)) Radix2(n) else Bluestein(n)

    fun forward(re: DoubleArray, im: DoubleArray) = impl.forward(re, im)

    fun inverse(re: DoubleArray, im: DoubleArray) = impl.inverse(re, im)
}

/** radix-2 迭代 FFT，旋转因子表预先算好 */
private class Radix2(val n: Int) : FftImpl {

    private val levels = Integer.numberOfTrailingZeros(n)
    private val rev = IntArray(n)
    private val cosT = Array(levels + 1) { DoubleArray(0) }
    private val sinT = Array(levels + 1) { DoubleArray(0) }
    private val invN = 1.0 / n

    init {
        for (i in 0 until n) {
            var r = 0
            for (b in 0 until levels) {
                if (i and (1 shl b) != 0) r = r or (1 shl (levels - 1 - b))
            }
            rev[i] = r
        }
        for (s in 1..levels) {
            val half = 1 shl (s - 1)
            val c = DoubleArray(half)
            val si = DoubleArray(half)
            for (k in 0 until half) {
                val ang = -2.0 * PI * k / (1 shl s)
                c[k] = cos(ang)
                si[k] = sin(ang)
            }
            cosT[s] = c
            sinT[s] = si
        }
    }

    override fun forward(re: DoubleArray, im: DoubleArray) = transform(re, im, false)

    override fun inverse(re: DoubleArray, im: DoubleArray) = transform(re, im, true)

    private fun transform(re: DoubleArray, im: DoubleArray, invert: Boolean) {
        for (i in 0 until n) {
            val j = rev[i]
            if (j > i) {
                var t = re[i]; re[i] = re[j]; re[j] = t
                t = im[i]; im[i] = im[j]; im[j] = t
            }
        }
        for (s in 1..levels) {
            val m = 1 shl s
            val half = m shr 1
            val c = cosT[s]
            val si = sinT[s]
            var k = 0
            while (k < n) {
                for (jj in 0 until half) {
                    val wr = c[jj]
                    val wi = if (invert) -si[jj] else si[jj]
                    val a = k + jj
                    val b = a + half
                    val tr = re[b] * wr - im[b] * wi
                    val ti = re[b] * wi + im[b] * wr
                    re[b] = re[a] - tr
                    im[b] = im[a] - ti
                    re[a] += tr
                    im[a] += ti
                }
                k += m
            }
        }
        if (invert) {
            for (i in 0 until n) {
                re[i] *= invN
                im[i] *= invN
            }
        }
    }
}

/**
 * Bluestein（chirp-z）变换：把任意长度的 DFT 拆成 2 的幂次长度的循环卷积。
 *   X[k] = e^{-i·pi·k^2/N} · Σ_n (x[n]·e^{-i·pi·n^2/N}) · e^{+i·pi·(k-n)^2/N}
 * 相位参数用 (n^2 mod 2N) 计算，避免大角度归约带来的精度损失。
 */
private class Bluestein(val n: Int) : FftImpl {

    private val m = nextPow2(2 * n - 1)
    private val inner = Radix2(m)
    private val chirpRe = DoubleArray(n)
    private val chirpIm = DoubleArray(n)
    private val kernelRe = DoubleArray(m)
    private val kernelIm = DoubleArray(m)
    private val workRe = DoubleArray(m)
    private val workIm = DoubleArray(m)

    init {
        for (k in 0 until n) {
            val k2 = (k.toLong() * k) % (2L * n)
            val ang = -PI * k2 / n
            chirpRe[k] = cos(ang)
            chirpIm[k] = sin(ang)
        }
        kernelRe[0] = chirpRe[0]
        kernelIm[0] = -chirpIm[0]
        for (k in 1 until n) {
            kernelRe[k] = chirpRe[k]
            kernelIm[k] = -chirpIm[k]
            kernelRe[m - k] = chirpRe[k]
            kernelIm[m - k] = -chirpIm[k]
        }
        inner.forward(kernelRe, kernelIm)   // 卷积核只需算一次
    }

    override fun forward(re: DoubleArray, im: DoubleArray) = run(re, im, false)

    override fun inverse(re: DoubleArray, im: DoubleArray) = run(re, im, true)

    private fun run(re: DoubleArray, im: DoubleArray, invert: Boolean) {
        if (invert) for (i in 0 until n) im[i] = -im[i]

        for (k in 0 until n) {
            val xr = re[k]; val xi = im[k]
            val cr = chirpRe[k]; val ci = chirpIm[k]
            workRe[k] = xr * cr - xi * ci
            workIm[k] = xr * ci + xi * cr
        }
        for (k in n until m) { workRe[k] = 0.0; workIm[k] = 0.0 }

        inner.forward(workRe, workIm)
        for (k in 0 until m) {
            val xr = workRe[k]; val xi = workIm[k]
            workRe[k] = xr * kernelRe[k] - xi * kernelIm[k]
            workIm[k] = xr * kernelIm[k] + xi * kernelRe[k]
        }
        inner.inverse(workRe, workIm)

        val invN = 1.0 / n
        for (k in 0 until n) {
            val xr = workRe[k]; val xi = workIm[k]
            val cr = chirpRe[k]; val ci = chirpIm[k]
            val or = xr * cr - xi * ci
            val oi = xr * ci + xi * cr
            if (invert) {
                re[k] = or * invN
                im[k] = -oi * invN
            } else {
                re[k] = or
                im[k] = oi
            }
        }
    }
}

/**
 * 二维 FFT。数据为一维 DoubleArray（行优先，长度 height*width）。
 * 先逐行做长度为 width 的一维变换，再逐列做长度为 height 的一维变换。
 */
class Fft2D(val height: Int, val width: Int) {

    private val fw = Fft1D(width)
    private val fh = Fft1D(height)
    private val rowRe = DoubleArray(width)
    private val rowIm = DoubleArray(width)
    private val colRe = DoubleArray(height)
    private val colIm = DoubleArray(height)

    fun transform(re: DoubleArray, im: DoubleArray, invert: Boolean) {
        for (h in 0 until height) {
            val off = h * width
            System.arraycopy(re, off, rowRe, 0, width)
            System.arraycopy(im, off, rowIm, 0, width)
            if (invert) fw.inverse(rowRe, rowIm) else fw.forward(rowRe, rowIm)
            System.arraycopy(rowRe, 0, re, off, width)
            System.arraycopy(rowIm, 0, im, off, width)
        }
        for (w in 0 until width) {
            for (i in 0 until height) {
                colRe[i] = re[i * width + w]
                colIm[i] = im[i * width + w]
            }
            if (invert) fh.inverse(colRe, colIm) else fh.forward(colRe, colIm)
            for (i in 0 until height) {
                re[i * width + w] = colRe[i]
                im[i * width + w] = colIm[i]
            }
        }
    }
}
