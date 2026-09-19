package com.dragonxash.bwm.core

/**
 * CPython 兼容的 MT19937 伪随机数发生器。
 *
 * 必须与 CPython 的 `random.seed(int)` / `getrandbits` / `_randbelow_with_getrandbits`
 * / `shuffle` 逐位一致，否则本 App 合成的水印无法被 Python 版 BlindWaterMark 解出，
 * 反之亦然。
 *
 * 对应 CPython 的 `_randommodule.c`：
 *   init_genrand(19650218) -> init_by_array(key) -> genrand_uint32()
 *
 * Kotlin 的 Int 是 32 位补码，乘法会自动按 2^32 回绕，与 C 的 uint32_t 语义一致；
 * 需要无符号语义时用 `ushr` / `and 0xFFFFFFFFL`。
 */
class CPrng(seed: Long) {

    private val mt = IntArray(MT_N)
    private var mti = MT_N + 1

    init {
        seedInternal(seed)
    }

    private fun initGenrand(s: Int) {
        mt[0] = s
        for (i in 1 until MT_N) {
            val prev = mt[i - 1] xor (mt[i - 1] ushr 30)
            mt[i] = 1812433253 * prev + i
        }
        mti = MT_N
    }

    private fun initByArray(key: IntArray) {
        initGenrand(19650218)
        var i = 1
        var j = 0
        var k = maxOf(MT_N, key.size)
        while (k > 0) {
            mt[i] = (mt[i] xor ((mt[i - 1] xor (mt[i - 1] ushr 30)) * 1664525)) + key[j] + j
            i++; j++
            if (i >= MT_N) { mt[0] = mt[MT_N - 1]; i = 1 }
            if (j >= key.size) j = 0
            k--
        }
        k = MT_N - 1
        while (k > 0) {
            mt[i] = (mt[i] xor ((mt[i - 1] xor (mt[i - 1] ushr 30)) * 1566083941)) - i
            i++
            if (i >= MT_N) { mt[0] = mt[MT_N - 1]; i = 1 }
            k--
        }
        mt[0] = 0x80000000.toInt()
        mti = MT_N
    }

    /** 等价于 CPython 的 random.seed(a)：取绝对值，拆成 32 位小端字数组 */
    private fun seedInternal(a: Long) {
        var n = if (a < 0) -a else a
        val key = ArrayList<Int>(2)
        if (n == 0L) key.add(0)
        while (n > 0L) {
            key.add((n and 0xFFFFFFFFL).toInt())
            n = n ushr 32
        }
        initByArray(key.toIntArray())
    }

    /** CPython: genrand_uint32()，返回值的 32 位模式（无符号语义） */
    private fun nextUInt32(): Int {
        if (mti >= MT_N) {
            var kk = 0
            while (kk < MT_N - MT_M) {
                val y = (mt[kk] and UPPER_MASK) or (mt[kk + 1] and LOWER_MASK)
                mt[kk] = mt[kk + MT_M] xor (y ushr 1) xor (if (y and 1 != 0) MATRIX_A else 0)
                kk++
            }
            while (kk < MT_N - 1) {
                val y = (mt[kk] and UPPER_MASK) or (mt[kk + 1] and LOWER_MASK)
                mt[kk] = mt[kk + (MT_M - MT_N)] xor (y ushr 1) xor (if (y and 1 != 0) MATRIX_A else 0)
                kk++
            }
            val y = (mt[MT_N - 1] and UPPER_MASK) or (mt[0] and LOWER_MASK)
            mt[MT_N - 1] = mt[MT_M - 1] xor (y ushr 1) xor (if (y and 1 != 0) MATRIX_A else 0)
            mti = 0
        }
        var y = mt[mti++]
        y = y xor (y ushr 11)
        y = y xor ((y shl 7) and 0x9d2c5680.toInt())
        y = y xor ((y shl 15) and 0xefc60000.toInt())
        y = y xor (y ushr 18)
        return y
    }

    /**
     * CPython: getrandbits(k)。
     * 每个 32 位字按小端拼装，最后一个字右移 (32-剩余位) 位。
     * k <= 53 时结果精确。
     */
    fun getrandbits(k: Int): Long {
        val words = (k - 1) / 32 + 1
        var result = 0L
        var shift = 0
        var remain = k
        for (i in 0 until words) {
            var r = nextUInt32()
            if (remain < 32) r = r ushr (32 - remain)
            result = result or ((r.toLong() and 0xFFFFFFFFL) shl shift)
            shift += 32
            remain -= 32
        }
        return result
    }

    /** CPython: Random._randbelow_with_getrandbits(n) */
    fun randbelow(n: Int): Int {
        if (n <= 0) return 0
        val k = 32 - Integer.numberOfLeadingZeros(n)
        while (true) {
            val r = getrandbits(k)          // 0 .. 2^k-1，Long 保证无符号语义
            if (r < n) return r.toInt()
        }
    }

    /** CPython 3.x: random.shuffle(x) —— 原地洗牌 */
    fun shuffle(a: IntArray) {
        for (i in a.size - 1 downTo 1) {
            val j = randbelow(i + 1)
            val t = a[i]; a[i] = a[j]; a[j] = t
        }
    }

    /** CPython: random.random()（53 位精度），供 Python 2 兼容模式使用 */
    fun random(): Double {
        val a = nextUInt32() ushr 5
        val b = nextUInt32() ushr 6
        return ((a.toLong() and 0x1FFFFFFFL) * 67108864.0 + (b.toLong() and 0x3FFFFFFFL)) *
            (1.0 / 9007199254740992.0)
    }

    /** Python 2 版 shuffle：j = int(random() * (i + 1)) */
    fun oldShuffle(a: IntArray) {
        for (i in a.size - 1 downTo 1) {
            val j = (random() * (i + 1)).toInt()
            val t = a[i]; a[i] = a[j]; a[j] = t
        }
    }

    private companion object {
        const val MT_N = 624
        const val MT_M = 397
        const val MATRIX_A = 0x9908b0df.toInt()
        const val UPPER_MASK = 0x80000000.toInt()
        const val LOWER_MASK = 0x7fffffff
    }
}
