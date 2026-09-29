package com.wearmux.headless.wear

import android.content.Context
import androidx.core.content.edit

// Headless address, persisted so an adb override survives app restarts.
object LinkSettings {
    private const val PREFS = "link"
    private const val KEY_HOST = "host"
    private const val KEY_PORT = "port"

    fun host(context: Context): String =
        prefs(context).getString(KEY_HOST, null) ?: BuildConfig.HEADLESS_HOST

    fun port(context: Context): Int =
        prefs(context).getInt(KEY_PORT, BuildConfig.HEADLESS_PORT)

    fun save(context: Context, host: String?, port: Int?) {
        prefs(context).edit {
            if (!host.isNullOrBlank()) putString(KEY_HOST, host.trim())
            if (port != null && port in 1..65535) putInt(KEY_PORT, port)
        }
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
