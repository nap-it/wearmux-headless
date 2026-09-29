package com.wearmux.headless.wear

import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log

// Maps SDK waveform effect names (strongClick100, doubleClick100, alert750ms, ...) to watch patterns.
object WatchVibrations {
    private const val TAG = "WatchVibrations"

    fun play(context: Context, effect: String) {
        val vibrator = vibrator(context) ?: return
        try {
            // Plain vibrate() is tagged as touch feedback, which Samsung scales by the (often muted) touch intensity.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                vibrator.vibrate(effectFor(effect.lowercase()), VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(
                    effectFor(effect.lowercase()),
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build(),
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "vibrate failed: ${e.message}")
        }
    }

    fun isAvailable(context: Context): Boolean = vibrator(context)?.hasVibrator() == true

    private fun effectFor(name: String): VibrationEffect {
        val amp = VibrationEffect.DEFAULT_AMPLITUDE
        return when {
            "triple" in name -> VibrationEffect.createWaveform(
                longArrayOf(0, 60, 70, 60, 70, 60), intArrayOf(0, amp, 0, amp, 0, amp), -1,
            )
            "double" in name -> VibrationEffect.createWaveform(
                longArrayOf(0, 80, 80, 80), intArrayOf(0, amp, 0, amp), -1,
            )
            "alert" in name || "buzz" in name || "long" in name -> VibrationEffect.createOneShot(450, amp)
            else -> VibrationEffect.createOneShot(120, amp)
        }
    }

    private fun vibrator(context: Context): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
}
