package com.dragonxash.bwm.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.ProgressBar
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.viewbinding.ViewBinding
import com.dragonxash.bwm.R
import com.dragonxash.bwm.core.Backdrop
import com.dragonxash.bwm.core.BwmOptions
import com.dragonxash.bwm.core.ImageCodec
import com.dragonxash.bwm.core.TransformMode
import com.dragonxash.bwm.databinding.PartOptionsBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 界面参数 + 透明合成方式 */
class UiParams(val bwm: BwmOptions, val backdrop: Backdrop)

abstract class BaseFragment<VB : ViewBinding> : Fragment() {

    private var _binding: VB? = null
    protected val binding: VB get() = _binding!!

    protected abstract fun inflate(inflater: LayoutInflater, container: ViewGroup?): VB

    /**
     * 参数区（FFT 三个面板共用同一份布局）。
     * 隐写面板不涉及种子 / 强度 / 变换模式，返回 null 即跳过初始化。
     */
    protected open val optionsBinding: PartOptionsBinding? get() = null

    private var pickCallback: ((Bitmap) -> Unit)? = null
    private var pendingSave: Bitmap? = null

    private val pickImage =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            val cb = pickCallback
            pickCallback = null
            if (uri != null && cb != null) decodeAsync(uri, cb)
        }

    private val createDoc =
        registerForActivityResult(ActivityResultContracts.CreateDocument("image/png")) { uri ->
            val bmp = pendingSave
            pendingSave = null
            if (uri != null && bmp != null) saveAsync(uri, bmp)
        }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = inflate(inflater, container)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        setupOptions()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
        pickCallback = null
        pendingSave = null
    }

    // ------------------------------------------------------------ 参数区

    private fun setupOptions() {
        val o = optionsBinding ?: return
        o.optMode.adapter = spinnerAdapter(
            getString(R.string.mode_numpy), getString(R.string.mode_channel)
        )
        o.optBackdrop.adapter = spinnerAdapter(
            getString(R.string.backdrop_white),
            getString(R.string.backdrop_black),
            getString(R.string.backdrop_ignore),
        )
        o.optMode.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                o.modeNote.setText(
                    if (pos == 1) R.string.mode_note_channel else R.string.mode_note_numpy
                )
            }

            override fun onNothingSelected(p: AdapterView<*>?) = Unit
        }
        // 初始化为默认项，触发一次说明刷新
        o.optMode.setSelection(0)

        o.optAlpha.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) {
                o.optAlphaVal.text = String.format("%.1f", alphaOf(p))
            }

            override fun onStartTrackingTouch(sb: SeekBar?) = Unit
            override fun onStopTrackingTouch(sb: SeekBar?) = Unit
        })
        o.optAlphaVal.text = String.format("%.1f", alphaOf(o.optAlpha.progress))

        o.optSeed.setOnFocusChangeListener { v, hasFocus ->
            if (!hasFocus) {
                val t = o.optSeed.text.toString()
                if (t.toLongOrNull() == null || t.toLong() < 0) o.optSeed.setText("20160930")
            }
        }
    }

    private fun alphaOf(progress: Int) = 0.5 + progress * 0.5

    private fun spinnerAdapter(vararg items: String): ArrayAdapter<String> =
        ArrayAdapter(
            requireContext(), android.R.layout.simple_spinner_item, items.toList()
        ).apply { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }

    protected fun readParams(): UiParams {
        val o = optionsBinding
            ?: return UiParams(BwmOptions(), Backdrop.WHITE)
        val seed = o.optSeed.text.toString().toLongOrNull()?.takeIf { it >= 0 } ?: 20160930L
        val mode = if (o.optMode.selectedItemPosition == 1) TransformMode.CHANNEL
        else TransformMode.NUMPY
        val backdrop = when (o.optBackdrop.selectedItemPosition) {
            1 -> Backdrop.BLACK
            2 -> Backdrop.IGNORE
            else -> Backdrop.WHITE
        }
        return UiParams(
            BwmOptions(seed = seed, alpha = alphaOf(o.optAlpha.progress), mode = mode),
            backdrop,
        )
    }

    // ------------------------------------------------------------ 选图

    protected fun pickImage(cb: (Bitmap) -> Unit) {
        pickCallback = cb
        pickImage.launch("image/*")
    }

    private fun decodeAsync(uri: Uri, cb: (Bitmap) -> Unit) {
        viewLifecycleOwner.lifecycleScope.launch {
            val bmp = withContext(Dispatchers.IO) {
                runCatching {
                    val opts = BitmapFactory.Options().apply {
                        inPreferredConfig = Bitmap.Config.ARGB_8888
                    }
                    requireContext().contentResolver.openInputStream(uri)?.use {
                        BitmapFactory.decodeStream(it, null, opts)
                    }
                }.getOrNull()
            }
            if (bmp == null) {
                toast("图片解码失败")
                return@launch
            }
            val fitted = ImageCodec.fitWithin(bmp, MAX_PIXELS)
            if (fitted !== bmp) {
                toast("图片已自动缩小到 ${fitted.width}×${fitted.height} 以适配内存")
            }
            cb(fitted)
        }
    }

    // ------------------------------------------------------------ 存图

    protected fun saveImage(bmp: Bitmap, suggestedName: String) {
        pendingSave = bmp
        createDoc.launch(suggestedName)
    }

    private fun saveAsync(uri: Uri, bmp: Bitmap) {
        viewLifecycleOwner.lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    requireContext().contentResolver.openOutputStream(uri)?.use { os ->
                        bmp.compress(Bitmap.CompressFormat.PNG, 100, os)
                    } ?: false
                }.getOrDefault(false)
            }
            toast(getString(if (ok) R.string.saved_ok else R.string.err_save_failed))
        }
    }

    // ------------------------------------------------------------ 长任务

    /**
     * 统一的「后台计算 + 进度显示」封装。
     * work 在 Default 线程执行，通过 report 回报 0..1 的进度，回到主线程刷新 UI。
     */
    protected fun runTask(
        runButton: View,
        bar: ProgressBar,
        label: TextView,
        work: suspend (report: (Double) -> Unit) -> Unit,
    ) {
        viewLifecycleOwner.lifecycleScope.launch {
            val t0 = System.currentTimeMillis()
            runButton.isEnabled = false
            bar.visibility = View.VISIBLE
            label.visibility = View.VISIBLE
            bar.progress = 0
            label.text = getString(R.string.processing)

            val report: (Double) -> Unit = { p ->
                val v = p.coerceIn(0.0, 1.0)
                activity?.runOnUiThread {
                    bar.progress = (v * 1000).toInt()
                    label.text = String.format(
                        "处理中 %d%%　已用 %.1f s",
                        (v * 100).toInt(),
                        (System.currentTimeMillis() - t0) / 1000.0,
                    )
                }
            }

            try {
                withContext(Dispatchers.Default) { work(report) }
            } catch (e: OutOfMemoryError) {
                toast("内存不足，请换用更小的图片")
            } catch (e: Exception) {
                toast(e.message ?: "处理失败")
            } finally {
                runButton.isEnabled = true
                bar.visibility = View.GONE
                label.visibility = View.GONE
            }
        }
    }

    // ------------------------------------------------------------ 杂项

    protected fun toast(msg: String) {
        if (isAdded) Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }

    /** 圆角底色，用于结论条 */
    protected fun roundRect(fill: Int, stroke: Int? = null): GradientDrawable =
        GradientDrawable().apply {
            cornerRadius = dp(10f)
            setColor(fill)
            stroke?.let { setStroke((1 * resources.displayMetrics.density).toInt(), it) }
        }

    protected fun dp(v: Float): Float = v * resources.displayMetrics.density

    protected fun sizeNote(w: Int, h: Int): String {
        val px = w.toLong() * h
        if (px > 12_000_000L) return "超大图，可能较慢"
        if (px > 3_000_000L) return "较大，约需数秒"
        if (!isPow2(w) || !isPow2(h)) return "尺寸非 2 的幂，会偏慢"
        return ""
    }

    private fun isPow2(v: Int) = v > 0 && (v and (v - 1)) == 0

    companion object {
        /** 手机内存有限，超过这个像素数先等比缩小 */
        const val MAX_PIXELS = 4_000_000
    }
}
