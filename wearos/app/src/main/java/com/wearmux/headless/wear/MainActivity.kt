package com.wearmux.headless.wear

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.core.content.ContextCompat
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {

    private val address = MutableStateFlow("")

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyExtras(intent)
        requestPermissions()
        setContent {
            MaterialTheme {
                val state by HeadlessLinkService.state.collectAsState()
                val bpm by HeadlessLinkService.heartRate.collectAsState()
                val target by address.collectAsState()
                LinkScreen(
                    target = target,
                    state = state,
                    bpm = bpm,
                    onConnect = { startLink() },
                    onDisconnect = { stopLink() },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        applyExtras(intent)
    }

    // adb shell am start -n com.wearmux.headless.wear/.MainActivity --es host <ip> --ei port <port>
    private fun applyExtras(intent: Intent?) {
        val host = intent?.getStringExtra("host")
        val port = intent?.takeIf { it.hasExtra("port") }?.getIntExtra("port", 0)
        LinkSettings.save(this, host, port)
        address.value = "${LinkSettings.host(this)}:${LinkSettings.port(this)}"
        if ((host != null || port != null) && HeadlessLinkService.state.value != HeadlessLinkService.LinkState.IDLE) {
            startLink()
        }
    }

    private fun requestPermissions() {
        val wanted = mutableListOf(HeadlessLinkService.heartRatePermission())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) wanted += Manifest.permission.POST_NOTIFICATIONS
        val missing = wanted.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) permissionLauncher.launch(missing.toTypedArray())
    }

    private fun startLink() {
        startForegroundService(Intent(this, HeadlessLinkService::class.java).setAction(HeadlessLinkService.ACTION_START))
    }

    private fun stopLink() {
        startService(Intent(this, HeadlessLinkService::class.java).setAction(HeadlessLinkService.ACTION_STOP))
    }
}

@Composable
private fun LinkScreen(
    target: String,
    state: HeadlessLinkService.LinkState,
    bpm: Int,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
) {
    val idle = state == HeadlessLinkService.LinkState.IDLE
    val status = when (state) {
        HeadlessLinkService.LinkState.IDLE -> "Disconnected"
        HeadlessLinkService.LinkState.WAITING_FOR_WIFI -> "Waiting for Wi-Fi"
        HeadlessLinkService.LinkState.CONNECTING -> "Connecting"
        HeadlessLinkService.LinkState.CONNECTED -> "Connected"
    }
    ScalingLazyColumn(modifier = Modifier.fillMaxWidth()) {
        item { Text("WearMux", style = MaterialTheme.typography.title3) }
        item { Text(target, style = MaterialTheme.typography.caption2, textAlign = TextAlign.Center) }
        item { Text(status, style = MaterialTheme.typography.body1) }
        if (bpm > 0) item { Text("$bpm BPM", style = MaterialTheme.typography.body2) }
        item {
            Chip(
                modifier = Modifier.fillMaxWidth(),
                onClick = if (idle) onConnect else onDisconnect,
                label = { Text(if (idle) "Connect" else "Disconnect") },
                colors = if (idle) ChipDefaults.primaryChipColors() else ChipDefaults.secondaryChipColors(),
            )
        }
    }
}
