package com.dragonxash.bwm

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.viewpager2.adapter.FragmentStateAdapter
import com.dragonxash.bwm.databinding.ActivityMainBinding
import com.dragonxash.bwm.ui.DecodeFragment
import com.dragonxash.bwm.ui.DetectFragment
import com.dragonxash.bwm.ui.EncodeFragment
import com.dragonxash.bwm.ui.StegoFragment
import com.google.android.material.tabs.TabLayoutMediator

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.pager.adapter = object : FragmentStateAdapter(this) {
            override fun getItemCount() = 4
            override fun createFragment(position: Int): Fragment = when (position) {
                0 -> EncodeFragment()
                1 -> DecodeFragment()
                2 -> DetectFragment()
                else -> StegoFragment()
            }
        }
        // 相邻面板预加载，切换时参数状态不丢
        binding.pager.offscreenPageLimit = 2

        TabLayoutMediator(binding.tabs, binding.pager) { tab, pos ->
            tab.text = getString(
                when (pos) {
                    0 -> R.string.tab_encode
                    1 -> R.string.tab_decode
                    2 -> R.string.tab_detect
                    else -> R.string.tab_stego
                }
            )
        }.attach()
    }
}
