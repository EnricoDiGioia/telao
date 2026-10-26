package app.telao

import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/** Estado da transmissão da tela, compartilhado entre o serviço e a tela do app. */
object StreamState {
    data class State(
        val live: Boolean = false,
        val peerId: String? = null,
        val viewers: Int = 0,
        val error: String? = null,
    ) {
        fun toJson(): String = JSONObject().apply {
            put("live", live)
            put("viewers", viewers)
            if (peerId != null) put("peerId", peerId)
            if (error != null) put("error", error)
        }.toString()
    }

    private val main = Handler(Looper.getMainLooper())

    @Volatile
    var state = State()
        private set

    /** Quem quer saber das mudanças (a MainActivity). Sempre chamado na thread principal. */
    var listener: ((State) -> Unit)? = null

    fun set(s: State) {
        state = s
        main.post { listener?.invoke(s) }
    }

    fun update(block: (State) -> State) = set(block(state))
}
