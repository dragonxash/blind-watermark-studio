package com.dragonxash.bwm.core

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sqrt

/**
 * 隐写引擎 —— 与 `web/src/stego.js` 逐字节兼容的 Kotlin 移植版。
 *
 * 提供两条与 FFT 加法式互补的嵌入路线（两者都**不需要原图**就能提取）：
 *
 *  1) DWT-DCT-SVD（鲁棒模式，[METHOD_ROBUST]）
 *     每个通道做一级 Haar 小波取 LL 子带 -> 分 4x4 块 -> 每块做 DCT ->
 *     对 DCT 系数矩阵做 SVD -> 用 QIM 把 1 bit 写进最大奇异值 s[0]。
 *
 *     QIM（量化索引调制）是关键：
 *       q  = floor(s0 / delta)
 *       q' = 2*floor(q/2) + bit          // 只改 s0 所在格点序号的奇偶
 *       s0' = (q' + 0.5) * delta         // 落在格点中心，离边界有 delta/2 余量
 *     提取时 floor(s0'/delta) 恰为 q'，其奇偶即 bit —— 不需要原始 s0。
 *     又因为奇异值对图像扰动不敏感，它能扛住 JPEG 压缩与轻微缩放。
 *
 *     容量约 (H/8)*(W/8)*3 bit，1024x1024 约 6 KB。
 *
 *  2) LSB（大容量模式，[METHOD_LSB]）
 *     把数据按位写进像素最低有效位。容量 = W*H*3 bit（1024x1024 约 393 KB），
 *     同样免原图，但任何有损压缩都会摧毁它 —— 输出必须保持 PNG。
 *
 *  两者共用一个 10 字节容器头部，提取时可自动识别用的哪种引擎。
 */
class StegoResult(val method: Int, val contentType: Int, val data: ByteArray)

/** 容器头部解析结果 */
class StegoHeader(
    val version: Int,
    val method: Int,
    val contentType: Int,
    val length: Int,
)

object Stego {

    const val METHOD_ROBUST = 1
    const val METHOD_LSB = 2

    const val TYPE_TEXT = 0
    const val TYPE_FILE = 1
    const val TYPE_IMAGE = 2

    const val HEADER_BYTES = 10
    const val DEFAULT_DELTA = 36.0

    private const val MAGIC0 = 0xB7
    private const val MAGIC1 = 0x4D

    /* =====================================================================
     * 1. 基础数学：4x4 DCT、4x4 SVD、一级 Haar 小波
     * =================================================================== */

    // 正交 DCT-II 变换矩阵（N=4）：C[k][n] = sqrt(2/N) * a(k) * cos(pi*(2n+1)k/(2N))
    private val DCT4: DoubleArray = DoubleArray(16).also { c ->
        for (k in 0 until 4) {
            val a = if (k == 0) sqrt(0.5) else 1.0
            for (n in 0 until 4) {
                c[k * 4 + n] = sqrt(2.0 / 4) * a * cos(PI * (2 * n + 1) * k / 8.0)
            }
        }
    }

    /** 2D DCT：dst = C * src * C^T（均按行优先 4x4） */
    fun dct4(src: DoubleArray, dst: DoubleArray, tmp: DoubleArray) {
        for (i in 0 until 4) {
            for (j in 0 until 4) {
                var s = 0.0
                for (k in 0 until 4) s += DCT4[i * 4 + k] * src[k * 4 + j]
                tmp[i * 4 + j] = s
            }
        }
        for (i in 0 until 4) {
            for (j in 0 until 4) {
                var s = 0.0
                for (k in 0 until 4) s += tmp[i * 4 + k] * DCT4[j * 4 + k]
                dst[i * 4 + j] = s
            }
        }
    }

    /** 逆 2D DCT：dst = C^T * src * C */
    fun idct4(src: DoubleArray, dst: DoubleArray, tmp: DoubleArray) {
        for (i in 0 until 4) {
            for (j in 0 until 4) {
                var s = 0.0
                for (k in 0 until 4) s += DCT4[k * 4 + i] * src[k * 4 + j]
                tmp[i * 4 + j] = s
            }
        }
        for (i in 0 until 4) {
            for (j in 0 until 4) {
                var s = 0.0
                for (k in 0 until 4) s += tmp[i * 4 + k] * DCT4[k * 4 + j]
                dst[i * 4 + j] = s
            }
        }
    }

    /**
     * 4x4 实矩阵的单边 Jacobi SVD：a = U * diag(S) * V^T
     * 只有 4x4，扫几轮就收敛，开销可忽略。
     */
    fun svd4(a: DoubleArray, u: DoubleArray, s: DoubleArray, v: DoubleArray) {
        for (i in 0 until 16) {
            u[i] = a[i]
            v[i] = 0.0
        }
        v[0] = 1.0; v[5] = 1.0; v[10] = 1.0; v[15] = 1.0

        for (sweep in 0 until 30) {
            var off = 0.0
            for (p in 0 until 3) {
                for (q in p + 1 until 4) {
                    var alpha = 0.0
                    var beta = 0.0
                    var gamma = 0.0
                    for (i in 0 until 4) {
                        val uip = u[i * 4 + p]
                        val uiq = u[i * 4 + q]
                        alpha += uip * uip
                        beta += uiq * uiq
                        gamma += uip * uiq
                    }
                    off += gamma * gamma
                    if (gamma == 0.0 || abs(gamma) < 1e-14 * sqrt(alpha * beta)) continue

                    val zeta = (beta - alpha) / (2.0 * gamma)
                    val t = (if (zeta >= 0) 1.0 else -1.0) / (abs(zeta) + sqrt(1.0 + zeta * zeta))
                    val c = 1.0 / sqrt(1.0 + t * t)
                    val sn = c * t

                    for (i in 0 until 4) {
                        val a1 = u[i * 4 + p]
                        val a2 = u[i * 4 + q]
                        u[i * 4 + p] = c * a1 - sn * a2
                        u[i * 4 + q] = sn * a1 + c * a2
                        val b1 = v[i * 4 + p]
                        val b2 = v[i * 4 + q]
                        v[i * 4 + p] = c * b1 - sn * b2
                        v[i * 4 + q] = sn * b1 + c * b2
                    }
                }
            }
            if (off < 1e-24) break
        }

        for (j in 0 until 4) {
            var norm = 0.0
            for (i in 0 until 4) norm += u[i * 4 + j] * u[i * 4 + j]
            norm = sqrt(norm)
            s[j] = norm
            if (norm > 1e-300) {
                for (i in 0 until 4) u[i * 4 + j] /= norm
            }
        }

        // Jacobi 不保证列的顺序，但 QIM 依赖 s[0] 是最大奇异值，
        // 所以这里按降序重排，并同步交换 U、V 的对应列（不改变 A = U S V^T）。
        for (i in 0 until 3) {
            var mi = i
            for (j in i + 1 until 4) if (s[j] > s[mi]) mi = j
            if (mi != i) {
                val ts = s[i]; s[i] = s[mi]; s[mi] = ts
                for (r in 0 until 4) {
                    val tu = u[r * 4 + i]; u[r * 4 + i] = u[r * 4 + mi]; u[r * 4 + mi] = tu
                    val tv = v[r * 4 + i]; v[r * 4 + i] = v[r * 4 + mi]; v[r * 4 + mi] = tv
                }
            }
        }
    }

    /** 由 U, S, V 重构：out = U * diag(S) * V^T */
    fun svd4Reconstruct(u: DoubleArray, s: DoubleArray, v: DoubleArray, out: DoubleArray) {
        for (i in 0 until 4) {
            for (j in 0 until 4) {
                var sum = 0.0
                for (k in 0 until 4) sum += u[i * 4 + k] * s[k] * v[j * 4 + k]
                out[i * 4 + j] = sum
            }
        }
    }

    /** 一级 Haar 二维小波的四个子带，边长为 (W/2) x (H/2) */
    private class Subbands(size: Int) {
        val ll = DoubleArray(size)
        val lh = DoubleArray(size)
        val hl = DoubleArray(size)
        val hh = DoubleArray(size)
    }

    /**
     * 一级 Haar 二维小波分解，输入 W*H，输出四个 (W/2)*(H/2) 子带。
     *
     * [lh]/[hl]/[hh] 传 null 时只计算 LL —— 提取路径用不到其余三个子带，
     * 对 400 万像素的图能省下约 3/4 的小波内存。
     */
    fun dwt2(
        plane: DoubleArray, w: Int, h: Int,
        ll: DoubleArray, lh: DoubleArray?, hl: DoubleArray?, hh: DoubleArray?,
    ) {
        val hw = w shr 1
        val halfH = h shr 1
        for (y in 0 until halfH) {
            val r0 = (y shl 1) * w
            val r1 = r0 + w
            val o = y * hw
            for (x in 0 until hw) {
                val c0 = x shl 1
                val a = plane[r0 + c0]
                val b = plane[r0 + c0 + 1]
                val c = plane[r1 + c0]
                val d = plane[r1 + c0 + 1]
                ll[o + x] = (a + b + c + d) * 0.5
                if (lh != null) lh[o + x] = (a - b + c - d) * 0.5
                if (hl != null) hl[o + x] = (a + b - c - d) * 0.5
                if (hh != null) hh[o + x] = (a - b - c + d) * 0.5
            }
        }
    }

    /** 一级 Haar 二维小波重构（[dwt2] 的逆） */
    fun idwt2(
        out: DoubleArray, w: Int, h: Int,
        ll: DoubleArray, lh: DoubleArray, hl: DoubleArray, hh: DoubleArray,
    ) {
        val hw = w shr 1
        val halfH = h shr 1
        for (y in 0 until halfH) {
            val r0 = (y shl 1) * w
            val r1 = r0 + w
            val o = y * hw
            for (x in 0 until hw) {
                val c0 = x shl 1
                val l = ll[o + x]
                val p = lh[o + x]
                val q = hl[o + x]
                val s = hh[o + x]
                out[r0 + c0] = (l + p + q + s) * 0.5
                out[r0 + c0 + 1] = (l - p + q - s) * 0.5
                out[r1 + c0] = (l + p - q - s) * 0.5
                out[r1 + c0 + 1] = (l - p - q + s) * 0.5
            }
        }
    }

    /* =====================================================================
     * 2. 容器格式
     * =================================================================== */

    fun packContainer(method: Int, contentType: Int, payload: ByteArray): ByteArray {
        val out = ByteArray(HEADER_BYTES + payload.size)
        out[0] = MAGIC0.toByte()
        out[1] = MAGIC1.toByte()
        out[2] = 1
        out[3] = method.toByte()
        out[4] = contentType.toByte()
        out[5] = 0
        val len = payload.size
        out[6] = ((len ushr 24) and 0xFF).toByte()
        out[7] = ((len ushr 16) and 0xFF).toByte()
        out[8] = ((len ushr 8) and 0xFF).toByte()
        out[9] = (len and 0xFF).toByte()
        System.arraycopy(payload, 0, out, HEADER_BYTES, len)
        return out
    }

    fun readHeader(bytes: ByteArray?): StegoHeader? {
        if (bytes == null || bytes.size < HEADER_BYTES) return null
        if ((bytes[0].toInt() and 0xFF) != MAGIC0) return null
        if ((bytes[1].toInt() and 0xFF) != MAGIC1) return null
        val len = ((bytes[6].toInt() and 0xFF) shl 24) or
            ((bytes[7].toInt() and 0xFF) shl 16) or
            ((bytes[8].toInt() and 0xFF) shl 8) or
            (bytes[9].toInt() and 0xFF)
        return StegoHeader(
            version = bytes[2].toInt() and 0xFF,
            method = bytes[3].toInt() and 0xFF,
            contentType = bytes[4].toInt() and 0xFF,
            length = len,
        )
    }

    /* =====================================================================
     * 3. 工具
     * =================================================================== */

    private fun bytesToBits(bytes: ByteArray): ByteArray {
        val bits = ByteArray(bytes.size * 8)
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xFF
            for (b in 0 until 8) bits[i * 8 + b] = ((v shr (7 - b)) and 1).toByte()
        }
        return bits
    }

    private fun bitsToBytes(bits: ByteArray, byteCount: Int): ByteArray {
        val out = ByteArray(byteCount)
        for (i in 0 until byteCount) {
            var v = 0
            for (b in 0 until 8) v = (v shl 1) or (bits[i * 8 + b].toInt() and 1)
            out[i] = v.toByte()
        }
        return out
    }

    /**
     * 用密码驱动的置换打散写入位置，避免局部损坏波及连续的一段数据。
     *
     * 注意：必须与网页版的 `makeOrder` 完全一致 —— 两端的密码都经由
     * CPython 兼容的 MT19937 展开成同一个置换，否则一端嵌、另一端解不出来。
     */
    fun makeOrder(n: Int, password: Long): IntArray {
        val order = IntArray(n) { it }
        if (password != 0L) {
            val rng = CPrng(password)
            for (i in n - 1 downTo 1) {
                val j = rng.randbelow(i + 1)
                val t = order[i]; order[i] = order[j]; order[j] = t
            }
        }
        return order
    }

    /* =====================================================================
     * 4. 鲁棒引擎：DWT-DCT-SVD + QIM
     * =================================================================== */

    private class Scratch {
        val block = DoubleArray(16)
        val dct = DoubleArray(16)
        val tmp = DoubleArray(16)
        val rec = DoubleArray(16)
        val u = DoubleArray(16)
        val s = DoubleArray(4)
        val v = DoubleArray(16)
    }

    fun robustBlockCols(w: Int) = (w shr 1) shr 2
    fun robustBlockRows(h: Int) = (h shr 1) shr 2

    fun robustCapacityBits(w: Int, h: Int) = robustBlockCols(w) * robustBlockRows(h) * 3

    fun robustCapacityBytes(w: Int, h: Int): Long =
        (robustCapacityBits(w, h).toLong() / 8 - HEADER_BYTES).coerceAtLeast(0)

    /**
     * 读/写一个 4x4 块的最大奇异值。
     *
     * @param ll       LL 子带缓冲
     * @param stride   LL 的**实际行宽**（= W/2），不是块的列数，两者别混用
     * @param bw       每行有多少个 4x4 块
     * @param blockIdx 块序号
     * @param writeBit >=0 表示写入该 bit；传 -1 表示读取
     * @return 读取模式下返回该 bit
     */
    private fun processBlock(
        ll: DoubleArray, stride: Int, bw: Int, blockIdx: Int,
        sc: Scratch, writeBit: Int, delta: Double,
    ): Int {
        val by = blockIdx / bw
        val bx = blockIdx % bw
        val y0 = by shl 2
        val x0 = bx shl 2

        for (i in 0 until 16) {
            sc.block[i] = ll[(y0 + (i shr 2)) * stride + (x0 + (i and 3))]
        }
        dct4(sc.block, sc.dct, sc.tmp)
        svd4(sc.dct, sc.u, sc.s, sc.v)

        val q = floor(sc.s[0] / delta).toInt()
        if (writeBit >= 0) {
            val q2 = 2 * floor(q / 2.0).toInt() + (writeBit and 1)
            sc.s[0] = (q2 + 0.5) * delta
            svd4Reconstruct(sc.u, sc.s, sc.v, sc.rec)
            idct4(sc.rec, sc.dct, sc.tmp)
            for (i in 0 until 16) {
                ll[(y0 + (i shr 2)) * stride + (x0 + (i and 3))] = sc.dct[i]
            }
            return 0
        }
        // 读取：s0' 落在格点中心 (q' + 0.5)，因此 floor(s0'/delta) 恰为 q'。
        // 必须用 floor —— 用 round 会撞上「.5 向上取整」而错位一格。
        // 容错半径是 ±delta/2。
        val qr = floor(sc.s[0] / delta).toInt()
        return ((qr % 2) + 2) % 2
    }

    /**
     * 鲁棒嵌入。
     * @return 实际写入的 bit 数
     */
    fun embedRobust(
        planes: Array<DoubleArray>,
        w: Int,
        h: Int,
        payload: ByteArray,
        password: Long,
        contentType: Int = TYPE_TEXT,
        delta: Double = DEFAULT_DELTA,
        onProgress: ((Double) -> Unit)? = null,
    ): Int {
        val bw = robustBlockCols(w)
        val bh = robustBlockRows(h)
        val cap = bw * bh * 3
        val bytes = packContainer(METHOD_ROBUST, contentType, payload)
        val bits = bytesToBits(bytes)
        if (bits.size > cap) {
            throw IllegalArgumentException(
                "数据过大：需要 ${bits.size} bit（${bytes.size} 字节），" +
                    "当前图片的鲁棒容量只有 $cap bit（${robustCapacityBytes(w, h)} 字节）"
            )
        }

        val hw = w shr 1
        val hh = h shr 1

        // 按目标通道把写入任务分组，再逐通道处理 —— 内存峰值只需一个通道的小波子带
        // （2000x2000 的图，三通道同时驻留约 96 MB，逐通道降到 32 MB）。
        // 每个 4x4 块的处理彼此独立，所以与「三通道一起做」的结果完全等价。
        val order = makeOrder(cap, password)
        val perChannel = bw * bh
        val counts = IntArray(3)
        for (i in bits.indices) {
            val c = order[i] / perChannel
            if (c <= 2) counts[c]++
        }
        val taskIdx = Array(3) { IntArray(counts[it]) }
        val taskBit = Array(3) { ByteArray(counts[it]) }
        val fill = IntArray(3)
        for (i in bits.indices) {
            val p = order[i]
            val c = p / perChannel
            if (c <= 2) {
                val k = fill[c]++
                taskIdx[c][k] = p % perChannel
                taskBit[c][k] = bits[i]
            }
        }

        val sc = Scratch()
        for (c in 0..2) {
            val sub = Subbands(hw * hh)
            dwt2(planes[c], w, h, sub.ll, sub.lh, sub.hl, sub.hh)
            val idx = taskIdx[c]
            val bt = taskBit[c]
            for (k in idx.indices) {
                processBlock(sub.ll, hw, bw, idx[k], sc, bt[k].toInt(), delta)
            }
            idwt2(planes[c], w, h, sub.ll, sub.lh, sub.hl, sub.hh)
            onProgress?.invoke((c + 1) / 3.0)
        }
        return bits.size
    }

    /**
     * 鲁棒提取。返回 payload；若头部校验不通过则返回 null。
     */
    fun extractRobust(
        planes: Array<DoubleArray>,
        w: Int,
        h: Int,
        password: Long,
        delta: Double = DEFAULT_DELTA,
        onProgress: ((Double) -> Unit)? = null,
    ): StegoResult? {
        val bw = robustBlockCols(w)
        val bh = robustBlockRows(h)
        val cap = bw * bh * 3
        if (cap < HEADER_BYTES * 8) return null

        val hw = w shr 1
        val hh = h shr 1
        // 提取只用到 LL 子带，因此只分配 LL —— 三个通道合计 3 个 (W/2)*(H/2) 缓冲
        val lls = Array(3) { DoubleArray(hw * hh) }
        for (c in 0..2) {
            dwt2(planes[c], w, h, lls[c], null, null, null)
            onProgress?.invoke((c + 1) / 3.0 * 0.55)
        }

        val order = makeOrder(cap, password)
        val sc = Scratch()
        val perChannel = bw * bh
        val bits = ByteArray(cap)
        val budget = (cap / 20).coerceAtLeast(1)

        for (i in 0 until cap) {
            val p = order[i]
            val c = p / perChannel
            bits[i] = if (c > 2) 0
            else processBlock(lls[c], hw, bw, p % perChannel, sc, -1, delta).toByte()
            if (i % budget == 0) onProgress?.invoke(0.55 + 0.4 * i / cap.toDouble())
        }
        onProgress?.invoke(0.96)

        val maxBytes = cap / 8
        val bytes = bitsToBytes(bits, maxBytes)
        val hdr = readHeader(bytes) ?: return null
        if (hdr.method != METHOD_ROBUST) return null
        if (hdr.length > maxBytes - HEADER_BYTES) return null

        val out = ByteArray(hdr.length)
        System.arraycopy(bytes, HEADER_BYTES, out, 0, hdr.length)
        onProgress?.invoke(1.0)
        return StegoResult(METHOD_ROBUST, hdr.contentType, out)
    }

    /* =====================================================================
     * 5. LSB 引擎
     * =================================================================== */

    fun lsbCapacityBits(w: Int, h: Int) = w * h * 3

    fun lsbCapacityBytes(w: Int, h: Int): Long =
        (lsbCapacityBits(w, h).toLong() / 8 - HEADER_BYTES).coerceAtLeast(0)

    fun embedLsb(
        planes: Array<DoubleArray>,
        w: Int,
        h: Int,
        payload: ByteArray,
        password: Long,
        contentType: Int = TYPE_TEXT,
        onProgress: ((Double) -> Unit)? = null,
    ): Int {
        val total = lsbCapacityBits(w, h)
        val bytes = packContainer(METHOD_LSB, contentType, payload)
        val bits = bytesToBits(bytes)
        if (bits.size > total) {
            throw IllegalArgumentException(
                "数据过大：需要 ${bytes.size} 字节，当前图片的大容量通道只能容纳 " +
                    "${lsbCapacityBytes(w, h)} 字节"
            )
        }
        val order = makeOrder(total, password)
        val budget = (bits.size / 20).coerceAtLeast(1)
        for (i in bits.indices) {
            val p = order[i]
            val c = p % 3
            val px = p / 3
            // 与 JS 的 Math.floor(v) & ~1 | bit 等价
            planes[c][px] = ((floor(planes[c][px]).toInt() and -2) or bits[i].toInt()).toDouble()
            if (i % budget == 0) onProgress?.invoke(0.85 * i / bits.size.toDouble())
        }
        onProgress?.invoke(1.0)
        return bits.size
    }

    fun extractLsb(
        planes: Array<DoubleArray>,
        w: Int,
        h: Int,
        password: Long,
        onProgress: ((Double) -> Unit)? = null,
    ): StegoResult? {
        val total = lsbCapacityBits(w, h)
        val hb = HEADER_BYTES * 8
        if (total < hb) return null
        val order = makeOrder(total, password)

        val headBits = ByteArray(hb)
        for (i in 0 until hb) {
            val p = order[i]
            headBits[i] = (floor(planes[p % 3][p / 3]).toInt() and 1).toByte()
        }
        val hdr = readHeader(bitsToBytes(headBits, HEADER_BYTES)) ?: return null
        if (hdr.method != METHOD_LSB) return null

        val need = HEADER_BYTES + hdr.length
        if (need * 8 > total) return null
        onProgress?.invoke(0.2)

        val allBits = ByteArray(need * 8)
        val budget = (allBits.size / 20).coerceAtLeast(1)
        for (i in allBits.indices) {
            val p = order[i]
            allBits[i] = (floor(planes[p % 3][p / 3]).toInt() and 1).toByte()
            if (i % budget == 0) onProgress?.invoke(0.2 + 0.8 * i / allBits.size.toDouble())
        }
        val bytes = bitsToBytes(allBits, need)
        val out = ByteArray(hdr.length)
        System.arraycopy(bytes, HEADER_BYTES, out, 0, hdr.length)
        onProgress?.invoke(1.0)
        return StegoResult(METHOD_LSB, hdr.contentType, out)
    }

    /* =====================================================================
     * 6. 自动提取
     * =================================================================== */

    /**
     * 先试 LSB（快且不会误判），再试鲁棒模式。
     */
    fun autoExtract(
        planes: Array<DoubleArray>,
        w: Int,
        h: Int,
        password: Long,
        delta: Double = DEFAULT_DELTA,
        onProgress: ((Double) -> Unit)? = null,
    ): StegoResult? {
        extractLsb(planes, w, h, password) { onProgress?.invoke(it * 0.45) }?.let { return it }
        return extractRobust(planes, w, h, password, delta) { onProgress?.invoke(0.45 + it * 0.55) }
    }

    /** 从 Img 取平面数组 */
    fun planesOf(img: Img) = img.planes

    fun utf8Encode(s: String) = s.toByteArray(Charsets.UTF_8)

    fun utf8Decode(b: ByteArray) = String(b, Charsets.UTF_8)
}
