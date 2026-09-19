package com.dragonxash.bwm.ui

import android.graphics.Bitmap
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.content.ContextCompat
import com.dragonxash.bwm.R
import com.dragonxash.bwm.core.BlindWatermark
import com.dragonxash.bwm.core.BlindWatermark.RadialProfile
import com.dragonxash.bwm.core.DetectResult
import com.dragonxash.bwm.core.ImageCodec
import com.dragonxash.bwm.core.Img
import com.dragonxash.bwm.core.Quantize
import com.dragonxash.bwm.databinding.FragmentDetectBinding
import com.dragonxash.bwm.databinding.PartOptionsBinding

/** 检测：判定是否存在盲水印，可选候选水印核对 */
class DetectFragment : BaseFragment<FragmentDetectBinding>() {

    override fun inflate(inflater: LayoutInflater, container: ViewGroup?) =
        FragmentDetectBinding.inflate(inflater, container, false)

    override val optionsBinding: PartOptionsBinding get() = binding.opts

    private lateinit var targetSlot: SlotView
    private lateinit var originSlot: SlotView
    private lateinit var candSlot: SlotView

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        targetSlot = SlotView(
            binding.detTargetHint, binding.detTargetPreview, binding.detTargetMeta,
            { readParams().backdrop }, ::sizeNote,
        )
        originSlot = SlotView(
            binding.detOriginHint, binding.detOriginPreview, binding.detOriginMeta,
            { readParams().backdrop }, ::sizeNote,
        )
        candSlot = SlotView(
            binding.detCandHint, binding.detCandPreview, binding.detCandMeta,
            { readParams().backdrop }, ::sizeNote,
        )
        targetSlot.attach(binding.detTargetSlot) { pickImage { targetSlot.set(it) } }
        originSlot.attach(binding.detOriginSlot) { pickImage { originSlot.set(it) } }
        candSlot.attach(binding.detCandSlot) { pickImage { candSlot.set(it) } }

        binding.btnRun.setOnClickListener { runDetect() }
    }

    private fun runDetect() {
        val target = targetSlot.toImg()
        if (target == null) {
            toast(getString(R.string.err_need_target))
            return
        }
        val origin = originSlot.toImg()
        val cand = candSlot.toImg()
        val params = readParams()

        binding.resBox.visibility = View.GONE
        binding.previewBox.visibility = View.GONE

        runTask(binding.btnRun, binding.progBar, binding.progText) { report ->
            if (origin != null) {
                if (origin.w != target.w || origin.h != target.h) {
                    throw IllegalArgumentException(
                        "原图与待检图尺寸不一致（${origin.w}×${origin.h} 与 ${target.w}×${target.h}）"
                    )
                }
                val det = BlindWatermark.detectPair(origin, target, params.bwm) {
                    report(it * 0.45)
                }
                val dec = BlindWatermark.decode(
                    origin, target, params.bwm, Quantize.ROUND
                ) { report(0.45 + it * 0.45) }

                var ncc = Double.NaN
                if (cand != null) {
                    if (cand.h < target.h / 2 && cand.w < target.w) {
                        ncc = nccWithCandidate(dec.wm, cand)
                    }
                }
                report(1.0)
                val bmp = ImageCodec.toBitmap(dec.wm)
                activity?.runOnUiThread { showExact(det, bmp, ncc) }
            } else {
                val prof = BlindWatermark.radialSpectrum(target) { report(it * 0.95) }
                report(1.0)
                activity?.runOnUiThread { showBlind(prof) }
            }
        }
    }

    // --------------------------------------------------------- 精确检测

    private fun showExact(det: DetectResult, bmp: Bitmap, ncc: Double) {
        val ratio = det.ratio

        var title = getString(R.string.det_no_watermark)
        var sub = "残差的实部与虚部能量相当，与「无水印」的噪声特征一致。"
        var bg = R.color.danger_soft
        var fg = R.color.danger

        if (ratio >= 3.0) {
            title = getString(R.string.det_has_watermark)
            sub = "频谱残差被强制成实值，符合本算法嵌入水印的特征。"
            bg = R.color.ok_soft
            fg = R.color.ok
        } else if (ratio >= 1.8) {
            title = getString(R.string.det_maybe_watermark)
            sub = "指标高于阈值但不够显著，可能是 alpha 很小，或图片被重压缩过。"
            bg = R.color.warn_soft
            fg = R.color.warn
        }

        // 有候选水印时，互相关结果优先作为结论
        if (ncc.isFinite() && ncc > 0.5) {
            title = "确认是这张水印"
            sub = String.format("与候选水印的归一化互相关达 %.3f（大于 0.5 视为同一张）。", ncc)
            bg = R.color.ok_soft
            fg = R.color.ok
        }

        val ctx = requireContext()
        binding.verdictBox.background = roundRect(ContextCompat.getColor(ctx, bg))
        binding.verdictTitle.setTextColor(ContextCompat.getColor(ctx, fg))
        binding.verdictSub.setTextColor(ContextCompat.getColor(ctx, fg))
        binding.verdictTitle.text = title
        binding.verdictSub.text = sub

        binding.statText.text = buildString {
            append("实部/虚部能量比　${fmtRatio(ratio)}\n")
            append("残差实部能量　${fmtSci(det.eRe)}\n")
            append("残差虚部能量　${fmtSci(det.eIm)}\n")
            append("判据阈值　≥ 3.0 判为有水印")
            if (ncc.isFinite()) {
                append(String.format("\n候选水印互相关　%.3f", ncc))
            }
        }

        binding.previewImage.setImageBitmap(bmp)
        binding.previewBox.visibility = View.VISIBLE
        binding.btnSave.setOnClickListener {
            saveImage(bmp, "bwm-watermark-${System.currentTimeMillis()}.png")
        }
        binding.resBox.visibility = View.VISIBLE
    }

    // ------------------------------------------------------------- 盲检

    private fun showBlind(prof: RadialProfile) {
        val excess = prof.excess
        val ctx = requireContext()

        val suspicious = excess >= 4.0
        binding.verdictBox.background = roundRect(
            ContextCompat.getColor(ctx, if (suspicious) R.color.warn_soft else R.color.danger_soft)
        )
        val fg = ContextCompat.getColor(ctx, if (suspicious) R.color.warn else R.color.danger)
        binding.verdictTitle.setTextColor(fg)
        binding.verdictSub.setTextColor(fg)

        binding.verdictTitle.text = if (suspicious) "高频存在异常能量" else "未见明显异常"
        binding.verdictSub.text = if (suspicious) {
            String.format(
                "径向功率谱的高频段比自然图像基线高约 %.1f 倍，值得进一步核查。", excess
            )
        } else {
            String.format("高频段与自然图像基线偏差约 %.1f 倍，属正常范围。", excess)
        }

        binding.statText.text = buildString {
            append(String.format("高频超出基线　%.2f 倍\n", excess))
            append("采样环带数　${prof.bins}\n")
            append("判定依据　启发式（仅作参考）\n\n")
            append("盲检只是参考，不能作为判定依据。这套算法本质是加法式频域水印，")
            append("必须拿到原图才能可靠判定 —— 没有原图时「原图的频谱」完全未知，")
            append("任何统计特征都可能被图像自身的纹理和噪声淹没。")
        }

        binding.previewBox.visibility = View.GONE
        binding.resBox.visibility = View.VISIBLE
    }

    // ------------------------------------------------------------- 工具

    private fun nccWithCandidate(decoded: Img, cand: Img): Double {
        val n = cand.w * cand.h * 3
        val a = DoubleArray(n)
        val b = DoubleArray(n)
        var k = 0
        for (c in 0..2) {
            for (i in 0 until cand.h) {
                for (j in 0 until cand.w) {
                    a[k] = decoded.planes[c][i * decoded.w + j]
                    b[k] = cand.planes[c][i * cand.w + j]
                    k++
                }
            }
        }
        return BlindWatermark.ncc(a, b)
    }

    private fun fmtRatio(r: Double): String = when {
        !r.isFinite() -> "∞"
        r >= 1000.0 -> "> 1000"
        else -> String.format("%.2f", r)
    }

    private fun fmtSci(v: Double): String = String.format("%.2e", v)
}
