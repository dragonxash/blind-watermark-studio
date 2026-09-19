package com.dragonxash.bwm.ui

import android.graphics.Bitmap
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import com.dragonxash.bwm.R
import com.dragonxash.bwm.core.BlindWatermark
import com.dragonxash.bwm.core.ImageCodec
import com.dragonxash.bwm.core.Img
import com.dragonxash.bwm.databinding.FragmentEncodeBinding
import com.dragonxash.bwm.databinding.PartOptionsBinding
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sqrt

/** 合成：载体图 + 水印图 -> 带盲水印的图 */
class EncodeFragment : BaseFragment<FragmentEncodeBinding>() {

    override fun inflate(inflater: LayoutInflater, container: ViewGroup?) =
        FragmentEncodeBinding.inflate(inflater, container, false)

    override val optionsBinding: PartOptionsBinding get() = binding.opts

    private lateinit var imgSlot: SlotView
    private lateinit var wmSlot: SlotView
    private var encoded: Bitmap? = null

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        imgSlot = SlotView(
            binding.encImgHint, binding.encImgPreview, binding.encImgMeta,
            { readParams().backdrop }, ::sizeNote,
        )
        wmSlot = SlotView(
            binding.encWmHint, binding.encWmPreview, binding.encWmMeta,
            { readParams().backdrop }, ::sizeNote,
        )
        imgSlot.attach(binding.encImgSlot) { pickImage { imgSlot.set(it) } }
        wmSlot.attach(binding.encWmSlot) { pickImage { wmSlot.set(it) } }

        binding.btnRun.setOnClickListener { runEncode() }
    }

    private fun runEncode() {
        val src = imgSlot.toImg()
        val wm = wmSlot.toImg()
        if (src == null || wm == null) {
            toast(getString(R.string.err_need_two_images))
            return
        }
        val hh = src.h / 2
        if (wm.h >= hh || wm.w >= src.w) {
            toast("水印尺寸过大：高需小于 $hh、宽需小于 ${src.w}（当前水印 ${wm.w}×${wm.h}）")
            return
        }

        binding.resBox.visibility = View.GONE
        val params = readParams()

        runTask(binding.btnRun, binding.progBar, binding.progText) { report ->
            val t0 = System.currentTimeMillis()
            val res = BlindWatermark.encode(src, wm, params.bwm) { report(it * 0.88) }
            report(0.9)

            // 量化到 uint8（对齐 OpenCV 的 saturate_cast）
            val n = src.pixelCount
            val out = Array(3) { c ->
                DoubleArray(n) { i -> BlindWatermark.clampRound(res.image.planes[c][i]) }
            }
            val bmp = ImageCodec.toBitmap(Img(src.w, src.h, out))
            report(1.0)

            val st = diffStats(out, src.planes, n)
            val ms = System.currentTimeMillis() - t0
            activity?.runOnUiThread { show(bmp, st, ms) }
        }
    }

    private fun show(bmp: Bitmap, st: DiffStats, ms: Long) {
        encoded = bmp
        binding.statText.text = buildString {
            append("输出尺寸　${bmp.width} × ${bmp.height}\n")
            append(String.format("PSNR　%.2f dB\n", st.psnr))
            append(String.format("最大像素偏差　%.0f\n", st.max))
            append(String.format("RMS 误差　%.2f\n", sqrt(st.mse)))
            append(String.format("耗时　%.2f s", ms / 1000.0))
        }
        binding.previewImage.setImageBitmap(bmp)
        binding.resBox.visibility = View.VISIBLE
        binding.btnSave.setOnClickListener {
            saveImage(bmp, "bwm-encoded-${System.currentTimeMillis()}.png")
        }
    }

    private fun diffStats(a: Array<DoubleArray>, b: Array<DoubleArray>, n: Int): DiffStats {
        var sum2 = 0.0
        var mx = 0.0
        for (c in 0..2) {
            val x = a[c]
            val y = b[c]
            for (i in 0 until n) {
                val d = x[i] - y[i]
                sum2 += d * d
                val ad = abs(d)
                if (ad > mx) mx = ad
            }
        }
        return DiffStats(mx, sum2 / (n * 3.0))
    }
}

class DiffStats(val max: Double, val mse: Double) {
    val psnr: Double
        get() = if (mse > 0.0) 10.0 * log10(65025.0 / mse) else Double.POSITIVE_INFINITY
}
