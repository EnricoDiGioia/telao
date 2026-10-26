'use strict';
// Telão — cliente
// Cada participante se conecta direto a todos os outros (WebRTC em malha).
// O servidor só ajuda a trocar as mensagens de conexão.

(() => {
  const $ = (s) => document.querySelector(s);

  // =========================================================
  // Configurações de qualidade
  // =========================================================
  const SCREEN_RES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], source: null };
  const CAM_RES = { 360: [640, 360], 720: [1280, 720], 1080: [1920, 1080] };

  const DEFAULTS = {
    screenRes: '1080',
    screenFps: '30',
    screenBitrate: 'auto',
    screenPriority: 'motion',
    screenAudio: true,
    camDevice: '',
    camRes: '720',
    camFps: '30',
    codec: 'auto',
    playback: 'realtime',
    camFacing: 'user',
    micDevice: '',
    noiseSuppression: true,
  };

  // ---------- Que aparelho é este ----------
  const UA = navigator.userAgent || '';
  const IS_ANDROID = /Android/i.test(UA);
  const IS_IOS = /iPhone|iPad|iPod/i.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IS_MOBILE = IS_ANDROID || IS_IOS || !!(navigator.userAgentData && navigator.userAgentData.mobile);

  // O Chrome do Android tem a função, mas sempre recusa; por isso o Android fica de fora
  // ---------- Dentro do app de Android ----------
  // O app injeta window.TelaoAndroid. A tela do celular é transmitida pelo próprio app
  // (entra na sala como "Nome (tela)"), e este site não conecta nessa transmissão dele mesmo.
  const NATIVE = window.TelaoAndroid || null;
  let nativeLive = false;
  let nativePending = false;
  let nativeName = null;
  const ignoredPeers = new Set();
  if (NATIVE) document.documentElement.classList.add('in-app');

  function isOwnNativePeer(id, name) {
    if (ignoredPeers.has(id)) return true;
    if (NATIVE && nativeName && name === nativeName && (nativePending || nativeLive)) {
      ignoredPeers.add(id);
      return true;
    }
    return false;
  }

  function canShareScreen() {
    if (NATIVE) return true;
    return !IS_ANDROID && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && window.isSecureContext;
  }

  const settings = (() => {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('telao.settings') || '{}') };
    } catch {
      return { ...DEFAULTS };
    }
  })();

  function saveSettings() {
    try { localStorage.setItem('telao.settings', JSON.stringify(settings)); } catch {}
  }

  function fpsFactor(fps) {
    return fps >= 60 ? 1.6 : fps <= 15 ? 0.6 : 1;
  }
  function screenKbps() {
    if (settings.screenBitrate !== 'auto') return Number(settings.screenBitrate);
    const base = { 720: 2500, 1080: 4500, 1440: 8000, source: 8000 }[settings.screenRes] || 4500;
    return Math.round(base * fpsFactor(Number(settings.screenFps)));
  }
  function camKbps() {
    const base = { 360: 700, 720: 1800, 1080: 3500 }[settings.camRes] || 1800;
    return Math.round(base * fpsFactor(Number(settings.camFps)));
  }

  function screenVideoConstraints() {
    const fps = Number(settings.screenFps);
    const c = { frameRate: { ideal: fps, max: fps } };
    const r = SCREEN_RES[settings.screenRes];
    if (r) {
      c.width = { max: r[0] };
      c.height = { max: r[1] };
    }
    return c;
  }
  // =========================================================
  // Codificação: tenta usar a placa de vídeo (encoder por hardware)
  // =========================================================
  const CODEC_LABEL = { H264: 'H.264', AV1: 'AV1', VP9: 'VP9', VP8: 'VP8' };
  let autoCodec = 'VP8'; // o que a detecção escolheu
  let gpuCodecs = []; // codecs que o navegador diz codificar pela placa de vídeo

  async function hwEncodes(name) {
    if (!navigator.mediaCapabilities || !navigator.mediaCapabilities.encodingInfo) return false;
    const types =
      name === 'H264'
        ? ['video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f', 'video/H264']
        : [`video/${name}`];
    for (const contentType of types) {
      try {
        const r = await navigator.mediaCapabilities.encodingInfo({
          type: 'webrtc',
          video: { contentType, width: 1920, height: 1080, bitrate: 6000000, framerate: 60 },
        });
        if (r.supported) return !!r.powerEfficient;
      } catch {}
    }
    return false;
  }

  async function detectCodecs() {
    let available = [];
    try {
      available = (RTCRtpSender.getCapabilities('video')?.codecs || []).map((c) => c.mimeType.split('/')[1].toUpperCase());
    } catch {}
    gpuCodecs = [];
    // H.264 primeiro: quase toda placa de vídeo codifica e decodifica ele por hardware
    for (const name of ['H264', 'AV1', 'VP9']) {
      if (available.includes(name) && (await hwEncodes(name))) gpuCodecs.push(name);
    }
    autoCodec = gpuCodecs[0] || 'VP8';
    // marca no seletor o que cada opção faz neste PC
    const sel = $('#codec');
    if (sel) {
      for (const o of sel.options) {
        if (o.value === 'auto') o.textContent = `Automática (${CODEC_LABEL[autoCodec]})`;
        else if (!available.includes(o.value)) { o.disabled = true; o.textContent = `${CODEC_LABEL[o.value]} (indisponível)`; }
        else o.textContent = `${CODEC_LABEL[o.value]}${gpuCodecs.includes(o.value) ? ' · placa de vídeo' : ' · processador'}`;
      }
      if (sel.selectedOptions[0]?.disabled) sel.value = 'auto';
    }
    const note = $('#codecNote');
    if (note) {
      note.textContent = gpuCodecs.length
        ? `Este PC codifica ${gpuCodecs.map((c) => CODEC_LABEL[c]).join(', ')} pela placa de vídeo, o que deixa a transmissão mais leve e fluida.`
        : 'O navegador não informou codificação pela placa de vídeo neste PC; a transmissão usa o processador. Se travar, baixe resolução ou fps.';
    }
    for (const peer of peers.values()) queueSenderParams(peer);
  }

  function chosenCodec() {
    return settings.codec === 'auto' ? autoCodec : settings.codec;
  }

  // Escolhe, entre os codecs combinados com o amigo, o que eu quero usar para enviar
  function findCodec(codecs, name) {
    const list = (codecs || []).filter((c) => c.mimeType.toLowerCase() === `video/${name.toLowerCase()}`);
    const fmtp = (c) => c.sdpFmtpLine || '';
    let c;
    if (name === 'H264') {
      c = list.find((x) => /packetization-mode=1/.test(fmtp(x)) && /profile-level-id=42e01f/i.test(fmtp(x)))
        || list.find((x) => /packetization-mode=1/.test(fmtp(x)));
    } else if (name === 'VP9') {
      c = list.find((x) => !/profile-id=[1-3]/.test(fmtp(x)));
    } else if (name === 'AV1') {
      c = list.find((x) => !/profile=[12]/.test(fmtp(x)));
    }
    c = c || list[0];
    if (!c) return null;
    const out = { mimeType: c.mimeType, clockRate: c.clockRate };
    if (c.sdpFmtpLine) out.sdpFmtpLine = c.sdpFmtpLine;
    return out;
  }

  function applyPlayback(peer) {
    const target = settings.playback === 'smooth' ? 300 : null;
    for (const r of peer.pc.getReceivers()) {
      try { if ('jitterBufferTarget' in r) r.jitterBufferTarget = target; } catch {}
    }
  }

  function camVideoConstraints(withDevice = true) {
    const [w, h] = CAM_RES[settings.camRes] || CAM_RES[720];
    const fps = Number(settings.camFps);
    const c = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps, max: fps } };
    if (withDevice && settings.camDevice) c.deviceId = { exact: settings.camDevice };
    else if (IS_MOBILE) c.facingMode = { ideal: settings.camFacing || 'user' };
    return c;
  }

  // =========================================================
  // Estado
  // =========================================================
  let ws = null;
  let myId = null;
  let myName = '';
  let room = '';
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let leaving = false;
  let wasConnected = false;
  let reconnectTimer = null;

  const peers = new Map(); // id -> peer
  const local = { screen: null, camera: null, mic: null }; // o que EU estou enviando (mic = { stream, track, muted })
  const voices = new Map(); // chave -> { peerId, stream, audio } (voz de cada amigo)
  let deafened = false; // "Silenciar": não ouvir ninguém
  const tiles = new Map(); // chave -> tile
  let focusKey = null;
  let pipWindow = null;
  let pipKey = null;

  // =========================================================
  // Ícones
  // =========================================================
  const ICON = {
    focus: '<svg viewBox="0 0 24 24"><path d="M4 4h6v2H7.4l3.3 3.3-1.4 1.4L6 7.4V10H4zm16 0v6h-2V7.4l-3.3 3.3-1.4-1.4L16.6 6H14V4zM4 20v-6h2v2.6l3.3-3.3 1.4 1.4L7.4 18H10v2zm16 0h-6v-2h2.6l-3.3-3.3 1.4-1.4 3.3 3.3V14h2z"/></svg>',
    popout: '<svg viewBox="0 0 24 24"><path d="M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14zM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg>',
    pip: '<svg viewBox="0 0 24 24"><path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6h-2V5H5v14h6v2H5a2 2 0 0 1-2-2zm10 8h8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/></svg>',
    full: '<svg viewBox="0 0 24 24"><path d="M3 3h7v2H5v5H3zm11 0h7v7h-2V5h-5zM3 14h2v5h5v2H3zm16 0h2v7h-7v-2h5z"/></svg>',
  };

  // =========================================================
  // Avisos
  // =========================================================
  function toast(msg, type, ms, action) {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    const text = document.createElement('span');
    text.textContent = msg;
    el.append(text);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn primary small toast-action';
      b.textContent = action.label;
      b.addEventListener('click', () => {
        el.remove();
        action.onClick();
      });
      el.append(b);
    }
    el.addEventListener('click', (e) => {
      if (!e.target.closest('button')) el.remove();
    });
    $('#toasts').append(el);
    setTimeout(() => el.remove(), ms || (type === 'error' ? 7000 : 3500));
  }

  // =========================================================
  // Tela de entrada
  // =========================================================
  function randomRoom() {
    return 'sala-' + Math.random().toString(36).slice(2, 6);
  }

  const params = new URLSearchParams(location.search);
  $('#roomInput').value = params.get('sala') || randomRoom();
  try { $('#nameInput').value = localStorage.getItem('telao.name') || ''; } catch {}
  ($('#nameInput').value ? $('#roomInput') : $('#nameInput')).focus();

  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    myName = $('#nameInput').value.trim().slice(0, 32) || 'Anônimo';
    room = $('#roomInput').value.trim().slice(0, 64) || randomRoom();
    try { localStorage.setItem('telao.name', myName); } catch {}
    history.replaceState(null, '', `${location.pathname}?sala=${encodeURIComponent(room)}`);

    $('#join').hidden = true;
    $('#app').hidden = false;
    $('#roomName').textContent = room;
    initQualityPanel();
    detectCodecs();
    updateButtons();
    renderPeople();
    connect();

    if (!window.isSecureContext) {
      toast('Você abriu por um endereço sem https. Dá para assistir, mas o navegador bloqueia transmitir tela e câmera. Use http://localhost ou o link do túnel (https).', 'error');
    }
  });

  // =========================================================
  // Sinalização (WebSocket)
  // =========================================================
  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
  function sendSignal(to, data) {
    wsSend({ type: 'signal', to, data });
  }

  function setConn(state) {
    const dot = $('#connDot');
    dot.classList.toggle('ok', state === 'ok');
    dot.classList.toggle('bad', state === 'bad');
    dot.title = state === 'ok' ? 'Conectado ao servidor' : state === 'bad' ? 'Sem conexão com o servidor' : 'Conectando…';
  }

  function connect() {
    setConn('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?sala=${encodeURIComponent(room)}`);
    ws.onopen = () => wsSend({ type: 'join', room, name: myName });
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onServerMessage(m);
    };
    ws.onclose = () => {
      setConn('bad');
      for (const id of [...peers.keys()]) removePeer(id);
      myId = null;
      if (leaving) return;
      if (wasConnected) toast('A conexão com o servidor caiu. Tentando reconectar…', 'error');
      wasConnected = false;
      reconnectTimer = setTimeout(connect, 2000);
    };
  }

  // Mantém a conexão com o servidor viva (conexões paradas são derrubadas)
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}');
  }, 30000);

  function onServerMessage(m) {
    switch (m.type) {
      case 'welcome': {
        myId = m.id;
        wasConnected = true;
        if (Array.isArray(m.iceServers)) iceServers = m.iceServers;
        setConn('ok');
        for (const p of m.peers) {
          if (isOwnNativePeer(p.id, p.name)) continue;
          const peer = createPeer(p.id, p.name);
          applyMeta(peer, p.streams || {}, p.name);
        }
        broadcastMeta();
        renderPeople();
        break;
      }
      case 'peer-joined':
        if (isOwnNativePeer(m.id, m.name)) break;
        createPeer(m.id, m.name);
        toast(`${m.name} entrou na sala`);
        broadcastMeta();
        renderPeople();
        break;
      case 'peer-left': {
        ignoredPeers.delete(m.id);
        const p = peers.get(m.id);
        if (p) toast(`${p.name} saiu da sala`);
        removePeer(m.id);
        break;
      }
      case 'signal':
        if (ignoredPeers.has(m.from)) break;
        handleSignal(m.from, m.data || {});
        break;
      case 'meta': {
        const p = peers.get(m.from);
        if (p) applyMeta(p, m.streams || {}, m.name);
        break;
      }
      case 'full':
        leaving = true;
        toast(`Essa sala está cheia (máximo de ${m.max} pessoas).`, 'error');
        setTimeout(() => location.reload(), 2500);
        break;
    }
  }

  // Conta para os outros quais transmissões minhas são tela e quais são câmera
  function broadcastMeta() {
    const streams = {};
    if (local.screen) streams[local.screen.id] = 'screen';
    if (local.camera) streams[local.camera.id] = 'camera';
    if (local.mic) streams[local.mic.stream.id] = local.mic.muted ? 'mic-muted' : 'mic';
    wsSend({ type: 'meta', name: myName, streams });
  }

  const isMicKind = (k) => typeof k === 'string' && k.startsWith('mic');

  function applyMeta(peer, streams, name) {
    if (name) peer.name = name;
    peer.meta = streams;
    for (const [key, t] of [...tiles]) {
      if (t.ownerId !== peer.id) continue;
      if (!(t.stream.id in streams)) {
        removeTile(key);
      } else if (isMicKind(streams[t.stream.id])) {
        // era voz, não vídeo: tira o quadro e toca como voz
        const stream = t.stream;
        removeTile(key);
        attachVoice(peer, stream);
      } else {
        t.kind = streams[t.stream.id];
        updateTileLabel(t);
      }
    }
    for (const [key, v] of [...voices]) {
      if (v.peerId === peer.id && !(v.stream.id in streams)) removeVoice(key);
    }
    renderPeople();
  }

  // =========================================================
  // WebRTC — uma conexão por amigo ("negociação perfeita")
  // =========================================================
  function createPeer(id, name) {
    if (peers.has(id)) return peers.get(id);

    const pc = new RTCPeerConnection({ iceServers });
    const peer = {
      id,
      name: name || '…',
      pc,
      polite: String(myId) > String(id),
      makingOffer: false,
      ignoreOffer: false,
      senders: { screen: [], camera: [], mic: [] },
      own: new Set(), // canais (transceivers) que eu criei
      meta: {},
      paramChain: Promise.resolve(),
      warnedFail: false,
    };
    peers.set(id, peer);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal(id, { candidate });
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        sendSignal(id, { description: pc.localDescription });
      } catch (err) {
        console.error('Erro ao negociar', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track]);
      const kind = peer.meta[stream.id];
      if (isMicKind(kind)) {
        attachVoice(peer, stream);
        return;
      }
      // Só áudio e ainda sem saber o que é: espera o aviso de "meta" chegar antes de decidir
      if (kind === undefined && track.kind === 'audio' && !stream.getVideoTracks().length) {
        setTimeout(() => {
          if (!peers.has(peer.id)) return;
          const k = peer.meta[stream.id];
          if (isMicKind(k) || (k === undefined && !stream.getVideoTracks().length)) attachVoice(peer, stream);
          else showRemoteStream(peer, stream);
        }, 500);
        return;
      }
      showRemoteStream(peer, stream);
    };

    const showRemoteStream = (peer, stream) => {
      const key = `${peer.id}:${stream.id}`;
      const isNew = !tiles.has(key);
      const t = ensureTile(key, { stream, ownerId: peer.id, kind: peer.meta[stream.id], local: false });
      updateTileAudio(t);
      applyPlayback(peer);
      stream.onremovetrack = () => {
        if (!stream.getTracks().length) removeTile(key);
        else updateTileAudio(t);
      };
      // Quando alguém começa a transmitir a tela, ela vai para o destaque (se nada estiver focado)
      if (isNew && peer.meta[stream.id] === 'screen' && !focusKey) {
        focusKey = key;
        updateLayout();
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        pc.restartIce();
        if (!peer.warnedFail) {
          peer.warnedFail = true;
          toast(`Não foi possível conectar direto com ${peer.name}. Se continuar, vocês provavelmente precisam de um servidor TURN (veja o README).`, 'error');
        }
      }
      if (pc.connectionState === 'connected') peer.warnedFail = false;
      renderPeople();
    };

    // Se eu já estou transmitindo, manda para quem acabou de chegar
    for (const kind of ['screen', 'camera']) {
      if (local[kind]) addStreamToPeer(peer, kind, local[kind]);
    }
    if (local.mic) addMicToPeer(peer);
    return peer;
  }

  async function handleSignal(from, { description, candidate }) {
    const peer = peers.get(from) || createPeer(from, '…');
    const pc = peer.pc;
    try {
      if (description) {
        const offerCollision =
          description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          sendSignal(from, { description: pc.localDescription });
        }
        queueSenderParams(peer);
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!peer.ignoreOffer) console.warn('Candidato ICE recusado', err);
        }
      }
    } catch (err) {
      console.error('Erro na sinalização', err);
    }
  }

  function removePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    try { peer.pc.close(); } catch {}
    peers.delete(id);
    for (const [key, t] of [...tiles]) if (t.ownerId === id) removeTile(key);
    for (const [key, v] of [...voices]) if (v.peerId === id) removeVoice(key);
    renderPeople();
  }

  // Cada transmissão ganha canais próprios só de envio. (Com addTrack o navegador reaproveitava
  // o canal aberto para a voz do amigo, e a tela nova não aparecia para ele sem reabrir.)
  function addStreamToPeer(peer, kind, stream) {
    peer.senders[kind] = stream.getTracks().map((track) => {
      const tr = peer.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
      peer.own.add(tr);
      return tr.sender;
    });
  }

  // Encerra de vez os canais da transmissão: o navegador recicla a vaga deles na próxima,
  // então ligar/desligar muitas vezes não acumula canais.
  function removeStreamFromPeer(peer, kind) {
    for (const sender of peer.senders[kind]) {
      const tr = peer.pc.getTransceivers().find((t) => t.sender === sender);
      try {
        if (tr && peer.own.has(tr) && typeof tr.stop === 'function') {
          tr.stop();
          peer.own.delete(tr);
        } else {
          peer.pc.removeTrack(sender);
        }
      } catch {}
    }
    peer.senders[kind] = [];
  }

  // =========================================================
  // Voz
  // Cada amigo recebe um canal de áudio só meu. Mutar troca o microfone por "nada"
  // (replaceTrack), sem renegociar: é instantâneo e desliga o microfone de verdade.
  // =========================================================
  function micConstraints() {
    const c = {
      echoCancellation: true,
      noiseSuppression: settings.noiseSuppression !== false,
      autoGainControl: true,
    };
    if (settings.micDevice) c.deviceId = { exact: settings.micDevice };
    return c;
  }

  async function openMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Este navegador não deixa usar o microfone aqui (precisa ser https ou localhost).', 'error');
      return null;
    }
    try {
      return (await navigator.mediaDevices.getUserMedia({ audio: micConstraints() })).getAudioTracks()[0] || null;
    } catch (err) {
      if (settings.micDevice && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        settings.micDevice = '';
        saveSettings();
        return openMic();
      }
      const why = err.name === 'NotAllowedError' ? 'o acesso ao microfone foi negado' : err.message;
      toast('Não deu para abrir o microfone: ' + why, 'error');
      return null;
    }
  }

  function addMicToPeer(peer) {
    if (!local.mic) return;
    const tr = peer.pc.addTransceiver(local.mic.track || 'audio', {
      direction: 'sendonly',
      streams: [local.mic.stream],
    });
    peer.own.add(tr);
    peer.senders.mic = [tr.sender];
  }

  function watchMicTrack(track) {
    track.addEventListener('ended', () => {
      // microfone desconectado: fica como mutado
      if (local.mic && local.mic.track === track) setMicMuted(true);
    });
  }

  async function joinVoice() {
    const track = await openMic();
    if (!track) return;
    watchMicTrack(track);
    local.mic = { stream: new MediaStream([track]), track, muted: false };
    broadcastMeta();
    for (const peer of peers.values()) addMicToPeer(peer);
    watchLevel('me', local.mic.stream);
    resumeAudio();
    updateButtons();
    renderPeople();
    populateMics();
    // No app de Android: mantém o microfone funcionando com o app em segundo plano
    if (NATIVE && NATIVE.voiceState) NATIVE.voiceState(true);
  }

  async function setMicMuted(muted) {
    const mic = local.mic;
    if (!mic || mic.muted === muted) return;
    if (muted) {
      const old = mic.track;
      mic.track = null;
      mic.muted = true;
      for (const peer of peers.values()) for (const s of peer.senders.mic) s.replaceTrack(null).catch(() => {});
      if (old) {
        old.stop();
        mic.stream.removeTrack(old);
      }
      stopLevel('me');
    } else {
      const track = await openMic();
      if (!track || !local.mic) return;
      watchMicTrack(track);
      mic.track = track;
      mic.muted = false;
      mic.stream.addTrack(track);
      for (const peer of peers.values()) for (const s of peer.senders.mic) s.replaceTrack(track).catch(() => {});
      watchLevel('me', mic.stream);
    }
    broadcastMeta();
    updateButtons();
    renderPeople();
  }

  function leaveVoice() {
    const mic = local.mic;
    if (!mic) return;
    local.mic = null;
    if (mic.track) mic.track.stop();
    for (const peer of peers.values()) removeStreamFromPeer(peer, 'mic');
    stopLevel('me');
    broadcastMeta();
    if (NATIVE && NATIVE.voiceState) NATIVE.voiceState(false);
  }

  // Muda o microfone (dispositivo/ruído) com a voz ligada
  async function reopenMic() {
    if (!local.mic || local.mic.muted) return;
    await setMicMuted(true);
    await setMicMuted(false);
  }

  // ---------- Ouvir os amigos ----------
  function voiceVolume(name) {
    try {
      const v = JSON.parse(localStorage.getItem('telao.volumes') || '{}')[name];
      return typeof v === 'number' ? v : 1;
    } catch {
      return 1;
    }
  }

  function saveVoiceVolume(name, v) {
    try {
      const all = JSON.parse(localStorage.getItem('telao.volumes') || '{}');
      all[name] = v;
      localStorage.setItem('telao.volumes', JSON.stringify(all));
    } catch {}
  }

  function attachVoice(peer, stream) {
    const key = `${peer.id}:${stream.id}`;
    if (voices.has(key)) return voices.get(key);
    const audio = new Audio();
    audio.autoplay = true;
    audio.srcObject = stream;
    audio.volume = voiceVolume(peer.name);
    audio.muted = deafened;
    audio.hidden = true;
    document.body.append(audio);
    const v = { peerId: peer.id, stream, audio };
    voices.set(key, v);
    audio.play().catch(() => unlockAudioOnClick());
    stream.onremovetrack = () => {
      if (!stream.getTracks().length) removeVoice(key);
    };
    watchLevel(peer.id, stream);
    renderPeople();
    return v;
  }

  function removeVoice(key) {
    const v = voices.get(key);
    if (!v) return;
    voices.delete(key);
    v.audio.srcObject = null;
    v.audio.remove();
    if (![...voices.values()].some((x) => x.peerId === v.peerId)) stopLevel(v.peerId);
    renderPeople();
  }

  let unlockArmed = false;
  function unlockAudioOnClick() {
    if (unlockArmed) return;
    unlockArmed = true;
    toast('Clique em qualquer lugar da página para ouvir a voz dos amigos.');
    document.addEventListener(
      'click',
      () => {
        unlockArmed = false;
        resumeAudio();
        for (const v of voices.values()) v.audio.play().catch(() => {});
      },
      { once: true }
    );
  }

  function setDeafened(on) {
    deafened = on;
    for (const v of voices.values()) v.audio.muted = on;
    for (const t of tiles.values()) {
      applyTileMute(t);
      updateTileAudio(t);
    }
    updateButtons();
    renderPeople();
    if (on) toast('Você não está ouvindo ninguém. Clique em "Ouvir" para voltar.');
  }

  // ---------- Quem está falando ----------
  let audioCtx = null;
  const levels = new Map(); // id ('me' ou peerId) -> { source, analyser, data, speaking, quietSince }

  function resumeAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch {}
  }

  function watchLevel(id, stream) {
    stopLevel(id);
    resumeAudio();
    if (!audioCtx || !stream.getAudioTracks().length) return;
    try {
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      levels.set(id, { source, analyser, data: new Float32Array(analyser.fftSize), speaking: false, quietSince: 0 });
    } catch (err) {
      console.warn('Sem indicador de fala', err);
    }
  }

  function stopLevel(id) {
    const l = levels.get(id);
    if (!l) return;
    try { l.source.disconnect(); } catch {}
    levels.delete(id);
    setSpeaking(id, false);
  }

  function setSpeaking(id, on) {
    const chip = document.querySelector(`.person[data-id="${CSS.escape(id)}"]`);
    if (chip) chip.classList.toggle('speaking', on);
  }

  setInterval(() => {
    const now = performance.now();
    for (const [id, l] of levels) {
      l.analyser.getFloatTimeDomainData(l.data);
      let sum = 0;
      for (let i = 0; i < l.data.length; i++) sum += l.data[i] * l.data[i];
      const rms = Math.sqrt(sum / l.data.length);
      const loud = rms > 0.015;
      if (loud) {
        l.quietSince = 0;
        if (!l.speaking) { l.speaking = true; setSpeaking(id, true); }
      } else if (l.speaking) {
        if (!l.quietSince) l.quietSince = now;
        else if (now - l.quietSince > 350) { l.speaking = false; setSpeaking(id, false); }
      }
    }
  }, 80);

  // Aplica taxa de bits / fps máximos nos envios (em fila para não atropelar)
  function queueSenderParams(peer) {
    peer.paramChain = peer.paramChain.then(() => applySenderParams(peer)).catch(() => {});
  }

  async function applySenderParams(peer) {
    for (const kind of ['screen', 'camera']) {
      for (const sender of peer.senders[kind]) {
        if (!sender.track || sender.track.kind !== 'video') continue;
        const maxBitrate = (kind === 'screen' ? screenKbps() : camKbps()) * 1000;
        const maxFramerate = Number(kind === 'screen' ? settings.screenFps : settings.camFps);

        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) continue;
        p.encodings[0].maxBitrate = maxBitrate;
        p.encodings[0].maxFramerate = maxFramerate;
        const codec = findCodec(p.codecs, chosenCodec());
        if (codec) p.encodings[0].codec = codec;
        else delete p.encodings[0].codec;
        if (kind === 'screen') {
          p.degradationPreference = settings.screenPriority === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
        }
        try {
          await sender.setParameters(p);
        } catch {
          // navegador mais antigo: aplica só taxa e fps
          try {
            const p2 = sender.getParameters();
            if (!p2.encodings || !p2.encodings.length) continue;
            p2.encodings[0].maxBitrate = maxBitrate;
            p2.encodings[0].maxFramerate = maxFramerate;
            delete p2.encodings[0].codec;
            await sender.setParameters(p2);
          } catch (err) {
            console.warn('Não deu para ajustar a qualidade', err);
          }
        }
      }
    }
  }

  // =========================================================
  // Transmitir tela / câmera
  // =========================================================
  function explainNoScreen() {
    if (IS_ANDROID) {
      toast('O Android não deixa sites transmitirem a tela, em nenhum navegador (Chrome, Samsung, Firefox). Pelo celular dá para transmitir a câmera; para a tela, use o PC.', 'error', 10000);
    } else if (IS_IOS) {
      toast('Transmitir a tela pelo iPhone/iPad precisa do iOS 27 ou mais novo, no Safari. Pelo celular dá para transmitir a câmera; para a tela, atualize o iOS ou use o PC.', 'error', 10000);
    } else if (!window.isSecureContext) {
      toast('Para transmitir a tela, abra o Telão pelo endereço https.', 'error');
    } else {
      toast('Este navegador não deixa transmitir a tela. Use Chrome ou Edge no computador.', 'error');
    }
  }

  async function startScreen() {
    if (NATIVE) {
      nativeName = `${myName} (tela)`;
      nativePending = true;
      NATIVE.startScreen(room, nativeName, myId || '', settings.screenRes, settings.screenFps, String(screenKbps()));
      return;
    }
    if (!canShareScreen()) return explainNoScreen();
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: screenVideoConstraints(),
        audio: settings.screenAudio
          // restrictOwnAudio: não captura o som do próprio Telão (a voz dos amigos) junto com a tela
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true, suppressLocalAudioPlayback: false }
          : false,
        systemAudio: settings.screenAudio ? 'include' : 'exclude',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
    } catch (err) {
      // No celular o navegador costuma recusar sem dizer o motivo
      if (IS_MOBILE && err.name !== 'AbortError') return explainNoScreen();
      if (err.name !== 'NotAllowedError') toast('Não deu para capturar a tela: ' + err.message, 'error');
      return;
    }

    const vt = stream.getVideoTracks()[0];
    if (vt) {
      vt.contentHint = settings.screenPriority === 'detail' ? 'detail' : 'motion';
      vt.addEventListener('ended', () => {
        const wasHidden = document.hidden;
        stopScreen();
        if (wasHidden && IS_MOBILE) screenStoppedWhileAway = true;
      });
    }
    mobileTip();

    local.screen = stream;
    broadcastMeta();
    ensureTile('local:screen', { stream, ownerId: 'me', kind: 'screen', local: true });
    for (const peer of peers.values()) addStreamToPeer(peer, 'screen', stream);
    updateButtons();
    renderPeople();

    if (settings.screenAudio && !stream.getAudioTracks().length) {
      toast('Sem áudio: no Windows o som só vai junto ao compartilhar uma aba ou a tela inteira (marque "Compartilhar áudio").');
    }
  }

  // O app de Android avisa aqui como está a transmissão da tela
  window.telaoNativeState = (s) => {
    const was = nativeLive;
    nativeLive = !!s.live;
    if (!nativeLive) nativePending = false;
    if (s.peerId) {
      ignoredPeers.add(s.peerId);
      if (peers.has(s.peerId)) removePeer(s.peerId);
    }
    if (s.error) toast(s.error, 'error', 9000);
    if (!was && nativeLive) {
      toast('Transmitindo a tela do celular. Pode sair do app: a transmissão continua. Para parar, use o botão ou a notificação.', null, 8000);
    }
    updateButtons();
    renderPeople();
  };

  function stopScreen() {
    if (NATIVE && nativeLive) {
      NATIVE.stopScreen();
      return;
    }
    if (!local.screen) return;
    const stream = local.screen;
    local.screen = null;
    stream.getTracks().forEach((t) => t.stop());
    for (const peer of peers.values()) removeStreamFromPeer(peer, 'screen');
    removeTile('local:screen');
    broadcastMeta();
    updateButtons();
    renderPeople();
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return toast('Este navegador não deixa usar a câmera aqui (precisa ser https ou localhost).', 'error');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: camVideoConstraints(true), audio: false });
    } catch (err) {
      if (settings.camDevice && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        settings.camDevice = '';
        saveSettings();
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: camVideoConstraints(false), audio: false });
        } catch (err2) {
          return toast('Não deu para abrir a câmera: ' + err2.message, 'error');
        }
      } else {
        return toast('Não deu para abrir a câmera: ' + err.message, 'error');
      }
    }

    watchCameraTrack(stream.getVideoTracks()[0]);

    local.camera = stream;
    broadcastMeta();
    ensureTile('local:camera', { stream, ownerId: 'me', kind: 'camera', local: true });
    updateCameraMirror();
    for (const peer of peers.values()) addStreamToPeer(peer, 'camera', stream);
    updateButtons();
    renderPeople();
    populateCameras();
    mobileTip();
  }

  // Se a câmera cair enquanto o navegador está em segundo plano, volta sozinha ao reabrir
  function watchCameraTrack(vt) {
    if (!vt) return;
    vt.addEventListener('ended', () => {
      if (!local.camera || !local.camera.getTracks().includes(vt)) return;
      if (document.hidden) cameraNeedsRestart = true;
      else stopCamera();
    });
  }

  // Troca a imagem da câmera sem derrubar a transmissão (virar câmera, voltar do segundo plano)
  async function swapCameraTrack() {
    if (!local.camera) return;
    const stream = local.camera;
    const old = stream.getVideoTracks()[0];
    // iPhone e muitos Android não abrem duas câmeras ao mesmo tempo: fecha a antiga primeiro
    if (old) old.stop();
    let fresh;
    try {
      fresh = await navigator.mediaDevices.getUserMedia({ video: camVideoConstraints(true), audio: false });
    } catch (err) {
      toast('Não deu para abrir a câmera: ' + err.message, 'error');
      stopCamera();
      return;
    }
    const nt = fresh.getVideoTracks()[0];
    if (old) stream.removeTrack(old);
    stream.addTrack(nt);
    watchCameraTrack(nt);
    for (const peer of peers.values()) {
      for (const sender of peer.senders.camera) {
        if (sender.track === old || (sender.track && sender.track.readyState === 'ended') || !sender.track) {
          try { await sender.replaceTrack(nt); } catch (err) { console.warn(err); }
        }
      }
    }
    const t = tiles.get('local:camera');
    if (t) {
      t.video.srcObject = stream;
      t.video.play().catch(() => {});
    }
    updateCameraMirror();
    populateCameras();
  }

  async function flipCamera() {
    settings.camFacing = settings.camFacing === 'environment' ? 'user' : 'environment';
    settings.camDevice = ''; // a direção manda, não um dispositivo específico
    saveSettings();
    const sel = $('#camDevice');
    if (sel) sel.value = '';
    await swapCameraTrack();
  }

  function updateCameraMirror() {
    const t = tiles.get('local:camera');
    if (!t) return;
    const s = local.camera?.getVideoTracks()[0]?.getSettings() || {};
    const facing = s.facingMode || (settings.camDevice ? 'user' : settings.camFacing);
    t.el.classList.toggle('mirror', facing !== 'environment');
  }

  // ---------- Celular: dicas, tela acesa e volta do segundo plano ----------
  let tipShown = false;
  function mobileTip() {
    if (!IS_MOBILE || tipShown) return;
    tipShown = true;
    toast('Deixe o navegador aberto na frente: no celular, se você trocar de app ou bloquear a tela, a transmissão pausa.', null, 7000);
  }

  let wakeLock = null;
  async function updateWakeLock() {
    const want = !!(local.camera || local.screen) && document.visibilityState === 'visible';
    try {
      if (want && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
      } else if (!want && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {}
  }

  let cameraNeedsRestart = false;
  let screenStoppedWhileAway = false;
  let wentAwayWhileLive = false;
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
      if (local.camera || local.screen) wentAwayWhileLive = true;
      return;
    }
    // voltou para o navegador
    const camTrack = local.camera?.getVideoTracks()[0];
    if (local.camera && (cameraNeedsRestart || !camTrack || camTrack.readyState === 'ended')) {
      cameraNeedsRestart = false;
      await swapCameraTrack();
    }
    if (screenStoppedWhileAway) {
      screenStoppedWhileAway = false;
      toast('A transmissão da tela parou quando você saiu do navegador.', 'error', 8000, {
        label: 'Transmitir de novo',
        onClick: () => startScreen(),
      });
    } else if (wentAwayWhileLive && IS_MOBILE) {
      toast('Você voltou: a transmissão continua. Enquanto estava fora, seus amigos viram a imagem parada.');
    }
    wentAwayWhileLive = false;
    updateWakeLock();
  });

  function stopCamera() {
    if (!local.camera) return;
    const stream = local.camera;
    local.camera = null;
    stream.getTracks().forEach((t) => t.stop());
    for (const peer of peers.values()) removeStreamFromPeer(peer, 'camera');
    removeTile('local:camera');
    broadcastMeta();
    updateButtons();
    renderPeople();
  }

  // Muda a qualidade enquanto já está transmitindo
  async function applyQualityLive({ cameraDeviceChanged = false } = {}) {
    if (NATIVE && nativeLive) {
      NATIVE.updateQuality(settings.screenRes, settings.screenFps, String(screenKbps()));
    }
    if (local.screen) {
      const vt = local.screen.getVideoTracks()[0];
      if (vt) {
        vt.contentHint = settings.screenPriority === 'detail' ? 'detail' : 'motion';
        try { await vt.applyConstraints(screenVideoConstraints()); } catch (err) { console.warn(err); }
      }
    }
    if (local.camera) {
      if (cameraDeviceChanged) {
        stopCamera();
        await startCamera();
      } else {
        const vt = local.camera.getVideoTracks()[0];
        if (vt) {
          try { await vt.applyConstraints(camVideoConstraints(false)); } catch (err) { console.warn(err); }
        }
      }
    }
    for (const peer of peers.values()) {
      queueSenderParams(peer);
      applyPlayback(peer);
    }
  }

  // =========================================================
  // Quadros de vídeo (tiles)
  // =========================================================
  function btn(act, title, icon) {
    return `<button class="icon-btn" type="button" data-act="${act}" title="${title}" aria-label="${title}">${icon}</button>`;
  }

  function ensureTile(key, opts) {
    if (tiles.has(key)) return tiles.get(key);

    const el = document.createElement('div');
    el.className = 'tile';
    el.innerHTML = `
      <video autoplay playsinline></video>
      <div class="tile-placeholder"><div><strong>Destacado em outra janela</strong><br><span class="muted">Feche aquela janela para o vídeo voltar para cá.</span></div></div>
      <div class="tile-top"><span class="badge live">AO VIVO</span><span class="stats"></span></div>
      <div class="tile-bottom">
        <span class="label"></span>
        <div class="audio-ctl" hidden>
          <button class="icon-btn snd" type="button" data-act="mute" aria-label="Som"></button>
          <input type="range" class="vol" min="0" max="100" step="1" value="100" aria-label="Volume da transmissão">
        </div>
        <div class="actions">
          ${btn('focus', 'Focar / desfocar', ICON.focus)}
          ${btn('popout', 'Destacar em janela separada', ICON.popout)}
          ${btn('pip', 'Flutuar por cima de tudo', ICON.pip)}
          ${btn('fullscreen', 'Tela cheia', ICON.full)}
        </div>
      </div>`;

    const video = el.querySelector('video');
    const t = {
      key,
      el,
      video,
      stream: opts.stream,
      ownerId: opts.ownerId,
      kind: opts.kind,
      local: !!opts.local,
      popout: null,
      lastStats: null,
    };
    tiles.set(key, t);

    video.srcObject = opts.stream;
    t.userMuted = false;
    if (!t.local) video.volume = tileVolume(t);
    applyTileMute(t);
    playWithFallback(video);

    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      e.stopPropagation();
      tileAction(t, b.dataset.act);
    });
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.actions, .audio-ctl')) return;
      toggleFocus(key);
    });
    const vol = el.querySelector('.vol');
    vol.value = String(Math.round(video.volume * 100));
    vol.addEventListener('input', () => {
      video.volume = Number(vol.value) / 100;
      // mexer no volume desmuta (como no Discord)
      if (t.userMuted && video.volume > 0) t.userMuted = false;
      applyTileMute(t);
      saveTileVolume(t, video.volume);
      updateTileAudio(t);
    });
    // Se o som da transmissão chegar depois (ou sair), atualiza o controle
    opts.stream.addEventListener('addtrack', () => updateTileAudio(t));
    opts.stream.addEventListener('removetrack', () => updateTileAudio(t));

    $('#stage').append(el);
    updateTileLabel(t);
    updateTileAudio(t);
    updateLayout();
    return t;
  }

  function playWithFallback(video) {
    video.play().catch(() => {
      // O navegador bloqueou o som automático: toca mudo e libera no próximo clique
      video.muted = true;
      video.play().catch(() => {});
      toast('Clique em qualquer lugar da página para liberar o som.');
      document.addEventListener(
        'click',
        () => {
          for (const t of tiles.values()) applyTileMute(t);
          resumeAudio();
          for (const v of voices.values()) v.audio.play().catch(() => {});
        },
        { once: true }
      );
    });
  }

  function tileOwnerName(t) {
    if (t.local) return `${myName} (você)`;
    return peers.get(t.ownerId)?.name || '…';
  }
  function tileKindName(t) {
    return t.kind === 'screen' ? 'Tela' : t.kind === 'camera' ? 'Câmera' : 'Vídeo';
  }
  function tileTitle(t) {
    return `${tileOwnerName(t)} · ${tileKindName(t)} — Telão`;
  }

  function updateTileLabel(t) {
    t.el.querySelector('.label').textContent = `${tileOwnerName(t)} · ${tileKindName(t)}`;
    t.el.classList.toggle('camera', t.kind === 'camera');
    t.el.classList.toggle('screen', t.kind === 'screen');
    t.el.classList.toggle('mirror', t.local && t.kind === 'camera');
    try {
      if (t.popout && !t.popout.closed) t.popout.document.title = tileTitle(t);
    } catch {}
  }

  // ---------- Som de cada transmissão ----------
  const SND_ON = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
  const SND_OFF = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm18.7 3-2.5-2.5-1.4 1.4 2.5 2.5-2.5 2.5 1.4 1.4 2.5-2.5 2.5 2.5 1.4-1.4-2.5-2.5 2.5-2.5-1.4-1.4z" transform="translate(-2 0)"/></svg>';
  const SND_NONE = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm11.6 3.4 1.4-1.4M14 7l7 10" stroke="currentColor" stroke-width="2" fill="none"/><path d="M3 9v6h4l5 5V4L7 9z"/></svg>';

  function tileVolumeKey(t) {
    return `${peers.get(t.ownerId)?.name || '?'}:${t.kind || 'video'}`;
  }

  function tileVolume(t) {
    try {
      const v = JSON.parse(localStorage.getItem('telao.tileVolumes') || '{}')[tileVolumeKey(t)];
      return typeof v === 'number' ? v : 1;
    } catch {
      return 1;
    }
  }

  function saveTileVolume(t, v) {
    try {
      const all = JSON.parse(localStorage.getItem('telao.tileVolumes') || '{}');
      all[tileVolumeKey(t)] = v;
      localStorage.setItem('telao.tileVolumes', JSON.stringify(all));
    } catch {}
  }

  function applyTileMute(t) {
    t.video.muted = t.local || deafened || !!t.userMuted;
  }

  function updateTileAudio(t) {
    const ctl = t.el.querySelector('.audio-ctl');
    if (t.local) {
      ctl.hidden = true;
      return;
    }
    ctl.hidden = false;
    const hasAudio = t.stream.getAudioTracks().length > 0;
    const btnSnd = ctl.querySelector('.snd');
    const vol = ctl.querySelector('.vol');
    ctl.classList.toggle('no-audio', !hasAudio);
    vol.disabled = !hasAudio;
    btnSnd.disabled = !hasAudio;
    if (!hasAudio) {
      btnSnd.innerHTML = SND_NONE;
      btnSnd.title = 'Esta transmissão está sem áudio';
      vol.title = 'Esta transmissão está sem áudio';
      return;
    }
    const silent = t.userMuted || deafened || t.video.volume === 0;
    btnSnd.innerHTML = silent ? SND_OFF : SND_ON;
    btnSnd.title = deafened ? 'Você silenciou tudo (botão Ouvir)' : t.userMuted ? 'Ligar o som' : 'Tirar o som';
    vol.title = `Volume: ${Math.round(t.video.volume * 100)}%`;
  }

  function removeTile(key) {
    const t = tiles.get(key);
    if (!t) return;
    try { if (t.popout && !t.popout.closed) t.popout.close(); } catch {}
    if (pipKey === key && pipWindow) pipWindow.close();
    if (document.pictureInPictureElement === t.video) document.exitPictureInPicture().catch(() => {});
    t.video.srcObject = null;
    t.el.remove();
    tiles.delete(key);
    if (focusKey === key) focusKey = null;
    updateLayout();
  }

  function toggleFocus(key) {
    focusKey = focusKey === key ? null : key;
    updateLayout();
  }

  function updateLayout() {
    if (focusKey && !tiles.has(focusKey)) focusKey = null;
    const stage = $('#stage');
    stage.classList.toggle('has-focus', !!focusKey && tiles.size > 1);
    for (const t of tiles.values()) t.el.classList.toggle('focused', t.key === focusKey);
    // o quadro focado vai para o começo da grade
    const focused = focusKey && tiles.get(focusKey);
    const firstTile = stage.querySelector('.tile');
    if (focused && firstTile && firstTile !== focused.el) {
      stage.insertBefore(focused.el, firstTile);
    }
    $('#empty').hidden = tiles.size > 0;
  }

  function tileAction(t, act) {
    if (act === 'mute') {
      if (deafened) {
        toast('Você silenciou tudo. Clique em "Ouvir" na barra de baixo para voltar a ouvir.');
        return;
      }
      t.userMuted = !t.userMuted;
      // desmutar com o volume no zero: volta para um volume audível
      if (!t.userMuted && t.video.volume === 0) {
        t.video.volume = 0.5;
        t.el.querySelector('.vol').value = '50';
        saveTileVolume(t, 0.5);
      }
      applyTileMute(t);
      updateTileAudio(t);
      return;
    }
    if (act === 'focus') toggleFocus(t.key);
    else if (act === 'popout') popout(t);
    else if (act === 'pip') floatPip(t);
    else if (act === 'fullscreen') {
      if (document.fullscreenElement) document.exitFullscreen();
      else t.el.requestFullscreen?.().catch(() => {});
    }
  }

  function refreshPopped(t) {
    const popped = (t.popout && !t.popout.closed) || pipKey === t.key;
    t.el.classList.toggle('popped', !!popped);
  }

  // Monta uma janela só com o vídeo (usada pelo "Destacar" e pelo "Flutuar")
  function buildVideoWindow(w, t, { hint }) {
    const d = w.document;
    d.head.innerHTML = `<meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#000;overflow:hidden}
      video{width:100%;height:100%;object-fit:contain;display:block;background:#000}
      .hint{position:fixed;left:8px;bottom:8px;font:12px system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.6);padding:3px 8px;border-radius:6px;opacity:0;transition:opacity .2s}
      body:hover .hint{opacity:1}
    </style>`;
    d.title = tileTitle(t);
    d.body.innerHTML = '';
    const v = d.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    v.muted = true; // o som continua saindo pela janela principal (evita som duplicado)
    v.srcObject = t.stream;
    if (t.local && t.kind === 'camera') v.style.transform = 'scaleX(-1)';
    d.body.append(v);
    if (hint) {
      const h = d.createElement('div');
      h.className = 'hint';
      h.textContent = hint;
      d.body.append(h);
      v.addEventListener('dblclick', () => {
        if (d.fullscreenElement) d.exitFullscreen();
        else d.documentElement.requestFullscreen().catch(() => {});
      });
    }
    v.play().catch(() => {});
  }

  // Janela separada: dá para arrastar para qualquer lugar/monitor e redimensionar
  function popout(t) {
    if (t.popout && !t.popout.closed) {
      t.popout.focus();
      return;
    }
    const vw = t.video.videoWidth || 1280;
    const vh = t.video.videoHeight || 720;
    const width = Math.min(1100, Math.round(screen.availWidth * 0.6));
    const height = Math.round(width * (vh / vw));
    const w = window.open(
      '',
      'telao_' + t.key.replace(/\W/g, '_'),
      `popup=yes,width=${width},height=${height},left=${Math.round((screen.availWidth - width) / 2)},top=${Math.round((screen.availHeight - height) / 3)}`
    );
    if (!w) {
      toast('O navegador bloqueou a janela. Libere pop-ups para este site (ícone na barra de endereço) e tente de novo.', 'error');
      return;
    }
    buildVideoWindow(w, t, { hint: 'Duplo clique: tela cheia' });
    t.popout = w;
    refreshPopped(t);
    const timer = setInterval(() => {
      if (w.closed) {
        clearInterval(timer);
        if (t.popout === w) t.popout = null;
        refreshPopped(t);
      }
    }, 500);
  }

  // Janela flutuante: fica sempre por cima de tudo (até de jogos em janela)
  async function floatPip(t) {
    try {
      if ('documentPictureInPicture' in window) {
        if (pipWindow) {
          const wasThis = pipKey === t.key;
          pipWindow.close();
          if (wasThis) return;
        }
        const vw = t.video.videoWidth || 16;
        const vh = t.video.videoHeight || 9;
        const width = 480;
        const height = Math.round(width * (vh / vw));
        const w = await window.documentPictureInPicture.requestWindow({ width, height });
        pipWindow = w;
        pipKey = t.key;
        buildVideoWindow(w, t, { hint: null });
        refreshPopped(t);
        w.addEventListener('pagehide', () => {
          if (pipWindow === w) {
            pipWindow = null;
            pipKey = null;
          }
          refreshPopped(t);
        });
      } else if (document.pictureInPictureEnabled) {
        if (document.pictureInPictureElement === t.video) await document.exitPictureInPicture();
        else await t.video.requestPictureInPicture();
      } else {
        toast('Seu navegador não tem janela flutuante. Use Chrome ou Edge.', 'error');
      }
    } catch (err) {
      toast('Não deu para abrir a janela flutuante: ' + err.message, 'error');
    }
  }

  window.addEventListener('pagehide', () => {
    for (const t of tiles.values()) {
      try { if (t.popout && !t.popout.closed) t.popout.close(); } catch {}
    }
  });

  // =========================================================
  // Estatísticas (resolução, fps e Mbps reais de cada vídeo)
  // =========================================================
  const fmtMbps = (v) => `${v.toFixed(1).replace('.', ',')} Mbps`;
  const codecName = (report, codecId) => {
    const c = codecId && report.get(codecId);
    if (!c || !c.mimeType) return '';
    const n = c.mimeType.split('/')[1].toUpperCase();
    return CODEC_LABEL[n] || n;
  };
  const engine = (powerEfficient) => (powerEfficient === true ? 'GPU' : powerEfficient === false ? 'CPU' : '');

  // Lê os números de um RTCRtpSender/Receiver e calcula Mbps desde a última leitura
  async function readRtp(target, type, prev) {
    const report = await target.getStats();
    let rtp = null;
    report.forEach((s) => {
      if (s.type === type && s.kind === 'video') rtp = s;
    });
    if (!rtp) return null;
    const bytes = type === 'outbound-rtp' ? rtp.bytesSent : rtp.bytesReceived;
    let mbps = null;
    if (prev) {
      const dt = (rtp.timestamp - prev.timestamp) / 1000;
      if (dt > 0) mbps = ((bytes - prev.bytes) * 8) / dt / 1e6;
    }
    return { rtp, report, mbps, snap: { timestamp: rtp.timestamp, bytes } };
  }

  function setStats(t, parts, warn, title) {
    const el = t.el.querySelector('.stats');
    el.textContent = parts.filter(Boolean).join(' · ');
    el.classList.toggle('warn', !!warn);
    el.title = title || '';
  }

  async function updateStats() {
    for (const t of tiles.values()) {
      const vt = t.stream.getVideoTracks()[0];
      if (!vt) {
        setStats(t, []);
        continue;
      }
      try {
        if (t.local) {
          // Envio: pega a conexão com um amigo como amostra e o pior gargalo entre todos
          const senders = [];
          for (const peer of peers.values()) {
            const s = peer.pc.getSenders().find((x) => x.track === vt);
            if (s) senders.push(s);
          }
          if (!senders.length) {
            const s = vt.getSettings();
            setStats(t, [s.width && `${s.width}×${s.height}`, s.frameRate && `${Math.round(s.frameRate)} fps`, 'ninguém assistindo']);
            continue;
          }
          const r = await readRtp(senders[0], 'outbound-rtp', t.lastStats);
          if (!r) continue;
          t.lastStats = r.snap;
          let limit = r.rtp.qualityLimitationReason;
          for (const s of senders.slice(1)) {
            const o = await readRtp(s, 'outbound-rtp', null);
            const why = o && o.rtp.qualityLimitationReason;
            if (why === 'cpu' || (why === 'bandwidth' && limit !== 'cpu')) limit = why;
          }
          const warn = limit === 'cpu' ? 'limite: processador' : limit === 'bandwidth' ? 'limite: internet' : '';
          setStats(
            t,
            [
              r.rtp.frameWidth && `${r.rtp.frameWidth}×${r.rtp.frameHeight}`,
              r.rtp.framesPerSecond != null && `${Math.round(r.rtp.framesPerSecond)} fps`,
              r.mbps != null && fmtMbps(r.mbps) + (senders.length > 1 ? ` × ${senders.length}` : ''),
              [codecName(r.report, r.rtp.codecId), engine(r.rtp.powerEfficientEncoder)].filter(Boolean).join(' '),
              warn,
            ],
            warn,
            r.rtp.encoderImplementation ? `Codificador: ${r.rtp.encoderImplementation}` : ''
          );
        } else {
          const peer = peers.get(t.ownerId);
          if (!peer) continue;
          const receiver = peer.pc.getReceivers().find((x) => x.track && x.track.id === vt.id);
          if (!receiver) continue;
          const r = await readRtp(receiver, 'inbound-rtp', t.lastStats);
          if (!r) continue;
          t.lastStats = r.snap;
          setStats(
            t,
            [
              r.rtp.frameWidth && `${r.rtp.frameWidth}×${r.rtp.frameHeight}`,
              r.rtp.framesPerSecond != null && `${Math.round(r.rtp.framesPerSecond)} fps`,
              r.mbps != null && fmtMbps(r.mbps),
              codecName(r.report, r.rtp.codecId),
            ],
            false,
            r.rtp.decoderImplementation ? `Decodificador: ${r.rtp.decoderImplementation}` : ''
          );
        }
      } catch {}
    }
  }
  setInterval(updateStats, 1500);

  // =========================================================
  // Pessoas na sala
  // =========================================================
  function colorFor(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 70% 62%)`;
  }

  const MIC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z"/></svg>';
  const MIC_OFF_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 11h-2c0 .7-.1 1.3-.4 1.9l1.5 1.5A7 7 0 0 0 19 11zM15 11V5a3 3 0 0 0-5.9-.8L15 10.1zM4.3 3 3 4.3l6 6V11a3 3 0 0 0 4.4 2.7l1.6 1.6A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 3.4-1.3l3.3 3.3 1.3-1.3z"/></svg>';

  function personChip({ id, name, state, isMe, live, mic }) {
    const el = document.createElement('div');
    el.className = 'person' + (isMe ? ' me' : '');
    el.dataset.id = id;
    const av = document.createElement('span');
    av.className = 'avatar';
    av.style.background = colorFor(name);
    av.textContent = (name.trim()[0] || '?').toUpperCase();
    const label = document.createElement('span');
    label.textContent = isMe ? `${name} (você)` : name;
    el.append(av, label);
    if (mic) {
      const m = document.createElement('span');
      m.className = 'mic-state' + (mic === 'muted' ? ' muted' : '');
      m.title = mic === 'muted' ? 'Microfone mutado' : 'Na voz';
      m.innerHTML = mic === 'muted' ? MIC_OFF_ICON : MIC_ICON;
      el.append(m);
    }
    const l = levels.get(id);
    if (l && l.speaking) el.classList.add('speaking');
    if (!isMe && mic) {
      el.classList.add('clickable');
      el.title = 'Clique para ajustar o volume';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openVolumePopover(id, el);
      });
    }
    if (live) {
      const b = document.createElement('span');
      b.className = 'badge live';
      b.textContent = 'AO VIVO';
      el.append(b);
    }
    if (!isMe) {
      const dot = document.createElement('span');
      const cls = state === 'connected' ? 'connected' : state === 'failed' ? 'failed' : state === 'new' ? 'idle' : '';
      dot.className = 'state ' + cls;
      dot.title = {
        new: 'Na sala (ainda sem vídeo trocado)',
        connecting: 'Conectando…',
        connected: 'Conectado',
        disconnected: 'Conexão instável',
        failed: 'Falhou ao conectar',
      }[state] || state;
      el.append(dot);
    }
    return el;
  }

  function micStateOf(meta) {
    const kinds = Object.values(meta || {});
    if (kinds.includes('mic')) return 'on';
    if (kinds.includes('mic-muted')) return 'muted';
    return null;
  }

  function renderPeople() {
    const box = $('#people');
    box.innerHTML = '';
    box.append(personChip({
      id: 'me',
      name: myName,
      isMe: true,
      live: !!(local.screen || local.camera || nativeLive),
      mic: local.mic ? (local.mic.muted ? 'muted' : 'on') : null,
    }));
    for (const p of peers.values()) {
      const kinds = Object.values(p.meta || {});
      box.append(personChip({
        id: p.id,
        name: p.name,
        state: p.pc.connectionState,
        isMe: false,
        live: kinds.includes('screen') || kinds.includes('camera'),
        mic: micStateOf(p.meta),
      }));
    }
  }

  // Volume da voz de cada amigo (fica salvo pelo nome)
  function openVolumePopover(peerId, anchor) {
    closeVolumePopover();
    const peer = peers.get(peerId);
    if (!peer) return;
    const pop = document.createElement('div');
    pop.className = 'vol-pop';
    pop.id = 'volPop';
    const title = document.createElement('div');
    title.className = 'vol-pop-title';
    title.textContent = `Volume de ${peer.name}`;
    const row = document.createElement('div');
    row.className = 'vol-pop-row';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.value = String(Math.round(voiceVolume(peer.name) * 100));
    const val = document.createElement('span');
    val.textContent = `${range.value}%`;
    range.addEventListener('input', () => {
      const v = Number(range.value) / 100;
      val.textContent = `${range.value}%`;
      saveVoiceVolume(peer.name, v);
      for (const voice of voices.values()) if (voice.peerId === peerId) voice.audio.volume = v;
    });
    row.append(range, val);
    pop.append(title, row);
    pop.addEventListener('click', (e) => e.stopPropagation());
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.left = `${Math.max(16, Math.min(r.left, window.innerWidth - pop.offsetWidth - 16))}px`;
  }

  function closeVolumePopover() {
    const p = document.getElementById('volPop');
    if (p) p.remove();
  }
  document.addEventListener('click', closeVolumePopover);

  // =========================================================
  // Controles
  // =========================================================
  function updateButtons() {
    const cam = $('#btnCam');
    cam.classList.toggle('on', !!local.camera);
    cam.querySelector('span').textContent = local.camera ? 'Desligar câmera' : 'Câmera';
    const scr = $('#btnScreen');
    const screenOn = !!(local.screen || nativeLive);
    scr.classList.toggle('on', screenOn);
    scr.classList.toggle('unavailable', !canShareScreen() && !screenOn);
    scr.title = canShareScreen() ? 'Transmitir tela' : 'Este aparelho não deixa transmitir a tela pelo navegador';
    scr.querySelector('span').textContent = screenOn ? 'Parar transmissão' : 'Transmitir tela';
    // Virar câmera: só no celular, com a câmera ligada
    $('#btnFlip').hidden = !(IS_MOBILE && local.camera);

    const mic = $('#btnMic');
    const micOn = !!(local.mic && !local.mic.muted);
    mic.classList.toggle('on', micOn);
    mic.classList.toggle('muted', !!(local.mic && local.mic.muted));
    mic.querySelector('.ico').innerHTML = local.mic && local.mic.muted ? MIC_OFF_ICON : MIC_ICON;
    mic.querySelector('span').textContent = !local.mic ? 'Entrar na voz' : micOn ? 'Mutar' : 'Desmutar';
    mic.title = !local.mic ? 'Entrar na voz (liga o microfone)' : micOn ? 'Mutar o microfone (M)' : 'Desmutar o microfone (M)';
    const deaf = $('#btnDeafen');
    deaf.classList.toggle('muted', deafened);
    deaf.querySelector('span').textContent = deafened ? 'Ouvir' : 'Silenciar';
    deaf.title = deafened ? 'Voltar a ouvir todo mundo' : 'Parar de ouvir todo mundo';
    updateWakeLock();
  }

  $('#btnMic').addEventListener('click', () => {
    if (!local.mic) joinVoice();
    else setMicMuted(!local.mic.muted);
  });
  $('#btnDeafen').addEventListener('click', () => setDeafened(!deafened));
  // Atalho: M muta/desmuta (fora de campos de texto)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'm' && e.key !== 'M') return;
    if (e.ctrlKey || e.metaKey || e.altKey || $('#app').hidden) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (!local.mic) joinVoice();
    else setMicMuted(!local.mic.muted);
  });

  $('#btnCam').addEventListener('click', () => (local.camera ? stopCamera() : startCamera()));
  $('#btnFlip').addEventListener('click', () => flipCamera());
  $('#btnScreen').addEventListener('click', () => (local.screen || nativeLive ? stopScreen() : startScreen()));
  $('#btnLeave').addEventListener('click', () => {
    leaving = true;
    clearTimeout(reconnectTimer);
    stopScreen();
    stopCamera();
    leaveVoice();
    if (ws) ws.close();
    location.reload();
  });

  $('#copyLink').addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}?sala=${encodeURIComponent(room)}`;
    if (NATIVE && NATIVE.share) {
      NATIVE.share(link);
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copiado! Mande para os amigos.');
    } catch {
      window.prompt('Copie o link:', link);
    }
  });

  // Painel de qualidade
  const panel = $('#qualityPanel');
  $('#btnQuality').addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    $('#btnQuality').classList.toggle('on', !panel.hidden);
    if (!panel.hidden) {
      populateCameras();
      populateMics();
    }
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !e.target.closest('#btnQuality')) {
      panel.hidden = true;
      $('#btnQuality').classList.remove('on');
    }
  });

  let qualityPanelReady = false;
  function initQualityPanel() {
    if (qualityPanelReady) return;
    qualityPanelReady = true;
    const selects = ['screenRes', 'screenFps', 'screenBitrate', 'screenPriority', 'camRes', 'camFps', 'camDevice', 'codec', 'playback'];
    for (const id of selects) {
      const el = $('#' + id);
      el.value = settings[id];
      if (el.value !== settings[id] && id !== 'camDevice') el.value = DEFAULTS[id];
      el.addEventListener('change', () => {
        const deviceChanged = id === 'camDevice' && settings.camDevice !== el.value;
        settings[id] = el.value;
        saveSettings();
        applyQualityLive({ cameraDeviceChanged: deviceChanged });
      });
    }
    const audio = $('#screenAudio');
    audio.checked = !!settings.screenAudio;
    audio.addEventListener('change', () => {
      settings.screenAudio = audio.checked;
      saveSettings();
    });

    // Voz: microfone e redução de ruído
    const micSel = $('#micDevice');
    micSel.value = settings.micDevice || '';
    micSel.addEventListener('change', () => {
      settings.micDevice = micSel.value;
      saveSettings();
      reopenMic();
    });
    const ns = $('#noiseSuppression');
    ns.checked = settings.noiseSuppression !== false;
    ns.addEventListener('change', () => {
      settings.noiseSuppression = ns.checked;
      saveSettings();
      reopenMic();
    });
  }

  async function populateMics() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      const sel = $('#micDevice');
      sel.innerHTML = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = 'Padrão';
      sel.append(def);
      devices.forEach((d, i) => {
        if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') return;
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Microfone ${i + 1}`;
        sel.append(o);
      });
      sel.value = settings.micDevice || '';
      if (sel.value !== (settings.micDevice || '')) sel.value = '';
    } catch {}
  }

  async function populateCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const sel = $('#camDevice');
      sel.innerHTML = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = 'Padrão';
      sel.append(def);
      devices.forEach((d, i) => {
        if (!d.deviceId) return;
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Câmera ${i + 1}`;
        sel.append(o);
      });
      sel.value = settings.camDevice;
      if (sel.value !== settings.camDevice) sel.value = '';
    } catch {}
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      populateCameras();
      populateMics();
    });
  }

  // Atalho para testes/depuração no console
  // =========================================================
  // Versão nova do Telão
  // Confere de tempos em tempos se os arquivos do site mudaram. Se mudaram, avisa
  // (sem recarregar sozinho, para não derrubar ninguém no meio da transmissão).
  // =========================================================
  const VERSION_FILES = ['app.js', 'index.html', 'style.css'];
  let loadedVersion = null;
  let updateShown = false;

  function hashText(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  async function siteVersion() {
    const base = location.pathname.replace(/[^/]*$/, '');
    const parts = await Promise.all(
      VERSION_FILES.map((f) =>
        fetch(`${base}${f}?v=${Date.now()}`, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
      )
    );
    return hashText(parts.join('\n'));
  }

  async function checkVersion() {
    if (updateShown) return true;
    try {
      const v = await siteVersion();
      if (!loadedVersion) {
        loadedVersion = v;
        return false;
      }
      if (v !== loadedVersion) {
        showUpdateBar();
        return true;
      }
    } catch {} // sem internet agora: tenta de novo depois
    return false;
  }

  function showUpdateBar() {
    if (updateShown) return;
    updateShown = true;
    const bar = document.createElement('div');
    bar.className = 'update-bar';
    bar.id = 'updateBar';
    const text = document.createElement('span');
    text.textContent = 'Saiu uma versão nova do Telão. Atualize para continuar se entendendo com os amigos.';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn primary small';
    go.textContent = 'Atualizar';
    go.addEventListener('click', updateNow);
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'btn ghost small';
    later.textContent = 'Depois';
    later.addEventListener('click', () => bar.remove());
    bar.append(text, go, later);
    document.body.append(bar);
  }

  // Recarrega e volta sozinho para a mesma sala (e para a voz, se estava nela)
  function updateNow() {
    try {
      if (!$('#app').hidden) {
        sessionStorage.setItem('telao.autojoin', '1');
        if (local.mic && !local.mic.muted) sessionStorage.setItem('telao.rejoinVoice', '1');
      }
    } catch {}
    leaving = true;
    try { if (ws) ws.close(); } catch {}
    location.reload();
  }

  // Primeira leitura logo ao abrir; depois a cada 3 minutos e quando a pessoa volta para a aba
  checkVersion();
  setInterval(checkVersion, 3 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkVersion();
  });

  // Voltando de uma atualização: entra de novo na mesma sala
  try {
    if (sessionStorage.getItem('telao.autojoin') && $('#nameInput').value.trim() && params.get('sala')) {
      sessionStorage.removeItem('telao.autojoin');
      const rejoinVoice = sessionStorage.getItem('telao.rejoinVoice');
      sessionStorage.removeItem('telao.rejoinVoice');
      $('#joinForm').requestSubmit();
      toast('Telão atualizado!');
      if (rejoinVoice) setTimeout(() => { if (!local.mic) joinVoice(); }, 800);
    }
  } catch {}

  window.telao = { peers, tiles, local, settings, voices, levels, checkVersion, codecs: () => ({ autoCodec, gpuCodecs }) };
})();
