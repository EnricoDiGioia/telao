package app.telao

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Mostra o site do Telão por dentro e acrescenta o que o navegador do Android não deixa:
 * transmitir a tela do celular (também em segundo plano).
 */
class MainActivity : Activity() {

    companion object {
        private const val REQ_PROJECTION = 10
        private const val REQ_CAMERA = 11
        private const val REQ_NOTIF = 12
        private const val PREFS = "telao"
        private const val KEY_SERVER = "server"
    }

    private lateinit var root: FrameLayout
    private var web: WebView? = null
    private var serverOrigin: String? = null

    private var pendingScreen: Bundle? = null
    private var pendingPermission: PermissionRequest? = null
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

    // ---------------------------------------------------------------
    // Ciclo de vida
    // ---------------------------------------------------------------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#0E1013")) }
        setContentView(root)
        WebView.setWebContentsDebuggingEnabled(true)

        val fromLink = linkFrom(intent)
        if (fromLink != null) {
            openUrl(fromLink)
        } else {
            val saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, null)
            val server = saved ?: BuildConfig.DEFAULT_SERVER.ifBlank { null }
            if (server != null) openUrl(server) else showSetup(null)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        linkFrom(intent)?.let { openUrl(it) }
    }

    override fun onResume() {
        super.onResume()
        StreamState.listener = { pushState(it) }
        pushState(StreamState.state)
    }

    override fun onPause() {
        StreamState.listener = null
        super.onPause()
    }

    override fun onDestroy() {
        // A página com a voz vai embora junto: solta o microfone
        runCatching { startService(Intent(this, VoiceService::class.java).setAction(VoiceService.ACTION_OFF)) }
        web?.destroy()
        web = null
        super.onDestroy()
    }

    @Deprecated("Ainda é o jeito mais simples de tratar o voltar sem bibliotecas extras")
    override fun onBackPressed() {
        when {
            fullscreenView != null -> exitFullscreen()
            web?.canGoBack() == true -> web?.goBack()
            // Não fecha: vai para segundo plano e mantém a sala aberta
            web != null -> moveTaskToBack(true)
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    private fun linkFrom(i: Intent?): String? {
        val data = i?.data ?: return null
        if (i.action != Intent.ACTION_VIEW) return null
        if (data.scheme != "https" && data.scheme != "http") return null
        return data.toString()
    }

    // ---------------------------------------------------------------
    // Tela de configuração (só quando o endereço não está embutido no app)
    // ---------------------------------------------------------------

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun showSetup(error: String?) {
        web?.let { root.removeView(it); it.destroy() }
        web = null
        root.removeAllViews()

        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(24), dp(24), dp(24))
            gravity = Gravity.CENTER_VERTICAL
        }
        val title = TextView(this).apply {
            text = "Telão"
            setTextColor(Color.parseColor("#2EE6A6"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 32f)
            typeface = Typeface.DEFAULT_BOLD
        }
        val sub = TextView(this).apply {
            text = "Cole o link do Telão (o convite que mandam no Discord ou o endereço do site)."
            setTextColor(Color.parseColor("#B8BFCC"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setPadding(0, dp(8), 0, dp(16))
        }
        val input = EditText(this).apply {
            hint = "https://telao.seunome.workers.dev"
            setHintTextColor(Color.parseColor("#5F6775"))
            setTextColor(Color.WHITE)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setSingleLine()
            setText(getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, "") ?: "")
        }
        val err = TextView(this).apply {
            text = error ?: ""
            visibility = if (error == null) View.GONE else View.VISIBLE
            setTextColor(Color.parseColor("#FF5C6C"))
            setPadding(0, dp(8), 0, 0)
        }
        val go = Button(this).apply { text = "Entrar" }

        val submit = {
            var url = input.text.toString().trim()
            if (url.isNotEmpty() && !url.startsWith("http")) url = "https://$url"
            val uri = Uri.parse(url)
            if (url.isEmpty() || uri.host.isNullOrBlank()) {
                err.text = "Esse link não parece certo. Ele começa com https://"
                err.visibility = View.VISIBLE
            } else {
                openUrl(url)
            }
        }
        go.setOnClickListener { submit() }
        input.setOnEditorActionListener { _, _, _ -> submit(); true }

        box.addView(title)
        box.addView(sub)
        box.addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        box.addView(err)
        box.addView(go, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })
        root.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    // ---------------------------------------------------------------
    // O site por dentro
    // ---------------------------------------------------------------

    private fun originOf(url: String): String? {
        val u = Uri.parse(url)
        val host = u.host ?: return null
        val port = if (u.port > 0) ":${u.port}" else ""
        return "${u.scheme ?: "https"}://$host$port"
    }

    private fun openUrl(url: String) {
        val origin = originOf(url) ?: return showSetup("Esse link não parece certo.")
        serverOrigin = origin
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, origin).apply()

        val w = web ?: createWebView().also {
            root.removeAllViews()
            root.addView(it, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            web = it
        }
        w.loadUrl(url)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        val w = WebView(this)
        w.setBackgroundColor(Color.parseColor("#0E1013"))
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString TelaoApp/${BuildConfig.VERSION_NAME}"
        }
        w.addJavascriptInterface(Bridge(), "TelaoAndroid")

        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = originOf(request.url.toString())
                if (target == serverOrigin) return false
                // Links de fora abrem no navegador normal
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                pushState(StreamState.state)
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    showSetup("Não deu para abrir o Telão (${error.description}). Confira o link e a internet.")
                }
            }
        }

        w.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handleWebPermission(request) }
            }

            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                enterFullscreen(view, callback)
            }

            override fun onHideCustomView() {
                exitFullscreen()
            }
        }
        return w
    }

    /** Recurso do site -> permissão do Android que ele precisa. */
    private val webToAndroid = mapOf(
        PermissionRequest.RESOURCE_VIDEO_CAPTURE to Manifest.permission.CAMERA,
        PermissionRequest.RESOURCE_AUDIO_CAPTURE to Manifest.permission.RECORD_AUDIO,
    )

    private fun hasPermission(p: String) =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    /** O site pediu câmera e/ou microfone: pede a permissão do Android e libera para o site. */
    private fun handleWebPermission(request: PermissionRequest) {
        val wanted = request.resources.filter { it in webToAndroid }
        if (wanted.isEmpty()) {
            request.deny()
            return
        }
        val missing = wanted.mapNotNull { webToAndroid[it] }.filterNot { hasPermission(it) }
        if (missing.isEmpty()) {
            request.grant(wanted.toTypedArray())
        } else {
            pendingPermission?.deny()
            pendingPermission = request
            requestPermissions(missing.toTypedArray(), REQ_CAMERA)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQ_CAMERA -> {
                val req = pendingPermission ?: return
                pendingPermission = null
                // Libera para o site só o que o Android deixou
                val allowed = req.resources.filter { res -> webToAndroid[res]?.let { hasPermission(it) } == true }
                if (allowed.isNotEmpty()) req.grant(allowed.toTypedArray()) else req.deny()
            }
            REQ_NOTIF -> askScreenCapture()
        }
    }

    private fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        exitFullscreen()
        fullscreenView = view
        fullscreenCallback = callback
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)
    }

    private fun exitFullscreen() {
        val v = fullscreenView ?: return
        root.removeView(v)
        fullscreenView = null
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
    }

    // ---------------------------------------------------------------
    // Transmissão da tela
    // ---------------------------------------------------------------

    private fun requestScreen(args: Bundle) {
        if (StreamState.state.live) {
            pushState(StreamState.state)
            return
        }
        pendingScreen = args
        // Android 13+: pede para mostrar a notificação (é por ela que dá para parar a transmissão)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
        } else {
            askScreenCapture()
        }
    }

    private fun askScreenCapture() {
        if (pendingScreen == null) return
        val mpm = getSystemService(MediaProjectionManager::class.java)
        @Suppress("DEPRECATION")
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_PROJECTION)
    }

    @Deprecated("startActivityForResult continua funcionando e evita bibliotecas extras")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PROJECTION) return
        val args = pendingScreen
        pendingScreen = null
        if (resultCode != RESULT_OK || data == null || args == null) {
            pushState(StreamState.state) // cancelou: o botão do site volta ao normal
            return
        }
        val i = Intent(this, ScreenService::class.java)
            .setAction(ScreenService.ACTION_START)
            .putExtras(args)
            .putExtra(ScreenService.EXTRA_DATA, data)
            .putExtra(ScreenService.EXTRA_SERVER, serverOrigin)
        ContextCompat.startForegroundService(this, i)
        // Mantém a tela acesa enquanto o app está aberto transmitindo
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    /** Conta para o site como está a transmissão da tela. */
    private fun pushState(s: StreamState.State) {
        val w = web ?: return
        if (!s.live) window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        w.evaluateJavascript("window.telaoNativeState && window.telaoNativeState(${s.toJson()})", null)
        if (s.error != null) StreamState.update { it.copy(error = null) } // mostra o erro uma vez só
    }

    // ---------------------------------------------------------------
    // Ponte com o site (window.TelaoAndroid)
    // ---------------------------------------------------------------

    inner class Bridge {
        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun isLive(): Boolean = StreamState.state.live

        @JavascriptInterface
        fun startScreen(room: String, name: String, selfId: String, res: String, fps: String, kbps: String) {
            val args = Bundle().apply {
                putString(ScreenService.EXTRA_ROOM, room)
                putString(ScreenService.EXTRA_NAME, name)
                putString(ScreenService.EXTRA_IGNORE, selfId)
                putString(ScreenService.EXTRA_RES, res)
                putString(ScreenService.EXTRA_FPS, fps)
                putString(ScreenService.EXTRA_KBPS, kbps)
            }
            runOnUiThread { requestScreen(args) }
        }

        @JavascriptInterface
        fun stopScreen() {
            runOnUiThread {
                startService(Intent(this@MainActivity, ScreenService::class.java).setAction(ScreenService.ACTION_STOP))
            }
        }

        @JavascriptInterface
        fun updateQuality(res: String, fps: String, kbps: String) {
            if (!StreamState.state.live) return
            runOnUiThread {
                startService(
                    Intent(this@MainActivity, ScreenService::class.java)
                        .setAction(ScreenService.ACTION_QUALITY)
                        .putExtra(ScreenService.EXTRA_RES, res)
                        .putExtra(ScreenService.EXTRA_FPS, fps)
                        .putExtra(ScreenService.EXTRA_KBPS, kbps)
                )
            }
        }

        /** O site entrou/saiu da voz: mantém (ou solta) o microfone em segundo plano. */
        @JavascriptInterface
        fun voiceState(on: Boolean) {
            runOnUiThread {
                val i = Intent(this@MainActivity, VoiceService::class.java)
                    .setAction(if (on) VoiceService.ACTION_ON else VoiceService.ACTION_OFF)
                if (on) {
                    if (!hasPermission(Manifest.permission.RECORD_AUDIO)) return@runOnUiThread
                    runCatching { ContextCompat.startForegroundService(this@MainActivity, i) }
                } else {
                    runCatching { startService(i) }
                }
            }
        }

        /** Abre o menu de compartilhar do Android (para mandar o convite direto no Discord). */
        @JavascriptInterface
        fun share(text: String) {
            runOnUiThread {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
                runCatching { startActivity(Intent.createChooser(send, "Mandar convite")) }
                    .onFailure { Toast.makeText(this@MainActivity, text, Toast.LENGTH_LONG).show() }
            }
        }

        /** Trocar o endereço do Telão (por exemplo, se o site mudou de lugar). */
        @JavascriptInterface
        fun changeServer() {
            runOnUiThread { showSetup(null) }
        }

        @JavascriptInterface
        fun info(): String = JSONObject().put("version", BuildConfig.VERSION_NAME).put("server", serverOrigin ?: "").toString()
    }
}
