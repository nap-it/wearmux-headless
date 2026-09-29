package com.wearmux.headless.wear

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

// Streams watch sensors to wearmux-headless over Wi-Fi and runs the actions it sends back.
class HeadlessLinkService : Service(), SensorEventListener {

    enum class LinkState { IDLE, WAITING_FOR_WIFI, CONNECTING, CONNECTED }

    companion object {
        const val ACTION_START = "com.wearmux.headless.wear.START"
        const val ACTION_STOP = "com.wearmux.headless.wear.STOP"
        private const val TAG = "HeadlessLink"
        private const val CHANNEL_ID = "headless_link"
        private const val NOTIFICATION_ID = 1
        private const val MAX_QUEUED_BYTES = 256 * 1024L
        private const val MAX_RETRY_MS = 10_000L
        private const val HEART_RATE = "heartRate"

        // Protocol sensor names, matching the SDK types used by wearmux-headless.
        private val SENSOR_TYPES = linkedMapOf(
            "acceleration" to Sensor.TYPE_ACCELEROMETER,
            "gyroscope" to Sensor.TYPE_GYROSCOPE,
            "magnetometer" to Sensor.TYPE_MAGNETIC_FIELD,
            HEART_RATE to Sensor.TYPE_HEART_RATE,
        )

        private val _state = MutableStateFlow(LinkState.IDLE)
        val state: StateFlow<LinkState> = _state.asStateFlow()
        private val _heartRate = MutableStateFlow(0)
        val heartRate: StateFlow<Int> = _heartRate.asStateFlow()

        fun heartRatePermission(): String =
            if (Build.VERSION.SDK_INT >= 36) "android.permission.health.READ_HEART_RATE"
            else Manifest.permission.BODY_SENSORS
    }

    private val handler = Handler(Looper.getMainLooper())
    private val sensorThread = HandlerThread("headless-sensors").apply { start() }
    private val sensorHandler = Handler(sensorThread.looper)
    private lateinit var sensorManager: SensorManager
    private lateinit var connectivity: ConnectivityManager
    private var wakeLock: PowerManager.WakeLock? = null
    private var running = false
    private var network: Network? = null
    @Volatile private var socket: WebSocket? = null
    private var retryMs = 1_000L
    private val activeIntervals = mutableMapOf<String, Int>()

    // Wear OS routes traffic over Bluetooth through the phone by default; ask for Wi-Fi explicitly.
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(available: Network) {
            handler.post {
                if (!running || network == available) return@post
                network = available
                retryMs = 1_000L
                connect()
            }
        }

        override fun onLost(lost: Network) {
            handler.post {
                if (network != lost) return@post
                network = null
                closeSocket()
                if (running) _state.value = LinkState.WAITING_FOR_WIFI
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        sensorManager = getSystemService(SensorManager::class.java)
        connectivity = getSystemService(ConnectivityManager::class.java)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopLink()
            stopSelf()
            return START_NOT_STICKY
        }
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, buildNotification(),
            if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH else 0,
        )
        if (running) {
            // Reconnect so a changed host or port takes effect.
            closeSocket()
            connect()
            return START_STICKY
        }
        running = true
        _state.value = LinkState.WAITING_FOR_WIFI
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "wearmux:headless-link")
            .apply { acquire() }
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        connectivity.requestNetwork(request, networkCallback)
        return START_STICKY
    }

    override fun onDestroy() {
        stopLink()
        sensorThread.quitSafely()
        super.onDestroy()
    }

    private fun connect() {
        val target = network ?: return
        if (!running || socket != null) return
        _state.value = LinkState.CONNECTING
        val url = "ws://${LinkSettings.host(this)}:${LinkSettings.port(this)}"
        val client = OkHttpClient.Builder()
            .socketFactory(target.socketFactory)
            .connectTimeout(5, TimeUnit.SECONDS)
            .build()
        Log.i(TAG, "connecting to $url")
        socket = client.newWebSocket(Request.Builder().url(url).build(), SocketListener())
    }

    private inner class SocketListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send(hello().toString())
            handler.post {
                if (socket !== webSocket) return@post
                retryMs = 1_000L
                _state.value = LinkState.CONNECTED
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            handleCommand(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "link failed: ${t.message}")
            dropped(webSocket)
        }
    }

    private fun dropped(webSocket: WebSocket) {
        handler.post {
            if (socket !== webSocket) return@post
            socket = null
            applyConfiguration(emptyMap())
            scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        if (!running) return
        _state.value = if (network == null) LinkState.WAITING_FOR_WIFI else LinkState.CONNECTING
        handler.postDelayed({ connect() }, retryMs)
        retryMs = (retryMs * 2).coerceAtMost(MAX_RETRY_MS)
    }

    private fun closeSocket() {
        val current = socket ?: return
        socket = null
        current.close(1000, null)
        applyConfiguration(emptyMap())
    }

    private fun stopLink() {
        if (!running) return
        running = false
        handler.removeCallbacksAndMessages(null)
        closeSocket()
        try { connectivity.unregisterNetworkCallback(networkCallback) } catch (_: IllegalArgumentException) {}
        network = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        _state.value = LinkState.IDLE
        _heartRate.value = 0
    }

    private fun hello(): JSONObject {
        val androidId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"
        val name = Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME) ?: Build.MODEL
        return JSONObject()
            .put("type", "hello")
            .put("id", "wearos-$androidId")
            .put("name", name)
            .put("sensors", JSONArray(availableSensors()))
            .put("vibration", WatchVibrations.isAvailable(this))
    }

    private fun availableSensors(): List<String> = SENSOR_TYPES.filter { (name, type) ->
        sensorManager.getDefaultSensor(type) != null &&
            (name != HEART_RATE || ContextCompat.checkSelfPermission(this, heartRatePermission()) == PackageManager.PERMISSION_GRANTED)
    }.keys.toList()

    private fun handleCommand(text: String) {
        val packet = try { JSONObject(text) } catch (_: Exception) { return }
        when (packet.optString("type")) {
            "config" -> {
                val sensors = packet.optJSONObject("sensors") ?: JSONObject()
                val intervals = sensors.keys().asSequence().associateWith { sensors.optInt(it, 0) }
                handler.post { if (socket != null) applyConfiguration(intervals) }
            }
            "vibrate" -> WatchVibrations.play(this, packet.optString("effect", "strongClick100"))
        }
    }

    // Intervals are in milliseconds, as the SDK sends them; zero or missing turns a sensor off.
    private fun applyConfiguration(intervals: Map<String, Int>) {
        val available = availableSensors()
        for ((name, type) in SENSOR_TYPES) {
            val interval = intervals[name]?.takeIf { it > 0 && name in available }
            if (activeIntervals[name] == interval) continue
            val sensor = sensorManager.getDefaultSensor(type) ?: continue
            sensorManager.unregisterListener(this, sensor)
            activeIntervals.remove(name)
            if (interval == null) continue
            val periodUs = if (name == HEART_RATE) SensorManager.SENSOR_DELAY_NORMAL else interval * 1000
            if (sensorManager.registerListener(this, sensor, periodUs, sensorHandler)) activeIntervals[name] = interval
        }
        if (HEART_RATE !in activeIntervals) _heartRate.value = 0
    }

    override fun onSensorChanged(event: SensorEvent) {
        val name = SENSOR_TYPES.entries.firstOrNull { it.value == event.sensor.type }?.key ?: return
        val link = socket ?: return
        // Convert the event's boot-time clock to wall-clock milliseconds, as the host expects.
        val timestamp = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - event.timestamp) / 1_000_000
        val packet = JSONObject().put("type", "sensor").put("sensor", name).put("timestamp", timestamp)
        if (name == HEART_RATE) {
            val bpm = event.values[0].roundToInt()
            if (bpm !in 30..220) return
            _heartRate.value = bpm
            packet.put("bpm", bpm)
        } else {
            // Skip samples while the link is congested instead of queueing stale motion.
            if (link.queueSize() > MAX_QUEUED_BYTES) return
            packet.put("x", event.values[0].toDouble()).put("y", event.values[1].toDouble()).put("z", event.values[2].toDouble())
        }
        link.send(packet.toString())
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit

    private fun buildNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.app_name), NotificationManager.IMPORTANCE_LOW),
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(getString(R.string.app_name))
            .setContentText("${LinkSettings.host(this)}:${LinkSettings.port(this)}")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }
}
