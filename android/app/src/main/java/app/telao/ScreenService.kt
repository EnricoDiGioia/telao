package app.telao

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat

/**
 * Serviço em primeiro plano que mantém a transmissão da tela funcionando
 * mesmo com o Telão fechado ou em segundo plano (é o que o navegador não consegue).
 */
class ScreenService : Service() {

    companion object {
        const val ACTION_START = "app.telao.START"
        const val ACTION_STOP = "app.telao.STOP"
        const val ACTION_QUALITY = "app.telao.QUALITY"

        const val EXTRA_DATA = "data"
        const val EXTRA_SERVER = "server"
        const val EXTRA_ROOM = "room"
        const val EXTRA_NAME = "name"
        const val EXTRA_IGNORE = "ignore"
        const val EXTRA_RES = "res"
        const val EXTRA_FPS = "fps"
        const val EXTRA_KBPS = "kbps"

        private const val CHANNEL = "transmissao"
        private const val NOTIF_ID = 42

        fun quality(res: String?, fps: String?, kbps: String?): ScreenStreamer.Quality {
            val shortSide = when (res) {
                "source" -> 0
                null, "" -> 720
                else -> res.toIntOrNull() ?: 720
            }
            val f = (fps?.toIntOrNull() ?: 30).coerceIn(5, 60)
            val k = (kbps?.toIntOrNull() ?: 3000).coerceIn(300, 20000)
            return ScreenStreamer.Quality(shortSide, f, k)
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var streamer: ScreenStreamer? = null
    private var room: String = ""
    private var viewers = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> start(intent)
            ACTION_STOP -> stopAll()
            ACTION_QUALITY -> streamer?.updateQuality(
                quality(intent.getStringExtra(EXTRA_RES), intent.getStringExtra(EXTRA_FPS), intent.getStringExtra(EXTRA_KBPS))
            )
            else -> if (streamer == null) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun start(intent: Intent) {
        room = intent.getStringExtra(EXTRA_ROOM) ?: "geral"
        viewers = 0
        createChannel()
        // Precisa estar em primeiro plano ANTES de pegar a captura de tela (regra do Android 14+)
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, n)
        }

        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(EXTRA_DATA)
        }
        val server = intent.getStringExtra(EXTRA_SERVER)
        if (data == null || server.isNullOrBlank()) {
            StreamState.set(StreamState.State(error = "Faltou a permissão de captura de tela."))
            stopAll()
            return
        }

        streamer?.stop()
        val s = ScreenStreamer(
            context = applicationContext,
            permissionData = data,
            server = server,
            room = room,
            name = intent.getStringExtra(EXTRA_NAME) ?: "Celular (tela)",
            ignoreId = intent.getStringExtra(EXTRA_IGNORE)?.ifBlank { null },
            quality = quality(intent.getStringExtra(EXTRA_RES), intent.getStringExtra(EXTRA_FPS), intent.getStringExtra(EXTRA_KBPS)),
            onEvent = { ev -> main.post { onStreamerEvent(ev) } },
        )
        streamer = s
        StreamState.set(StreamState.State(live = true))
        s.start()
    }

    private fun onStreamerEvent(ev: ScreenStreamer.Event) {
        when (ev) {
            is ScreenStreamer.Event.Joined -> StreamState.update { it.copy(peerId = ev.peerId, error = null) }
            is ScreenStreamer.Event.Viewers -> {
                viewers = ev.count
                StreamState.update { it.copy(viewers = ev.count) }
                if (streamer != null) {
                    getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification())
                }
            }
            is ScreenStreamer.Event.Error -> {
                StreamState.set(StreamState.State(error = ev.message))
                stopAll(keepError = true)
            }
            ScreenStreamer.Event.ProjectionStopped -> stopAll()
        }
    }

    private fun stopAll(keepError: Boolean = false) {
        streamer?.stop()
        streamer = null
        if (!keepError) StreamState.set(StreamState.State())
        else StreamState.update { it.copy(live = false, peerId = null, viewers = 0) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        streamer?.onRotation()
    }

    override fun onDestroy() {
        streamer?.stop()
        streamer = null
        if (StreamState.state.live) StreamState.set(StreamState.State())
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL, "Transmissão da tela", NotificationManager.IMPORTANCE_LOW)
            ch.description = "Aviso enquanto a tela do celular está sendo transmitida"
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    private fun buildNotification(): Notification {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            flags,
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, ScreenService::class.java).setAction(ACTION_STOP),
            flags,
        )
        val text = when (viewers) {
            0 -> "Sala $room · esperando alguém assistir"
            1 -> "Sala $room · 1 pessoa assistindo"
            else -> "Sala $room · $viewers pessoas assistindo"
        }
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_telao)
            .setContentTitle("Transmitindo a tela")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, "Parar", stop)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }
}
