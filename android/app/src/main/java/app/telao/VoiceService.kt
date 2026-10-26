package app.telao

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Mantém o microfone funcionando com o Telão em segundo plano.
 * Sem isso, o Android corta o microfone de apps que não estão na tela (desde o Android 9).
 * Não grava nada por conta própria: só avisa o sistema que o app está numa chamada de voz.
 */
class VoiceService : Service() {

    companion object {
        const val ACTION_ON = "app.telao.VOICE_ON"
        const val ACTION_OFF = "app.telao.VOICE_OFF"
        private const val CHANNEL = "voz"
        private const val NOTIF_ID = 43
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_ON -> goForeground()
            else -> stopNow()
        }
        return START_NOT_STICKY
    }

    private fun goForeground() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL, "Voz", NotificationManager.IMPORTANCE_LOW)
            ch.description = "Aviso enquanto você está na voz do Telão"
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
        val n = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTIF_ID, n)
            }
        } catch (e: Exception) {
            // Sem permissão de microfone (ou app fora da tela): não dá para manter em segundo plano
            stopSelf()
        }
    }

    private fun stopNow() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 2,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_telao)
            .setContentTitle("Na voz do Telão")
            .setContentText("Toque para voltar à sala")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }
}
