package com.dragonxash.bwm.ui

import android.graphics.Bitmap
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import com.dragonxash.bwm.core.Backdrop
import com.dragonxash.bwm.core.ImageCodec
import com.dragonxash.bwm.core.Img

/**
 * 图片槽位：点击选图，长按清除，显示缩略图与尺寸信息。
 */
class SlotView(
    private val hint: TextView,
    private val preview: ImageView,
    private val meta: TextView,
    private val backdropProvider: () -> Backdrop,
    private val sizeNote: (Int, Int) -> String,
) {
    var bitmap: Bitmap? = null
        private set

    val isFilled: Boolean get() = bitmap != null

    fun attach(root: View, onPick: () -> Unit) {
        root.setOnClickListener { onPick() }
        root.setOnLongClickListener {
            if (isFilled) clear()
            true
        }
    }

    fun set(bmp: Bitmap) {
        bitmap = bmp
        hint.visibility = View.GONE
        preview.visibility = View.VISIBLE
        preview.setImageBitmap(bmp)
        val note = sizeNote(bmp.width, bmp.height)
        meta.text = if (note.isEmpty()) {
            "${bmp.width} × ${bmp.height} px"
        } else {
            "${bmp.width} × ${bmp.height} px　$note"
        }
    }

    fun clear() {
        bitmap = null
        hint.visibility = View.VISIBLE
        preview.visibility = View.GONE
        preview.setImageDrawable(null)
        meta.text = ""
    }

    /** 转成算法使用的 BGR 平面数据；透明区域按当前设置合成 */
    fun toImg(): Img? = bitmap?.let { ImageCodec.toImg(it, backdropProvider()) }
}
