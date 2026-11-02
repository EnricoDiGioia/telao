package app.telao

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.view.Surface
import org.webrtc.CapturerObserver
import org.webrtc.SurfaceTextureHelper
import org.webrtc.ThreadUtils
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink

/**
 * Captura a tela do celular para o WebRTC.
 *
 * Substitui o ScreenCapturerAndroid da biblioteca, que a cada mudança de tamanho
 * (girar o celular, abrir um app em paisagem, mudar a qualidade) apagava a captura e
 * criava outra. A partir do Android 14 isso é proibido: a segunda criação dá erro e a
 * transmissão para. Aqui a captura (VirtualDisplay) é criada UMA vez e depois só
 * redimensionada.
 */
class TelaoScreenCapturer(
    private val permissionData: Intent,
    private val projectionCallback: MediaProjection.Callback,
) : VideoCapturer, VideoSink {

    companion object {
        private const val DPI = 400
    }

    private var helper: SurfaceTextureHelper? = null
    private var observer: CapturerObserver? = null
    private var appContext: Context? = null
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var surface: Surface? = null
    private var width = 0
    private var height = 0
    private var disposed = false

    override fun initialize(helper: SurfaceTextureHelper, context: Context, observer: CapturerObserver) {
        check(!disposed) { "capturador já descartado" }
        this.helper = helper
        this.observer = observer
        this.appContext = context.applicationContext
    }

    @Synchronized
    override fun startCapture(width: Int, height: Int, framerate: Int) {
        check(!disposed) { "capturador já descartado" }
        val h = checkNotNull(helper) { "capturador não inicializado" }
        val ctx = checkNotNull(appContext)
        this.width = width
        this.height = height

        val mpm = ctx.getSystemService(MediaProjectionManager::class.java)
        val p = mpm.getMediaProjection(Activity.RESULT_OK, permissionData)
            ?: throw IllegalStateException("O Android não liberou a captura de tela")
        projection = p
        // Android 14+: o aviso de "parou" precisa estar registrado antes de criar a captura
        p.registerCallback(projectionCallback, h.handler)

        h.setTextureSize(width, height)
        val s = Surface(h.surfaceTexture)
        surface = s
        display = p.createVirtualDisplay(
            "Telao", width, height, DPI,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION,
            s, null, null,
        )
        observer?.onCapturerStarted(true)
        h.startListening(this)
    }

    /** Muda o tamanho da captura SEM criar outra (só redimensiona a que já existe). */
    @Synchronized
    override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) {
        check(!disposed) { "capturador já descartado" }
        this.width = width
        this.height = height
        val h = helper ?: return
        if (display == null) return // ainda não começou: o tamanho vale no startCapture
        ThreadUtils.invokeAtFrontUninterruptibly(h.handler, Runnable {
            val d = display ?: return@Runnable
            h.setTextureSize(width, height)
            d.resize(width, height, DPI)
            val old = surface
            val s = Surface(h.surfaceTexture)
            d.surface = s
            surface = s
            old?.release()
        })
    }

    @Synchronized
    override fun stopCapture() {
        val h = helper ?: return
        ThreadUtils.invokeAtFrontUninterruptibly(h.handler, Runnable {
            h.stopListening()
            observer?.onCapturerStopped()
            display?.release()
            display = null
            surface?.release()
            surface = null
            projection?.let { p ->
                runCatching { p.unregisterCallback(projectionCallback) }
                runCatching { p.stop() }
            }
            projection = null
        })
    }

    override fun dispose() {
        disposed = true
    }

    override fun isScreencast(): Boolean = true

    override fun onFrame(frame: VideoFrame) {
        observer?.onFrameCaptured(frame)
    }
}
