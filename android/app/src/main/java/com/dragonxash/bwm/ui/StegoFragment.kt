package com.dragonxash.bwm.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.dragonxash.bwm.R
import com.dragonxash.bwm.core.Backdrop
import com.dragonxash.bwm.core.BlindWatermark
import com.dragonxash.bwm.core.ImageCodec
import com.dragonxash.bwm.core.Img
import com.dragonxash.bwm.core.Stego
import com.dragonxash.bwm.core.StegoResult
import com.dragonxash.bwm.databinding.FragmentStegoBinding
import com.dragonxash.bwm.databinding.PartOptionsBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.log10

/**
 * 隐写：把文字或任意文件藏进图片，提取时**不需要原图**。
 *
 * 与上面三个 FFT 面板的区别：
 *   - 藏的是数据，不是水印图片
 *   - 提取只要密码（FFT 面板必须拿到原图）
 *   - 有两条路线：鲁棒模式（DWT-DCT-SVD，抗压缩）与大容量模式（LSB，能放文件）
 */
class StegoFragment : BaseFragment<FragmentStegoBinding>() {

    override fun inflate(inflater: LayoutInflater, container: ViewGroup?) =
        FragmentStegoBinding.inflate(inflater, container, false)

    // 隐写不涉及 seed / alpha / 变换模式，不用参数区
    override val optionsBinding: PartOptionsBinding? get() = null

    private lateinit var imgSlot: SlotView
    private lateinit var extractSlot: SlotView

    /** 待嵌入的文件字节（选择文件后填充） */
    private var fileBytes: ByteArray? = null
    private var fileLabel: String? = null

    /** 提取结果，供「保存还原的文件」使用 */
    private var extracted: StegoResult? = null
    private var extractedName = "bwm-extracted.bin"

    private val pickFile =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri != null) loadFile(uri)
        }

    private val createOutDoc =
        registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
            val res = extracted
            if (uri != null && res != null) writeFile(uri, res.data)
        }

    /* ==================================================== 生命周期 */

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        imgSlot = SlotView(
            binding.stgImgHint, binding.stgImgPreview, binding.stgImgMeta,
            { Backdrop.WHITE }, ::sizeNote,
        )
        extractSlot = SlotView(
            binding.stgxImgHint, binding.stgxImgPreview, binding.stgxImgMeta,
            { Backdrop.WHITE }, ::sizeNote,
        )
        imgSlot.attach(binding.stgImgSlot) {
            pickImage {
                imgSlot.set(it)
                refreshCapacity()
            }
        }
        extractSlot.attach(binding.stgxImgSlot) { pickImage { extractSlot.set(it) } }

        setupMethodSpinner()
        setupSegmentTabs()
        setupKindTabs()

        binding.stgText.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            override fun afterTextChanged(s: Editable?) = refreshCapacity()
        })
        binding.btnPickFile.setOnClickListener { pickFile.launch("*/*") }
        binding.btnRunEmbed.setOnClickListener { runEmbed() }
        binding.btnRunExtract.setOnClickListener { runExtract() }
        binding.btnCopyText.setOnClickListener { copyText() }
        binding.btnSaveFile.setOnClickListener { createOutDoc.launch(extractedName) }

        refreshCapacity()
    }

    /* ==================================================== 界面搭建 */

    private fun setupMethodSpinner() {
        val adapter = android.widget.ArrayAdapter(
            requireContext(),
            android.R.layout.simple_spinner_item,
            listOf(getString(R.string.stg_robust), getString(R.string.stg_lsb)),
        ).apply { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        binding.stgMethod.adapter = adapter
        binding.stgMethod.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) =
                refreshCapacity()

            override fun onNothingSelected(p: AdapterView<*>?) = Unit
        }
        binding.stgMethod.setSelection(0)
    }

    private fun setupSegmentTabs() {
        binding.segTabs.check(R.id.segEmbed)
        binding.segTabs.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            val embed = checkedId == R.id.segEmbed
            binding.boxEmbed.visibility = if (embed) View.VISIBLE else View.GONE
            binding.boxExtract.visibility = if (embed) View.GONE else View.VISIBLE
        }
        binding.boxEmbed.visibility = View.VISIBLE
        binding.boxExtract.visibility = View.GONE
    }

    private fun setupKindTabs() {
        binding.kindTabs.check(R.id.kindText)
        binding.kindTabs.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            val isFile = checkedId == R.id.kindFile
            binding.boxFile.visibility = if (isFile) View.VISIBLE else View.GONE
            binding.stgText.visibility = if (isFile) View.GONE else View.VISIBLE
            binding.stgTextMeta.visibility = if (isFile) View.GONE else View.VISIBLE
            refreshCapacity()
        }
        binding.boxFile.visibility = View.GONE
    }

    private fun isFileMode() = binding.kindTabs.checkedButtonId == R.id.kindFile
    private fun isLsbMode() = binding.stgMethod.selectedItemPosition == 1

    /* ==================================================== 容量与密码 */

    /** 当前准备嵌入的数据（未准备好返回 null） */
    private fun currentPayload(): ByteArray? = if (isFileMode()) {
        fileBytes
    } else {
        val t = binding.stgText.text.toString()
        if (t.isEmpty()) null else Stego.utf8Encode(t)
    }

    private fun currentContentType() =
        if (isFileMode()) Stego.TYPE_FILE else Stego.TYPE_TEXT

    private fun readPassword(): Long =
        binding.stgPassword.text.toString().toLongOrNull()?.takeIf { it >= 0 } ?: 20260919L

    private fun capacityBytesOf(bmp: Bitmap): Long =
        if (isLsbMode()) Stego.lsbCapacityBytes(bmp.width, bmp.height)
        else Stego.robustCapacityBytes(bmp.width, bmp.height)

    private fun refreshCapacity() {
        val bmp = imgSlot.bitmap
        if (bmp == null) {
            binding.stgCapacity.text = getString(R.string.stg_need_image_first)
            return
        }
        val cap = capacityBytesOf(bmp)
        val need = currentPayload()?.size?.toLong() ?: 0L
        val modeName = getString(if (isLsbMode()) R.string.stg_lsb else R.string.stg_robust)

        val sb = StringBuilder()
        sb.append("方式　").append(modeName).append('\n')
        sb.append("负载图　").append(bmp.width).append(" × ").append(bmp.height)
            .append(" px\n")
        sb.append("可用容量　").append(fmtBytes(cap))
        if (need > 0) {
            sb.append("\n当前内容　").append(fmtBytes(need))
            sb.append(if (need <= cap) "　✓ 可以嵌入" else "　✗ 超出容量")
        } else {
            sb.append("\n当前内容　尚未输入")
        }
        if (!isLsbMode() && cap <= 0) {
            sb.append("\n\n提示：鲁棒模式要求图片至少 16×16，且容量随尺寸增长很慢，")
            sb.append("放大图片或改用大容量模式可放更多内容。")
        }
        binding.stgCapacity.text = sb.toString()
    }

    /* ==================================================== 选文件 */

    private fun loadFile(uri: Uri) {
        viewLifecycleOwner.lifecycleScope.launch {
            val bytes = withContext(Dispatchers.IO) {
                runCatching {
                    val size = querySize(uri)
                    if (size > MAX_FILE_BYTES) return@runCatching null
                    requireContext().contentResolver.openInputStream(uri)?.use { it.readBytes() }
                }.getOrNull()
            }
            if (bytes == null) {
                toast("文件读取失败，或超过 ${fmtBytes(MAX_FILE_BYTES)} 上限")
                return@launch
            }
            fileBytes = bytes
            fileLabel = queryName(uri)
            binding.stgFileInfo.text = "${fileLabel}　${fmtBytes(bytes.size.toLong())}"
            refreshCapacity()
        }
    }

    private fun querySize(uri: Uri): Long = runCatching {
        requireContext().contentResolver.query(uri, null, null, null, null)?.use { c ->
            val i = c.getColumnIndex(OpenableColumns.SIZE)
            if (i >= 0 && c.moveToFirst() && !c.isNull(i)) c.getLong(i) else -1L
        } ?: -1L
    }.getOrDefault(-1L)

    private fun queryName(uri: Uri): String {
        val fromProvider = runCatching {
            requireContext().contentResolver.query(uri, null, null, null, null)?.use { c ->
                val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (i >= 0 && c.moveToFirst()) c.getString(i) else null
            }
        }.getOrNull()
        return fromDisplay(fromProvider ?: uri.lastPathSegment ?: "未知文件")
    }

    /**
     * SAF 返回的名字可能带路径分隔符，直接用会搞坏文件名。
     * 这里只留最后一段并剔除非法字符（含非 ASCII 的路径分隔符）。
     */
    private fun fromDisplay(raw: String): String {
        val last = raw.split('/', '\\').lastOrNull().orEmpty()
        val cleaned = last.map { ch ->
            if (ch.isISOControl() || ch == ':' || ch == '*' || ch == '?' ||
                ch == '"' || ch == '<' || ch == '>' || ch == '|'
            ) '_' else ch
        }.joinToString("")
        return cleaned.take(80).ifBlank { "未命名文件" }
    }

    /* ==================================================== 嵌入 */

    private fun runEmbed() {
        val bmp = imgSlot.bitmap
        if (bmp == null) {
            toast(getString(R.string.stg_err_no_image))
            return
        }
        val payload = currentPayload()
        if (payload == null) {
            toast(getString(R.string.stg_err_no_content))
            return
        }
        val cap = capacityBytesOf(bmp)
        if (payload.size.toLong() > cap) {
            toast("内容 ${fmtBytes(payload.size.toLong())} 超出容量 ${fmtBytes(cap)}，请换更大的图或改用大容量模式")
            return
        }

        binding.resBox.visibility = View.GONE
        val lsb = isLsbMode()
        val password = readPassword()
        val contentType = currentContentType()

        runTask(binding.btnRunEmbed, binding.progBar, binding.progText) { report ->
            val t0 = System.currentTimeMillis()
            val img = ImageCodec.toImg(bmp, Backdrop.WHITE)
            val n = img.pixelCount
            val planes = Array(3) { c -> DoubleArray(n) { i -> img.planes[c][i] } }

            if (lsb) {
                Stego.embedLsb(planes, img.w, img.h, payload, password, contentType) {
                    report(it * 0.95)
                }
            } else {
                Stego.embedRobust(
                    planes, img.w, img.h, payload, password, contentType, Stego.DEFAULT_DELTA,
                ) { report(it * 0.95) }
            }

            // 量化到 0..255（与引擎内部的取整规则一致）
            val out = Array(3) { c -> DoubleArray(n) { i -> BlindWatermark.clampRound(planes[c][i]) } }
            val outBmp = ImageCodec.toBitmap(Img(img.w, img.h, out))
            report(1.0)

            var sum2 = 0.0
            var mx = 0.0
            for (c in 0..2) {
                for (i in 0 until n) {
                    val d = out[c][i] - img.planes[c][i]
                    sum2 += d * d
                    val ad = abs(d)
                    if (ad > mx) mx = ad
                }
            }
            val mse = sum2 / (n * 3.0)
            val psnr = if (mse > 0) 10.0 * log10(65025.0 / mse) else Double.POSITIVE_INFINITY
            val ms = System.currentTimeMillis() - t0

            activity?.runOnUiThread {
                showEmbed(outBmp, payload.size, lsb, mx, psnr, ms)
            }
        }
    }

    private fun showEmbed(
        bmp: Bitmap,
        payloadBytes: Int,
        lsb: Boolean,
        maxDiff: Double,
        psnr: Double,
        ms: Long,
    ) {
        binding.statText.text = buildString {
            append("输出尺寸　${bmp.width} × ${bmp.height}\n")
            append("嵌入方式　").append(if (lsb) "大容量模式（LSB）" else "鲁棒模式（DWT-DCT-SVD）").append('\n')
            append("嵌入数据　${fmtBytes(payloadBytes.toLong())}（${payloadBytes * 8} bit）\n")
            append(String.format("最大像素偏差　%.0f\n", maxDiff))
            if (psnr.isFinite()) append(String.format("PSNR　%.2f dB\n", psnr))
            append(String.format("耗时　%.2f s", ms / 1000.0))
        }
        binding.previewImage.setImageBitmap(bmp)
        binding.btnSave.setOnClickListener {
            saveImage(bmp, "bwm-stego-${System.currentTimeMillis()}.png")
        }
        binding.resBox.visibility = View.VISIBLE
        toast("嵌入完成，请以 PNG 保存")
    }

    /* ==================================================== 提取 */

    private fun runExtract() {
        val bmp = extractSlot.bitmap
        if (bmp == null) {
            toast(getString(R.string.stg_err_no_target))
            return
        }
        binding.resBox2.visibility = View.GONE
        val password = binding.stgxPassword.text.toString().toLongOrNull()?.takeIf { it >= 0 }
            ?: 20260919L

        runTask(binding.btnRunExtract, binding.progBar2, binding.progText2) { report ->
            val t0 = System.currentTimeMillis()
            val img = ImageCodec.toImg(bmp, Backdrop.WHITE)
            val n = img.pixelCount
            val planes = Array(3) { c -> DoubleArray(n) { i -> img.planes[c][i] } }

            val res = Stego.autoExtract(planes, img.w, img.h, password, Stego.DEFAULT_DELTA) {
                report(it)
            }
            report(1.0)
            val ms = System.currentTimeMillis() - t0
            activity?.runOnUiThread { showExtract(res, ms) }
        }
    }

    private fun showExtract(res: StegoResult?, ms: Long) {
        val ctx = requireContext()
        extracted = res

        if (res == null) {
            binding.verdictBox.background = roundRect(ContextCompat.getColor(ctx, R.color.danger_soft))
            val fg = ContextCompat.getColor(ctx, R.color.danger)
            binding.verdictTitle.setTextColor(fg)
            binding.verdictSub.setTextColor(fg)
            binding.verdictTitle.text = getString(R.string.stg_nothing_found)
            binding.verdictSub.text = getString(R.string.stg_nothing_found_sub)

            binding.statText2.text = buildString {
                append("尝试顺序　大容量模式 → 鲁棒模式\n")
                append("结果　两种引擎的头部校验都未通过\n")
                append(String.format("耗时　%.2f s\n\n", ms / 1000.0))
                append("排查建议：确认密码与嵌入时一致；确认图片没有被重新压缩、缩放或转存为 JPEG")
                append("（大容量模式对任何有损处理都非常敏感）。")
            }
            binding.extractTextWrap.visibility = View.GONE
            binding.extractFileWrap.visibility = View.GONE
            binding.resBox2.visibility = View.VISIBLE
            return
        }

        val isText = res.contentType == Stego.TYPE_TEXT
        val engine = if (res.method == Stego.METHOD_LSB) "大容量模式（LSB）" else "鲁棒模式（DWT-DCT-SVD）"
        val typeName = when (res.contentType) {
            Stego.TYPE_TEXT -> "文字"
            Stego.TYPE_IMAGE -> "图片"
            else -> "文件"
        }

        binding.verdictBox.background = roundRect(ContextCompat.getColor(ctx, R.color.ok_soft))
        val fg = ContextCompat.getColor(ctx, R.color.ok)
        binding.verdictTitle.setTextColor(fg)
        binding.verdictSub.setTextColor(fg)
        binding.verdictTitle.text = getString(R.string.stg_ok)
        binding.verdictSub.text = "来自$engine，共 ${fmtBytes(res.data.size.toLong())}"

        binding.statText2.text = buildString {
            append("引擎　$engine\n")
            append("内容类型　$typeName\n")
            append("数据长度　${res.data.size} 字节\n")
            append(String.format("耗时　%.2f s", ms / 1000.0))
        }

        if (isText) {
            binding.extractText.setText(Stego.utf8Decode(res.data))
            binding.extractTextWrap.visibility = View.VISIBLE
            binding.extractFileWrap.visibility = View.GONE
        } else {
            extractedName = "bwm-extracted-${System.currentTimeMillis()}." +
                if (res.contentType == Stego.TYPE_IMAGE) "png" else "bin"
            binding.extractTextWrap.visibility = View.GONE
            binding.extractFileWrap.visibility = View.VISIBLE
        }
        binding.resBox2.visibility = View.VISIBLE
    }

    private fun copyText() {
        val txt = binding.extractText.text.toString()
        if (txt.isEmpty()) return
        val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("盲水印工坊", txt))
        toast(getString(R.string.stg_copied))
    }

    private fun writeFile(uri: Uri, data: ByteArray) {
        viewLifecycleOwner.lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    requireContext().contentResolver.openOutputStream(uri)?.use { os ->
                        os.write(data)
                        os.flush()
                        true
                    } ?: false
                }.getOrDefault(false)
            }
            toast(getString(if (ok) R.string.saved_ok else R.string.err_save_failed))
        }
    }

    /* ==================================================== 杂项 */

    private fun fmtBytes(v: Long): String = when {
        v < 1024 -> "$v B"
        v < 1024L * 1024 -> String.format("%.1f KB", v / 1024.0)
        else -> String.format("%.2f MB", v / 1048576.0)
    }

    companion object {
        /** 上限：任何图都放不下这么大的负载，读之前先挡住，避免 OOM */
        private const val MAX_FILE_BYTES = 16L * 1024 * 1024
    }
}
