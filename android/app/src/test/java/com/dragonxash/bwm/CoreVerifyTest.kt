package com.dragonxash.bwm

import com.dragonxash.bwm.core.BlindWatermark
import com.dragonxash.bwm.core.BwmOptions
import com.dragonxash.bwm.core.CPrng
import com.dragonxash.bwm.core.Fft1D
import com.dragonxash.bwm.core.Fft2D
import com.dragonxash.bwm.core.Img
import com.dragonxash.bwm.core.Quantize
import com.dragonxash.bwm.core.TransformMode
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlin.math.abs

/**
 * 把 Kotlin 实现与 Python 参考实现（bwmforpy3.py）逐层比对。
 * 测试向量由 web/test/make_ref.py 生成。
 */
class CoreVerifyTest {

    private lateinit var ref: JSONObject
    private var H = 0
    private var W = 0
    private var WH = 0
    private var WW = 0
    private var seed = 0L
    private var alpha = 0.0

    @Before
    fun load() {
        val text = javaClass.classLoader!!
            .getResourceAsStream("ref.json")!!
            .bufferedReader(Charsets.UTF_8)
            .readText()
        ref = JSONObject(text)
        val meta = ref.getJSONObject("meta")
        H = meta.getInt("H"); W = meta.getInt("W")
        WH = meta.getInt("WH"); WW = meta.getInt("WW")
        seed = meta.getLong("seed"); alpha = meta.getDouble("alpha")
    }

    // ------------------------------------------------------------- 工具

    private fun JSONObject.arr(key: String): JSONArray = getJSONArray(key)

    private fun flat(key: String): DoubleArray {
        val a = ref.arr(key)
        return DoubleArray(a.length()) { a.getDouble(it) }
    }

    private fun flatInt(key: String): IntArray {
        val a = ref.arr(key)
        return IntArray(a.length()) { a.getInt(it) }
    }

    private fun imgFromFlat(f: DoubleArray, w: Int, h: Int): Img {
        val n = w * h
        return Img(w, h, Array(3) { c -> DoubleArray(n) { f[it * 3 + c] } })
    }

    private fun toInterleaved(img: Img): DoubleArray {
        val n = img.pixelCount
        return DoubleArray(n * 3) { k -> img.planes[k % 3][k / 3] }
    }

    private fun maxErr(a: DoubleArray, b: DoubleArray): Double {
        var m = 0.0
        for (i in a.indices) {
            val d = abs(a[i] - b[i])
            if (d > m) m = d
        }
        return m
    }

    private fun pickChannel(f: DoubleArray, count: Int, c: Int) =
        DoubleArray(count) { f[it * 3 + c] }

    private val opts get() = BwmOptions(seed = seed, alpha = alpha, mode = TransformMode.NUMPY)

    // --------------------------------------------------------- 随机数

    @Test
    fun cpythonPrngMatchesReference() {
        val rng = ref.getJSONObject("rng")

        // shuffle(1000) 的加权校验和 —— 一次抓住整条序列
        val arr = IntArray(1000) { it }
        CPrng(seed).shuffle(arr)
        var ck = 0L
        for (i in arr.indices) ck += arr[i].toLong() * (i + 1)
        assertEquals("shuffle(1000) 校验和", rng.getLong("shuffle1000_ck"), ck)

        // 前 40 项
        val head = rng.getJSONArray("shuffle1000_head")
        for (i in 0 until head.length()) {
            assertEquals("shuffle head[$i]", head.getInt(i), arr[i])
        }

        // randbelow
        val rb = rng.getJSONArray("randbelow100")
        val r2 = CPrng(seed)
        for (i in 0 until rb.length()) {
            assertEquals("randbelow[$i]", rb.getInt(i), r2.randbelow(100))
        }

        // getrandbits
        val gb = rng.getJSONArray("getrandbits20")
        val r3 = CPrng(seed)
        for (i in 0 until gb.length()) {
            assertEquals("getrandbits[$i]", gb.getLong(i), r3.getrandbits(20))
        }

        // random()（53 位精度）
        val rs = rng.getJSONArray("random_seq")
        val r4 = CPrng(seed)
        for (i in 0 until rs.length()) {
            assertEquals("random[$i]", rs.getDouble(i), r4.random(), 0.0)
        }

        // shuffle(17)
        val s17 = rng.getJSONArray("shuffle17")
        val a17 = IntArray(17) { it }
        CPrng(seed).shuffle(a17)
        for (i in 0 until s17.length()) {
            assertEquals("shuffle17[$i]", s17.getInt(i), a17[i])
        }
    }

    // ----------------------------------------------------------- 置换

    @Test
    fun permutationMatchesReference() {
        val perm = BlindWatermark.buildPattern(H, W, blankWm(), opts)
        val m = flatInt("m")
        val n = flatInt("n")
        assertEquals("m 长度", m.size, perm.m.size)
        assertEquals("n 长度", n.size, perm.n.size)
        for (i in m.indices) assertEquals("m[$i]", m[i], perm.m[i])
        for (i in n.indices) assertEquals("n[$i]", n[i], perm.n[i])
    }

    // ----------------------------------------------------------- 图案

    @Test
    fun patternMatchesReference() {
        val pat = BlindWatermark.buildPattern(H, W, realWm(), opts)

        val hwmFlat = flat("hwm")
        var k = 0
        for (i in 0 until pat.hh) {
            for (j in 0 until W) {
                for (c in 0..2) {
                    assertEquals("hwm[$i][$j][$c]", hwmFlat[(i * W + j) * 3 + c], pat.hwm[c][i * W + j], 0.0)
                    k++
                }
            }
        }

        val rwmFlat = flat("rwm")
        for (i in 0 until H) {
            for (j in 0 until W) {
                for (c in 0..2) {
                    assertEquals(
                        "rwm[$i][$j][$c]",
                        rwmFlat[(i * W + j) * 3 + c], pat.rwm[c][i * W + j], 0.0,
                    )
                }
            }
        }
    }

    // ------------------------------------------------------------- FFT

    @Test
    fun fftMatchesNumpy() {
        val img = imgFromFlat(flat("input_img"), W, H)
        val cxRe = Array(3) { c -> DoubleArray(W * H) { img.planes[c][it] } }
        val cxIm = Array(3) { DoubleArray(W * H) }

        val fft = Fft2D(W, 3)
        val bufRe = DoubleArray(W * 3)
        val bufIm = DoubleArray(W * 3)
        for (row in 0 until H) {
            for (j in 0 until W) {
                val base = row * W + j
                for (c in 0..2) {
                    bufRe[j * 3 + c] = cxRe[c][base]
                    bufIm[j * 3 + c] = cxIm[c][base]
                }
            }
            fft.transform(bufRe, bufIm, false)
            for (j in 0 until W) {
                val base = row * W + j
                for (c in 0..2) {
                    cxRe[c][base] = bufRe[j * 3 + c]
                    cxIm[c][base] = bufIm[j * 3 + c]
                }
            }
        }

        val f1Re = flat("f1_re")
        val f1Im = flat("f1_im")
        for (c in 0..2) {
            val eR = maxErr(cxRe[c], pickChannel(f1Re, W * H, c))
            val eI = maxErr(cxIm[c], pickChannel(f1Im, W * H, c))
            assertTrue("fft2 实部误差过大: $eR", eR < 1e-6)
            assertTrue("fft2 虚部误差过大: $eI", eI < 1e-6)
        }
    }

    @Test
    fun fftRoundTrip() {
        for (n in intArrayOf(16, 17, 60, 64, 100, 128, 210, 256)) {
            val plan = Fft1D(n)
            val re = DoubleArray(n) { Math.sin(it * 0.7) * 10 + it * 0.3 }
            val im = DoubleArray(n)
            val orig = re.copyOf()
            plan.forward(re, im)
            plan.inverse(re, im)
            val e = maxErr(re, orig)
            assertTrue("FFT round-trip n=$n 误差 $e", e < 1e-9)
        }
    }

    // -------------------------------------------------- encode / decode

    @Test
    fun encodeMatchesReference() {
        val img = imgFromFlat(flat("input_img"), W, H)
        val enc = BlindWatermark.encode(img, realWm(), opts)
        val e = maxErr(toInterleaved(enc.image), flat("enc_float"))
        assertTrue("encode 最大误差 $e", e < 1e-5)
    }

    @Test
    fun decodeMatchesReference() {
        val img = imgFromFlat(flat("input_img"), W, H)
        val encoded = imgFromFlat(flat("enc_float"), W, H)
        val dec = BlindWatermark.decode(img, encoded, opts, Quantize.TRUNC)

        // 中间量 rwm
        val raw = DoubleArray(W * H * 3)
        for (c in 0..2) {
            for (i in 0 until W * H) raw[i * 3 + c] = dec.raw[c][i]
        }
        val eRaw = maxErr(raw, flat("dec_float"))
        assertTrue("decode 中间量误差 $eRaw", eRaw < 1e-5)

        // 量化后的水印图（跨实现存在 ±1 的边界抖动，属必然现象）
        val got = toInterleaved(dec.wm)
        val want = flat("dec_uint8")
        var diff = 0
        var maxDiff = 0.0
        for (i in got.indices) {
            val d = abs(got[i] - want[i])
            if (d > 0) diff++
            if (d > maxDiff) maxDiff = d
        }
        val ratio = diff.toDouble() / got.size
        assertTrue("uint8 最大差 $maxDiff", maxDiff <= 1.0)
        assertTrue("uint8 差异比例 $ratio", ratio < 0.2)
    }

    // --------------------------------------------------------- 检测判据

    @Test
    fun detectRatioSeparatesCases() {
        val img = imgFromFlat(flat("input_img"), W, H)
        val encoded = imgFromFlat(flat("enc_float"), W, H)

        val withWm = BlindWatermark.detectPair(img, encoded, opts)
        assertTrue("含水印图比值应显著大于 1，实际 ${withWm.ratio}", withWm.ratio > 3.0)

        // 反例：把通道 0 整体平移一点，构造一张「无关图」
        val n = W * H
        val other = Img(W, H, Array(3) { c ->
            DoubleArray(n) { i -> (img.planes[c][i] + 37.0 * (c + 1)) % 256.0 }
        })
        val without = BlindWatermark.detectPair(img, other, opts)
        assertTrue("无关图比值应接近 1，实际 ${without.ratio}",
            without.ratio > 0.5 && without.ratio < 2.0)
    }

    @Test
    fun singlePixelPerturbationGivesRatioOne() {
        val img = imgFromFlat(flat("input_img"), W, H)
        val n = W * H
        val planes = Array(3) { c -> DoubleArray(n) { img.planes[c][it] } }
        planes[0][100] += 1.0
        val one = Img(W, H, planes)

        val det = BlindWatermark.detectPair(img, one, opts)
        // 单点扰动既含实部也含虚部，能量应当相当
        assertEquals("单像素扰动比值应约为 1", 1.0, det.ratio, 0.02)
    }

    // ----------------------------------------------------------- 素材

    private fun realWm(): Img {
        val n = WW * WH
        val f = flat("input_wm")
        return Img(WW, WH, Array(3) { c -> DoubleArray(n) { f[it * 3 + c] } })
    }

    private fun blankWm(): Img = Img(WW, WH, Array(3) { DoubleArray(WW * WH) })
}
