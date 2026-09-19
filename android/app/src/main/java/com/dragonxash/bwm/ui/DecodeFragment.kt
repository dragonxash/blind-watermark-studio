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
import com.dragonxash.bwm.core.Quantize
import com.dragonxash.bwm.databinding.FragmentDecodeBinding
import com.dragonxash.bwm.databinding.PartOptionsBinding

/** 分离：原始载体图 + 含水印图 -> 还原水印 */
class DecodeFragment : BaseFragment<FragmentDecodeBinding>() {

    override fun inflate(inflater: LayoutInflater, container: ViewGroup?) =
        FragmentDecodeBinding.inflate(inflater, container, false)

    override val optionsBinding: PartOptionsBinding get() = binding.opts

    private lateinit var imgSlot: SlotView
    private lateinit var wmSlot: SlotView

    private var rawBitmap: Bitmap? = null
    private var enhancedBitmap: Bitmap? = null
    private var showingRaw = true

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        imgSlot = SlotView(
            binding.decImgHint, binding.decImgPreview, binding.decImgMeta,
            { readParams().backdrop }, ::sizeNote,
        )
        wmSlot = SlotView(
            binding.decWmHint, binding.decWmPreview, binding.decWmMeta,
            { readParams().backdrop }, ::sizeNote,
        )
        imgSlot.attach(binding.decImgSlot) { pickImage { imgSlot.set(it) } }
        wmSlot.attach(binding.decWmSlot) { pickImage { wmSlot.set(it) } }

        binding.btnRun.setOnClickListener { runDecode() }
        binding.btnEnhance.setOnClickListener { toggleView() }
    }

    private fun runDecode() {
        val img = imgSlot.toImg()
        val imgWm = wmSlot.toImg()
        if (img == null || imgWm == null) {
            toast(getString(R.string.err_need_two_images))
            return
        }
        if (img.w != imgWm.w || img.h != imgWm.h) {
            toast("两张图尺寸必须一致（${img.w}×${img.h} 与 ${imgWm.w}×${imgWm.h}）")
            return
        }

        binding.resBox.visibility = View.GONE
        val params = readParams()

        runTask(binding.btnRun, binding.progBar, binding.progText) { report ->
            val res = BlindWatermark.decode(
                img, imgWm, params.bwm, Quantize.ROUND
            ) { report(it * 0.86) }

            report(0.9)
            val rawBmp = ImageCodec.toBitmap(res.wm)
            val enhBmp = ImageCodec.toBitmap(ImageCodec.enhance(res.wm))
            report(1.0)

            val (lo, hi) = contentRange(res.wm)
            activity?.runOnUiThread {
                show(rawBmp, enhBmp, lo, hi, img.w, img.h)
            }
        }
    }

    private fun show(
        raw: Bitmap,
        enh: Bitmap,
        lo: Double,
        hi: Double,
        w: Int,
        h: Int,
    ) {
        rawBitmap = raw
        enhancedBitmap = enh
        showingRaw = true

        binding.statText.text = buildString {
            append("输出尺寸　$w × $h\n")
            append(String.format("内容区动态范围　%.0f / 255\n", hi - lo))
            append(String.format("内容区最亮　%.0f\n", hi))
            append(String.format("内容区最暗　%.0f", maxOf(lo, 0.0)))
        }
        binding.previewImage.setImageBitmap(raw)
        binding.btnEnhance.setText(R.string.dec_enhance)
        binding.btnSave.setOnClickListener {
            saveImage(raw, "bwm-watermark-${System.currentTimeMillis()}.png")
        }
        binding.resBox.visibility = View.VISIBLE
    }

    private fun toggleView() {
        showingRaw = !showingRaw
        binding.previewImage.setImageBitmap(if (showingRaw) rawBitmap else enhancedBitmap)
        binding.btnEnhance.setText(
            if (showingRaw) R.string.dec_enhance else R.string.dec_original
        )
    }

    /** 水印实际落点（左上 1/4 区域）的取值区间，用来判断分离是否有效 */
    private fun contentRange(img: Img): Pair<Double, Double> {
        val hw = img.w / 2
        val hh = img.h / 2
        var lo = Double.MAX_VALUE
        var hi = -Double.MAX_VALUE
        for (c in 0..2) {
            val p = img.planes[c]
            for (y in 0 until hh) {
                val base = y * img.w
                for (x in 0 until hw) {
                    val v = p[base + x]
                    if (v < lo) lo = v
                    if (v > hi) hi = v
                }
            }
        }
        if (lo > hi) return 0.0 to 0.0
        return lo to hi
    }
}
