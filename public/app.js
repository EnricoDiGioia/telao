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
  const local = { screen: null, camera: null }; // MediaStreams que EU estou enviando
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
    wsSend({ type: 'meta', name: myName, streams });
  }

  function applyMeta(peer, streams, name) {
    if (name) peer.name = name;
    peer.meta = streams;
    for (const [key, t] of [...tiles]) {
      if (t.ownerId !== peer.id) continue;
      if (!(t.stream.id in streams)) {
        removeTile(key);
      } else {
        t.kind = streams[t.stream.id];
        updateTileLabel(t);
      }
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
      senders: { screen: [], camera: [] },
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
    renderPeople();
  }

  function addStreamToPeer(peer, kind, stream) {
    peer.senders[kind] = stream.getTracks().map((track) => peer.pc.addTrack(track, stream));
  }

  function removeStreamFromPeer(peer, kind) {
    for (const sender of peer.senders[kind]) {
      try { peer.pc.removeTrack(sender); } catch {}
    }
    peer.senders[kind] = [];
  }

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
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
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
        <div class="actions">
          <input type="range" class="vol" min="0" max="1" step="0.05" value="1" title="Volume" aria-label="Volume" hidden>
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
    if (t.local) video.muted = true;
    playWithFallback(video);

    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      e.stopPropagation();
      tileAction(t, b.dataset.act);
    });
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.actions')) return;
      toggleFocus(key);
    });
    el.querySelector('.vol').addEventListener('input', (e) => {
      video.volume = Number(e.target.value);
    });

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
          for (const t of tiles.values()) if (!t.local) t.video.muted = false;
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

  function updateTileAudio(t) {
    const hasAudio = !t.local && t.stream.getAudioTracks().length > 0;
    t.el.querySelector('.vol').hidden = !hasAudio;
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

  function personChip(name, state, isMe, live) {
    const el = document.createElement('div');
    el.className = 'person' + (isMe ? ' me' : '');
    const av = document.createElement('span');
    av.className = 'avatar';
    av.style.background = colorFor(name);
    av.textContent = (name.trim()[0] || '?').toUpperCase();
    const label = document.createElement('span');
    label.textContent = isMe ? `${name} (você)` : name;
    el.append(av, label);
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

  function renderPeople() {
    const box = $('#people');
    box.innerHTML = '';
    box.append(personChip(myName, null, true, !!(local.screen || local.camera || nativeLive)));
    for (const p of peers.values()) {
      box.append(personChip(p.name, p.pc.connectionState, false, Object.keys(p.meta || {}).length > 0));
    }
  }

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
    updateWakeLock();
  }

  $('#btnCam').addEventListener('click', () => (local.camera ? stopCamera() : startCamera()));
  $('#btnFlip').addEventListener('click', () => flipCamera());
  $('#btnScreen').addEventListener('click', () => (local.screen || nativeLive ? stopScreen() : startScreen()));
  $('#btnLeave').addEventListener('click', () => {
    leaving = true;
    clearTimeout(reconnectTimer);
    stopScreen();
    stopCamera();
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
    if (!panel.hidden) populateCameras();
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
    navigator.mediaDevices.addEventListener('devicechange', populateCameras);
  }

  // Atalho para testes/depuração no console
  window.telao = { peers, tiles, local, settings, codecs: () => ({ autoCodec, gpuCodecs }) };
})();
