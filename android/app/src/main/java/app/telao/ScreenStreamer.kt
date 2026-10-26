package app.telao

import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.media.projection.MediaProjection
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Entra numa sala do Telão como mais um participante e transmite a tela do celular.
 * Fala o mesmo protocolo do site (WebSocket em /ws + WebRTC), então o site enxerga
 * esta transmissão como uma "Tela" comum.
 */
class ScreenStreamer(
    private val context: Context,
    private val permissionData: Intent,
    server: String,
    private val room: String,
    private val name: String,
    /** O id do site aberto neste mesmo celular: não transmitimos para ele mesmo. */
    private val ignoreId: String?,
    private var quality: Quality,
    private val onEvent: (Event) -> Unit,
) {
    data class Quality(val shortSide: Int, val fps: Int, val kbps: Int)

    sealed class Event {
        data class Joined(val peerId: String) : Event()
        data class Viewers(val count: Int) : Event()
        data class Error(val message: String) : Event()
        object ProjectionStopped : Event()
    }

    private class Peer(val id: String, val polite: Boolean) {
        var pc: PeerConnection? = null
        var sender: RtpSender? = null
        var makingOffer = false
        var ignoreOffer = false
        var connected = false
        val pendingCandidates = mutableListOf<IceCandidate>()
    }

    private val tag = "TelaoStreamer"
    private val wsUrl: String = run {
        val base = server.trimEnd('/')
        val wsBase = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            else -> "wss://$base"
        }
        "$wsBase/ws?sala=" + URLEncoder.encode(room, "UTF-8")
    }

    // Tudo roda nesta única thread, na ordem em que acontece
    private val exec = Executors.newSingleThreadScheduledExecutor()
    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var eglBase: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var helper: SurfaceTextureHelper? = null
    private var source: VideoSource? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var track: VideoTrack? = null
    private val streamId = UUID.randomUUID().toString()

    private var ws: WebSocket? = null
    private var myId: String? = null
    private var iceServers: List<PeerConnection.IceServer> =
        listOf(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer())
    private val peers = HashMap<String, Peer>()
    private var stopped = false
    private var lastViewers = -1

    // ---------------------------------------------------------------
    // Início e fim
    // ---------------------------------------------------------------

    fun start() = exec.execute {
        try {
            initWebRtc()
            startCapture()
            connect()
        } catch (e: Throwable) {
            Log.e(tag, "Falha ao iniciar", e)
            onEvent(Event.Error("Não deu para começar a transmitir a tela: ${e.message ?: e.javaClass.simpleName}"))
        }
    }

    fun stop() {
        if (exec.isShutdown) return
        exec.execute {
            if (stopped) return@execute
            stopped = true
            runCatching { ws?.close(1000, "tchau") }
            ws = null
            peers.values.forEach { p -> runCatching { p.pc?.dispose() } }
            peers.clear()
            runCatching { capturer?.stopCapture() }
            runCatching { capturer?.dispose() }
            runCatching { track?.dispose() }
            runCatching { source?.dispose() }
            runCatching { helper?.dispose() }
            runCatching { factory?.dispose() }
            runCatching { eglBase?.release() }
            capturer = null; track = null; source = null; helper = null; factory = null; eglBase = null
            runCatching { http.dispatcher.executorService.shutdown() }
        }
        exec.shutdown()
    }

    /** O celular girou: ajusta o tamanho da captura para não ficar com tarjas pretas. */
    fun onRotation() = runSafe {
        val (w, h) = captureSize()
        try {
            capturer?.changeCaptureFormat(w, h, quality.fps)
        } catch (e: Throwable) {
            Log.w(tag, "Não deu para ajustar a captura após girar", e)
        }
    }

    fun updateQuality(q: Quality) = runSafe {
        quality = q
        val (w, h) = captureSize()
        try {
            capturer?.changeCaptureFormat(w, h, q.fps)
        } catch (e: Throwable) {
            Log.w(tag, "Não deu para mudar o tamanho da captura", e)
        }
        peers.values.forEach { applySenderParams(it) }
    }

    private fun runSafe(block: () -> Unit) {
        if (exec.isShutdown) return
        try {
            exec.execute { if (!stopped) block() }
        } catch (_: Throwable) {
        }
    }

    private fun schedule(delayMs: Long, block: () -> Unit) {
        if (exec.isShutdown) return
        try {
            exec.schedule(Runnable { if (!stopped) block() }, delayMs, TimeUnit.MILLISECONDS)
        } catch (_: Throwable) {
        }
    }

    // ---------------------------------------------------------------
    // WebRTC e captura de tela
    // ---------------------------------------------------------------

    private fun initWebRtc() {
        initFactoryOnce(context)
        val egl = EglBase.create()
        eglBase = egl
        factory = PeerConnectionFactory.builder()
            // codificadores da placa de vídeo do celular (H.264/VP8/VP9 por hardware quando houver)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
    }

    private fun startCapture() {
        val f = factory ?: return
        val egl = eglBase ?: return
        val h = SurfaceTextureHelper.create("TelaoCaptura", egl.eglBaseContext)
        helper = h
        val src = f.createVideoSource(true)
        source = src
        val cap = ScreenCapturerAndroid(permissionData, object : MediaProjection.Callback() {
            override fun onStop() {
                // O usuário parou pelo aviso do sistema (ou outro app pegou a tela)
                onEvent(Event.ProjectionStopped)
            }
        })
        cap.initialize(h, context.applicationContext, src.capturerObserver)
        val (w, hgt) = captureSize()
        cap.startCapture(w, hgt, quality.fps)
        capturer = cap
        track = f.createVideoTrack("telao-tela", src)
    }

    /** Tamanho da captura: a tela do celular reduzida até o lado menor caber na qualidade escolhida. */
    private fun captureSize(): Pair<Int, Int> {
        val dm = context.getSystemService(DisplayManager::class.java)
        val display = dm.getDisplay(Display.DEFAULT_DISPLAY)
        val m = DisplayMetrics()
        @Suppress("DEPRECATION")
        display.getRealMetrics(m)
        val w = m.widthPixels
        val h = m.heightPixels
        val short = minOf(w, h)
        val scale = if (quality.shortSide <= 0 || short <= quality.shortSide) 1.0 else quality.shortSide.toDouble() / short
        fun even(v: Double) = (v.toInt() / 2) * 2
        return even(w * scale) to even(h * scale)
    }

    // ---------------------------------------------------------------
    // Sinalização (WebSocket)
    // ---------------------------------------------------------------

    private fun connect() {
        if (stopped) return
        val req = Request.Builder().url(wsUrl).build()
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val join = JSONObject().put("type", "join").put("room", room).put("name", name)
                webSocket.send(join.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runSafe {
                    if (webSocket != ws) return@runSafe
                    try {
                        handleServer(JSONObject(text))
                    } catch (e: Throwable) {
                        Log.w(tag, "Mensagem inválida", e)
                    }
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                runSafe { if (webSocket == ws) lostConnection() }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(tag, "WebSocket caiu", t)
                runSafe { if (webSocket == ws) lostConnection() }
            }
        })
    }

    private fun lostConnection() {
        ws = null
        myId = null
        peers.values.forEach { p -> runCatching { p.pc?.dispose() } }
        peers.clear()
        reportViewers()
        schedule(2000) { connect() }
    }

    private fun send(msg: JSONObject) {
        ws?.send(msg.toString())
    }

    private fun sendSignal(to: String, data: JSONObject) {
        send(JSONObject().put("type", "signal").put("to", to).put("data", data))
    }

    private fun sendMeta() {
        val streams = JSONObject().put(streamId, "screen")
        send(JSONObject().put("type", "meta").put("name", name).put("streams", streams))
    }

    private fun handleServer(m: JSONObject) {
        when (m.optString("type")) {
            "welcome" -> {
                myId = m.getString("id")
                m.optJSONArray("iceServers")?.let { iceServers = parseIce(it) }
                val list = m.optJSONArray("peers") ?: JSONArray()
                for (i in 0 until list.length()) {
                    val id = list.getJSONObject(i).getString("id")
                    if (id != ignoreId) createPeer(id)
                }
                sendMeta()
                onEvent(Event.Joined(myId!!))
            }
            "peer-joined" -> {
                val id = m.getString("id")
                if (id != ignoreId) createPeer(id)
                sendMeta()
            }
            "peer-left" -> closePeer(m.getString("id"))
            "signal" -> {
                val from = m.getString("from")
                if (from == ignoreId) return
                val peer = peers[from] ?: createPeer(from) ?: return
                handleSignal(peer, m.optJSONObject("data") ?: JSONObject())
            }
            "full" -> {
                onEvent(Event.Error("Essa sala está cheia (máximo de ${m.optInt("max", 8)} pessoas)."))
            }
        }
    }

    private fun parseIce(arr: JSONArray): List<PeerConnection.IceServer> {
        val out = mutableListOf<PeerConnection.IceServer>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val urls = mutableListOf<String>()
            when (val u = o.opt("urls")) {
                is String -> urls.add(u)
                is JSONArray -> for (j in 0 until u.length()) urls.add(u.getString(j))
            }
            if (urls.isEmpty()) continue
            val b = PeerConnection.IceServer.builder(urls)
            if (o.has("username")) b.setUsername(o.optString("username"))
            if (o.has("credential")) b.setPassword(o.optString("credential"))
            out.add(b.createIceServer())
        }
        return out.ifEmpty { iceServers }
    }

    // ---------------------------------------------------------------
    // Uma conexão por amigo ("negociação perfeita", igual ao site)
    // ---------------------------------------------------------------

    private fun createPeer(id: String): Peer? {
        peers[id]?.let { return it }
        val f = factory ?: return null
        val t = track ?: return null
        val me = myId ?: return null
        val peer = Peer(id, polite = me > id)

        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val pc = f.createPeerConnection(config, observer(peer)) ?: return null
        peer.pc = pc
        peers[id] = peer

        // Só envia: a tela vai para o amigo, nada volta para o celular
        val init = RtpTransceiver.RtpTransceiverInit(
            RtpTransceiver.RtpTransceiverDirection.SEND_ONLY,
            listOf(streamId),
        )
        peer.sender = pc.addTransceiver(t, init).sender
        return peer
    }

    private fun closePeer(id: String) {
        val p = peers.remove(id) ?: return
        runCatching { p.pc?.dispose() }
        reportViewers()
    }

    private fun observer(peer: Peer) = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onAddStream(stream: MediaStream?) {}
        override fun onRemoveStream(stream: MediaStream?) {}
        override fun onDataChannel(channel: DataChannel?) {}
        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}

        override fun onIceCandidate(c: IceCandidate?) {
            c ?: return
            runSafe {
                if (peers[peer.id] !== peer) return@runSafe
                val cand = JSONObject()
                    .put("candidate", c.sdp)
                    .put("sdpMid", c.sdpMid)
                    .put("sdpMLineIndex", c.sdpMLineIndex)
                sendSignal(peer.id, JSONObject().put("candidate", cand))
            }
        }

        override fun onRenegotiationNeeded() {
            runSafe { if (peers[peer.id] === peer) makeOffer(peer) }
        }

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
            runSafe {
                if (peers[peer.id] !== peer) return@runSafe
                peer.connected = newState == PeerConnection.PeerConnectionState.CONNECTED
                if (newState == PeerConnection.PeerConnectionState.FAILED) {
                    runCatching { peer.pc?.restartIce() }
                }
                reportViewers()
            }
        }
    }

    private fun reportViewers() {
        val n = peers.values.count { it.connected }
        if (n != lastViewers) {
            lastViewers = n
            onEvent(Event.Viewers(n))
        }
    }

    private fun makeOffer(peer: Peer) {
        val pc = peer.pc ?: return
        if (pc.signalingState() != PeerConnection.SignalingState.STABLE) return
        peer.makingOffer = true
        pc.createOffer(sdpObserver(
            onCreate = { sdp ->
                runSafe {
                    if (pc.signalingState() != PeerConnection.SignalingState.STABLE) {
                        peer.makingOffer = false
                        return@runSafe
                    }
                    pc.setLocalDescription(sdpObserver(
                        onSet = {
                            runSafe {
                                peer.makingOffer = false
                                sendDescription(peer, pc.localDescription)
                                applySenderParams(peer)
                            }
                        },
                        onFail = { runSafe { peer.makingOffer = false } },
                    ), sdp)
                }
            },
            onFail = { runSafe { peer.makingOffer = false } },
        ), MediaConstraints())
    }

    private fun handleSignal(peer: Peer, data: JSONObject) {
        val pc = peer.pc ?: return
        val desc = data.optJSONObject("description")
        val cand = data.optJSONObject("candidate")

        if (desc != null) {
            val type = SessionDescription.Type.fromCanonicalForm(desc.getString("type"))
            val sdp = desc.getString("sdp")
            val isOffer = type == SessionDescription.Type.OFFER
            val collision = isOffer && (peer.makingOffer || pc.signalingState() != PeerConnection.SignalingState.STABLE)
            peer.ignoreOffer = !peer.polite && collision
            if (peer.ignoreOffer) return

            val applyRemote = {
                pc.setRemoteDescription(sdpObserver(
                    onSet = {
                        runSafe {
                            flushCandidates(peer)
                            if (isOffer) answer(peer) else applySenderParams(peer)
                        }
                    },
                    onFail = { err -> Log.w(tag, "setRemoteDescription falhou: $err") },
                ), SessionDescription(type, sdp))
            }

            if (collision) {
                // Somos o lado "educado": desfaz a nossa oferta e aceita a do amigo
                peer.makingOffer = false
                pc.setLocalDescription(sdpObserver(
                    onSet = { runSafe { applyRemote() } },
                    onFail = { runSafe { applyRemote() } },
                ), SessionDescription(SessionDescription.Type.ROLLBACK, ""))
            } else {
                applyRemote()
            }
        } else if (cand != null) {
            val s = cand.optString("candidate", "")
            if (s.isEmpty()) return
            val c = IceCandidate(cand.optString("sdpMid", "0"), cand.optInt("sdpMLineIndex", 0), s)
            if (pc.remoteDescription == null) {
                peer.pendingCandidates.add(c)
            } else if (!pc.addIceCandidate(c) && !peer.ignoreOffer) {
                Log.w(tag, "Candidato ICE recusado")
            }
        }
    }

    private fun flushCandidates(peer: Peer) {
        val pc = peer.pc ?: return
        peer.pendingCandidates.forEach { pc.addIceCandidate(it) }
        peer.pendingCandidates.clear()
    }

    private fun answer(peer: Peer) {
        val pc = peer.pc ?: return
        val mine = track?.id()
        // Se o amigo também está transmitindo, recusamos receber (economiza internet e bateria)
        for (t in pc.transceivers) {
            if (t.isStopped) continue
            val isMine = mine != null && t.sender.track()?.id() == mine
            t.setDirection(
                if (isMine) RtpTransceiver.RtpTransceiverDirection.SEND_ONLY
                else RtpTransceiver.RtpTransceiverDirection.INACTIVE
            )
        }
        pc.createAnswer(sdpObserver(
            onCreate = { sdp ->
                runSafe {
                    pc.setLocalDescription(sdpObserver(
                        onSet = {
                            runSafe {
                                sendDescription(peer, pc.localDescription)
                                applySenderParams(peer)
                            }
                        },
                        onFail = { err -> Log.w(tag, "setLocalDescription (resposta) falhou: $err") },
                    ), sdp)
                }
            },
            onFail = { err -> Log.w(tag, "createAnswer falhou: $err") },
        ), MediaConstraints())
    }

    private fun sendDescription(peer: Peer, sdp: SessionDescription?) {
        sdp ?: return
        val d = JSONObject().put("type", sdp.type.canonicalForm()).put("sdp", sdp.description)
        sendSignal(peer.id, JSONObject().put("description", d))
    }

    /** Taxa de bits e fps máximos; em jogos prioriza manter os fps. */
    private fun applySenderParams(peer: Peer) {
        val s = peer.sender ?: return
        try {
            val p = s.parameters
            if (p.encodings.isNotEmpty()) {
                p.encodings[0].maxBitrateBps = quality.kbps * 1000
                p.encodings[0].maxFramerate = quality.fps
            }
            p.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE
            s.setParameters(p)
        } catch (e: Throwable) {
            Log.w(tag, "Não deu para ajustar a qualidade", e)
        }
    }

    private fun sdpObserver(
        onCreate: (SessionDescription) -> Unit = {},
        onSet: () -> Unit = {},
        onFail: (String?) -> Unit = {},
    ) = object : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription?) {
            if (sdp != null) onCreate(sdp) else onFail("sem SDP")
        }
        override fun onSetSuccess() = onSet()
        override fun onCreateFailure(error: String?) = onFail(error)
        override fun onSetFailure(error: String?) = onFail(error)
    }

    companion object {
        @Volatile
        private var initialized = false

        @Synchronized
        private fun initFactoryOnce(context: Context) {
            if (initialized) return
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                    .createInitializationOptions()
            )
            initialized = true
        }
    }
}
