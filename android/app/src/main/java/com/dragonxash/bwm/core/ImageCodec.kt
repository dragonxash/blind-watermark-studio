package com.dragonxash.bwm.core

import android.graphics.Bitmap
import kotlin.math.sqrt

/** 透明区域的处理方式 */
enum class Backdrop(val r: Int, val g: Int, val b: Int) {
    WHITE(255, 255, 255),
    BLACK(0, 0, 0),
    IGNORE(0, 0, 0),
}

object ImageCodec {

    private fun clamp255(x: Double): Int {
        if (x <= 0.0) return 0
        if (x >= 255.0) return 255
        return Math.rint(x).toInt()
    }

    /** Bitmap -> Img（BGR 平面，与 OpenCV 通道顺序一致） */
    fun toImg(bmp: Bitmap, backdrop: Backdrop = Backdrop.WHITE): Img {
        val w = bmp.width
        val h = bmp.height
        val np = w * h
        val px = IntArray(np)
        bmp.getPixels(px, 0, w, 0, 0, w, h)

        val bOut = DoubleArray(np)
        val gOut = DoubleArray(np)
        val rOut = DoubleArray(np)
        val flatten = backdrop != Backdrop.IGNORE

        for (i in 0 until np) {
            val p = px[i]
            var r = (p shr 16) and 0xFF
            var g = (p shr 8) and 0xFF
            var b = p and 0xFF
            val a = (p ushr 24) and 0xFF
            if (flatten && a != 255) {
                val t = a / 255.0
                r = (r * t + backdrop.r * (1 - t)).toInt()
                g = (g * t + backdrop.g * (1 - t)).toInt()
                b = (b * t + backdrop.b * (1 - t)).toInt()
            }
            bOut[i] = b.toDouble()
            gOut[i] = g.toDouble()
            rOut[i] = r.toDouble()
        }
        return Img(w, h, arrayOf(bOut, gOut, rOut))
    }

    /** Img -> Bitmap（自动 clamp 到 [0,255]） */
    fun toBitmap(img: Img): Bitmap {
        val np = img.pixelCount
        val px = IntArray(np)
        val b = img.planes[0]
        val g = img.planes[1]
        val r = img.planes[2]
        for (i in 0 until np) {
            px[i] = (0xFF shl 24) or (clamp255(r[i]) shl 16) or (clamp255(g[i]) shl 8) or clamp255(b[i])
        }
        return Bitmap.createBitmap(px, img.w, img.h, Bitmap.Config.ARGB_8888)
    }

    /**
     * 对比度增强：以中位数为噪声底、99.5 分位为白点做线性拉伸。
     * 分离出的水印往往压在一层灰噪声上，拉伸后轮廓明显得多。
     */
    fun enhance(img: Img): Img {
        val np = img.pixelCount
        val hist = IntArray(256)
        for (i in 0 until np) {
            val v = ((img.planes[0][i] + img.planes[1][i] + img.planes[2][i]) / 3.0)
                .toInt().coerceIn(0, 255)
            hist[v]++
        }
        var cum = 0
        var lo = 0
        var hi = 255
        for (i in 0 until 256) {
            cum += hist[i]
            if (cum >= np * 0.5) { lo = i; break }
        }
        cum = 0
        for (i in 0 until 256) {
            cum += hist[i]
            if (cum >= np * 0.995) { hi = i; break }
        }
        if (hi <= lo) hi = lo + 1

        val scale = 255.0 / (hi - lo)
        val out = Array(3) { DoubleArray(np) }
        for (c in 0 until 3) {
            val src = img.planes[c]
            val dst = out[c]
            for (i in 0 until np) {
                dst[i] = ((src[i] - lo) * scale).coerceIn(0.0, 255.0)
            }
        }
        return Img(img.w, img.h, out)
    }

    /** 像素数超上限时等比缩小，避免手机内存吃紧 */
    fun fitWithin(bmp: Bitmap, maxPixels: Int): Bitmap {
        val np = bmp.width.toLong() * bmp.height.toLong()
        if (np <= maxPixels) return bmp
        val scale = sqrt(maxPixels.toDouble() / np)
        val w = maxOf(1, (bmp.width * scale).toInt())
        val h = maxOf(1, (bmp.height * scale).toInt())
        return Bitmap.createScaledBitmap(bmp, w, h, true)
    }
}
