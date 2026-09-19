package com.dragonxash.bwm

import com.dragonxash.bwm.core.Stego
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlin.math.abs

/**
 * 隐写引擎的跨语言一致性验证。
 *
 * 参考向量由 `web/test/make-stego-ref.js` 用网页版（stego.js）生成，
 * 覆盖：密码置换、LSB 嵌入输出、鲁棒提取、错误密码拒绝。
 *
 * 输入图不写进 JSON，而是用同一个 LCG 在两端各自复现 —— 少 190 KB 冗余。
 */
class StegoVerifyTest {

    private lateinit var ref: JSONObject
    private var W = 0
    private var H = 0
    private var NPX = 0
    private var lcgSeed = 0
    private var password = 0L
    private var delta = 0.0

    @Before
    fun load() {
        val text = javaClass.classLoader!!
            .getResourceAsStream("stego-ref.json")!!
            .bufferedReader(Charsets.UTF_8)
            .readText()
        ref = JSONObject(text)
        val m = ref.getJSONObject("meta")
        W = m.getInt("W")
        H = m.getInt("H")
        NPX = W * H
        lcgSeed = m.getInt("lcgSeed")
        password = m.getLong("password")
        delta = m.getDouble("delta")
    }

    // ------------------------------------------------------------- 素材

    /**
     * 与 JS 端同一套 LCG。Kotlin 的 Int 乘法按 2^32 回绕，
     * 与 JS 的 Math.imul + ToInt32 语义一致。
     */
    private fun srcPixels(): IntArray {
        var s = lcgSeed
        val out = IntArray(NPX * 3)
        for (i in out.indices) {
            s = s * 1103515245 + 12345
            s = s and 0x7fffffff
            out[i] = s % 256
        }
        return out
    }

    /** 交错像素（index = i*3 + c）-> BGR 三平面 */
    private fun planesFrom(pix: IntArray): Array<DoubleArray> =
        Array(3) { c -> DoubleArray(NPX) { i -> pix[i * 3 + c].toDouble() } }

    private fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun hexToPixels(hex: String): IntArray =
        IntArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16) }

    private fun hexByteAt(hex: String, i: Int): Int =
        hex.substring(i * 2, i * 2 + 2).toInt(16)

    // --------------------------------------------------------- 置换

    @Test
    fun orderPermutationMatchesJs() {
        val orders = ref.getJSONArray("orders")
        assertTrue("参考向量应含多组置换", orders.length() >= 5)
        for (i in 0 until orders.length()) {
            val o = orders.getJSONObject(i)
            val n = o.getInt("n")
            val pw = o.getLong("password")
            val got = Stego.makeOrder(n, pw)

            assertEquals("n=$n pw=$pw 长度", n, got.size)

            var weighted = 0L
            for (k in 0 until n) weighted += got[k].toLong() * (k + 1)
            assertEquals("n=$n pw=$pw 加权校验和", o.getLong("weighted"), weighted)

            val head = o.getJSONArray("head")
            for (k in 0 until head.length()) {
                assertEquals("n=$n pw=$pw head[$k]", head.getInt(k), got[k])
            }
        }
    }

    // ----------------------------------------------------------- LSB

    @Test
    fun lsbEmbedOutputIsByteIdenticalToJs() {
        val lsb = ref.getJSONObject("lsb")
        val payload = hexToBytes(lsb.getString("payloadHex"))
        val contentType = lsb.getInt("contentType")
        val outHex = lsb.getString("outHex")

        val planes = planesFrom(srcPixels())
        Stego.embedLsb(planes, W, H, payload, password, contentType)

        var mismatch = 0
        var firstBad = -1
        for (i in 0 until NPX * 3) {
            val got = planes[i % 3][i / 3].toInt()
            val want = hexByteAt(outHex, i)
            if (got != want) {
                if (firstBad < 0) firstBad = i
                mismatch++
            }
        }
        assertEquals(
            "LSB 嵌入结果应与网页版逐字节一致（首个不符下标 $firstBad）",
            0, mismatch,
        )
    }

    @Test
    fun lsbEmbeddingChangesExactlyTheExpectedNumberOfBits() {
        val lsb = ref.getJSONObject("lsb")
        val payload = hexToBytes(lsb.getString("payloadHex"))
        val want = lsb.getInt("changedBits")

        val src = srcPixels()
        val planes = planesFrom(src)
        Stego.embedLsb(planes, W, H, payload, password, lsb.getInt("contentType"))

        var changed = 0
        for (i in 0 until NPX * 3) {
            val a = src[i]
            val b = planes[i % 3][i / 3].toInt()
            var d = a xor b
            while (d != 0) {
                changed += d and 1
                d = d ushr 1
            }
        }
        assertEquals("LSB 实际改动的位数应与网页版一致", want, changed)
    }

    @Test
    fun extractLsbFromJsImage() {
        val lsb = ref.getJSONObject("lsb")
        val want = hexToBytes(lsb.getString("payloadHex"))
        val imgPix = hexToPixels(lsb.getString("outHex"))

        val res = Stego.extractLsb(planesFrom(imgPix), W, H, password)
        assertNotNull("应当能从网页版生成的数据里提取出内容", res)
        assertEquals("引擎标识", Stego.METHOD_LSB, res!!.method)
        assertEquals("内容类型", lsb.getInt("contentType"), res.contentType)
        assertArrayEquals("提取出的数据应与嵌入时相同", want, res.data)
    }

    // --------------------------------------------------------- 鲁棒

    @Test
    fun extractRobustFromJsImage() {
        val r = ref.getJSONObject("robust")
        val imgPix = hexToPixels(r.getString("outHex"))

        val res = Stego.extractRobust(planesFrom(imgPix), W, H, password, delta)
        assertNotNull("应当能从网页版嵌入的图里提取出文字", res)
        assertEquals("引擎标识", Stego.METHOD_ROBUST, res!!.method)
        assertEquals("内容类型", Stego.TYPE_TEXT, res.contentType)
        assertEquals("提取出的文字应完全一致", r.getString("text"), Stego.utf8Decode(res.data))
    }

    @Test
    fun robustKotlinRoundTripSurvivesNoise() {
        val r = ref.getJSONObject("robust")
        val payload = hexToBytes(r.getString("payloadHex"))
        val want = r.getString("text")

        val planes = planesFrom(srcPixels())
        Stego.embedRobust(planes, W, H, payload, password, Stego.TYPE_TEXT, delta)

        // 先验证无损往返
        val clean = Stego.extractRobust(planes, W, H, password, delta)
        assertNotNull("无损往返应当成功", clean)
        assertEquals("无损往返", want, Stego.utf8Decode(clean!!.data))

        // 再加 ±6 像素抖动，这正是鲁棒模式存在的意义
        var s = 12345
        for (i in 0 until NPX) {
            s = s * 1103515245 + 12345
            s = s and 0x7fffffff
            val jitter = (s % 13) - 6
            for (c in 0..2) {
                planes[c][i] = (planes[c][i] + jitter).coerceIn(0.0, 255.0)
            }
        }
        val noisy = Stego.extractRobust(planes, W, H, password, delta)
        assertNotNull("加噪后仍应能提取", noisy)
        assertEquals("加噪后提取", want, Stego.utf8Decode(noisy!!.data))
    }

    // ------------------------------------------------------- 错误密码

    @Test
    fun wrongPasswordYieldsNull() {
        val lsbImg = hexToPixels(ref.getJSONObject("lsb").getString("outHex"))
        assertNull("LSB 错误密码应拒绝",
            Stego.extractLsb(planesFrom(lsbImg), W, H, password + 1))

        val robustImg = hexToPixels(ref.getJSONObject("robust").getString("outHex"))
        assertNull("鲁棒错误密码应拒绝",
            Stego.extractRobust(planesFrom(robustImg), W, H, password + 1, delta))
    }

    // ------------------------------------------------------- 自动提取

    @Test
    fun autoExtractDetectsBothEngines() {
        val lsbImg = hexToPixels(ref.getJSONObject("lsb").getString("outHex"))
        val a = Stego.autoExtract(planesFrom(lsbImg), W, H, password, delta)
        assertNotNull(a)
        assertEquals("应识别出 LSB 引擎", Stego.METHOD_LSB, a!!.method)

        val robustImg = hexToPixels(ref.getJSONObject("robust").getString("outHex"))
        val b = Stego.autoExtract(planesFrom(robustImg), W, H, password, delta)
        assertNotNull(b)
        assertEquals("应识别出鲁棒引擎", Stego.METHOD_ROBUST, b!!.method)
    }

    // ---------------------------------------------------- 容量与容器

    @Test
    fun capacityMatchesJs() {
        val m = ref.getJSONObject("meta")
        assertEquals("鲁棒容量 bit", m.getInt("robustCapBits"), Stego.robustCapacityBits(W, H))
        assertEquals("LSB 容量 bit", m.getInt("lsbCapBits"), Stego.lsbCapacityBits(W, H))
        assertEquals("鲁棒容量字节", 86L, Stego.robustCapacityBytes(W, H))
        assertEquals("LSB 容量字节", 6134L, Stego.lsbCapacityBytes(W, H))
    }

    @Test
    fun containerRoundTripAndRejectsBadMagic() {
        val payload = byteArrayOf(1, 2, 3, 0xFF.toByte(), 128.toByte(), 0, 77)
        val packed = Stego.packContainer(Stego.METHOD_LSB, Stego.TYPE_IMAGE, payload)
        assertEquals("容器总长度", Stego.HEADER_BYTES + payload.size, packed.size)

        val hdr = Stego.readHeader(packed)
        assertNotNull(hdr)
        assertEquals(1, hdr!!.version)
        assertEquals(Stego.METHOD_LSB, hdr.method)
        assertEquals(Stego.TYPE_IMAGE, hdr.contentType)
        assertEquals(payload.size, hdr.length)

        assertNull("错误 magic 应被拒绝", Stego.readHeader(ByteArray(16)))
        assertNull("过短输入应被拒绝", Stego.readHeader(ByteArray(4)))

        // 大长度字段（验证移位拼接正确）
        val big = ByteArray(70000)
        val packedBig = Stego.packContainer(Stego.METHOD_ROBUST, Stego.TYPE_FILE, big)
        assertEquals(70000, Stego.readHeader(packedBig)!!.length)
    }

    @Test
    fun oversizePayloadIsRejected() {
        val planes = planesFrom(srcPixels())
        val tooBig = ByteArray(200)      // 鲁棒容量只有 86 字节
        var threw = false
        try {
            Stego.embedRobust(planes, W, H, tooBig, password)
        } catch (e: IllegalArgumentException) {
            threw = true
            assertTrue("报错信息应说明容量", e.message!!.contains("数据过大"))
        }
        assertTrue("超出鲁棒容量应当报错", threw)
    }

    // ------------------------------------------------- 底层数学自洽性

    @Test
    fun dctIsInvertible() {
        val src = DoubleArray(16) { (it * 13 % 29) - 14.0 }
        val dct = DoubleArray(16)
        val tmp = DoubleArray(16)
        val back = DoubleArray(16)
        val tmp2 = DoubleArray(16)
        Stego.dct4(src, dct, tmp)
        Stego.idct4(dct, back, tmp2)
        for (i in 0 until 16) {
            assertEquals("DCT 往返[$i]", src[i], back[i], 1e-12)
        }
    }

    @Test
    fun svdFactorizationAndDescendingOrder() {
        val a = DoubleArray(16) { (it * 7 % 23) - 11.0 }
        val u = DoubleArray(16)
        val s = DoubleArray(4)
        val v = DoubleArray(16)
        Stego.svd4(a, u, s, v)

        assertTrue("奇异值应非负", s.all { it >= 0.0 })
        for (i in 0 until 3) {
            assertTrue("奇异值应降序：s[$i]=${s[i]} < s[${i + 1}]=${s[i + 1]}", s[i] >= s[i + 1] - 1e-9)
        }

        val rec = DoubleArray(16)
        Stego.svd4Reconstruct(u, s, v, rec)
        var maxErr = 0.0
        for (i in 0 until 16) maxErr = maxOf(maxErr, abs(a[i] - rec[i]))
        assertTrue("A = U·S·Vᵀ 重构误差 $maxErr", maxErr < 1e-9)
    }

    @Test
    fun haarWaveletRoundTrip() {
        // 用 8x8 小块验证小波可逆，避免依赖反射
        val (w, h) = 8 to 8
        val n = (w / 2) * (h / 2)
        val src = DoubleArray(w * h) { (it * 17 % 61) - 30.0 }

        val ll = DoubleArray(n)
        val lh = DoubleArray(n)
        val hl = DoubleArray(n)
        val hh = DoubleArray(n)
        val out = DoubleArray(w * h)

        Stego.dwt2(src, w, h, ll, lh, hl, hh)
        Stego.idwt2(out, w, h, ll, lh, hl, hh)

        var maxErr = 0.0
        for (i in src.indices) maxErr = maxOf(maxErr, abs(src[i] - out[i]))
        assertTrue("Haar 往返误差 $maxErr", maxErr < 1e-12)
    }
}
