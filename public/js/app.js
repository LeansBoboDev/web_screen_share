import { Net } from './net.js';
import { Streamer } from './streamer.js';
import { Player } from './player.js';

const $ = (id) => document.getElementById(id);

const el = {
  landing: $('landing'),
  landingAlert: $('landing-alert'),
  landingSecurity: $('landing-security'),
  nameInput: $('name-input'),
  roomInput: $('room-input'),
  chkAudio: $('chk-audio'),
  chkMic: $('chk-mic'),
  btnShare: $('btn-share'),
  btnShare2: $('btn-share-2'),
  btnWatch: $('btn-watch'),
  btnNewRoom: $('btn-new-room'),
  btnCopyLink: $('btn-copy-link'),
  btnCopyLink2: $('btn-copy-link-2'),

  room: $('room'),
  statusPill: $('status-pill'),
  roomLabel: $('room-label'),
  peerCount: $('peer-count'),
  btnLeave: $('btn-leave'),

  videoWrap: $('video-wrap'),
  video: $('video'),
  preview: $('preview'),
  placeholder: $('placeholder'),
  placeholderTitle: $('placeholder-title'),
  placeholderText: $('placeholder-text'),
  overlayBar: $('overlay-bar'),
  overlayName: $('overlay-name'),
  overlayRes: $('overlay-res'),
  btnPlayOverlay: $('btn-play-overlay'),

  broadcastPanel: $('broadcast-panel'),
  broadcastWarning: $('broadcast-warning'),
  ctlMic: $('ctl-mic'),
  ctlAudio: $('ctl-audio'),
  btnChangeSource: $('btn-change-source'),
  btnStopShare: $('btn-stop-share'),

  watchPanel: $('watch-panel'),
  btnSnapshot: $('btn-snapshot'),
  btnFullscreen: $('btn-fullscreen'),
  btnRetry: $('btn-retry'),

  stats: $('stats'),
  peerBadge: $('peer-badge'),
  peerList: $('peer-list'),
  chatList: $('chat-list'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),
};

const net = new Net();
const streamer = new Streamer();
const player = new Player(el.video);

const state = {
  name: '',
  room: 'principal',
  role: 'viewer',
  selfId: null,
  peers: new Map(),
  broadcaster: null,
  epoch: null,
  mimeType: null,
  announced: false,
  waitingInit: false,
  retrying: false,
  resyncing: false,
  lastResyncAt: 0,
  selfStopped: false,
  configuredAt: 0,
  lastBytes: 0,
  lastSent: 0,
  sentBytes: 0,
  lastSample: performance.now(),
};

// ------------------------------------------------------------------ salas

const ROOM_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

function sanitizeRoom(value) {
  const clean = String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 32);
  return ROOM_PATTERN.test(clean) ? clean : 'principal';
}

function randomRoom() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function roomUrl() {
  const url = new URL(location.href);
  url.searchParams.set('room', state.room);
  return url.toString();
}

function setRoom(value) {
  state.room = sanitizeRoom(value);
  el.roomInput.value = state.room;
  el.roomLabel.textContent = `sala: ${state.room}`;
  const url = new URL(location.href);
  url.searchParams.set('room', state.room);
  history.replaceState(null, '', url);
}

async function copyLink() {
  const url = roomUrl();
  try {
    await navigator.clipboard.writeText(url);
    flash('Link copiado!');
  } catch {
    const helper = document.createElement('textarea');
    helper.value = url;
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
    flash('Link copiado!');
  }
}

// ------------------------------------------------------------------- UI

function flash(text) {
  const item = document.createElement('li');
  item.className = 'chat--sys';
  item.textContent = text;
  el.chatList.appendChild(item);
  el.chatList.scrollTop = el.chatList.scrollHeight;
}

function landingError(message) {
  el.landingAlert.hidden = false;
  el.landingAlert.textContent = message;
}

function clearLandingError() {
  el.landingAlert.hidden = true;
  el.landingAlert.textContent = '';
}

function setStatus(text, kind = 'idle') {
  el.statusPill.textContent = text;
  el.statusPill.className = `pill pill--${kind}`;
}

function setPlaceholder(title, text) {
  el.placeholder.hidden = false;
  el.placeholderTitle.textContent = title;
  el.placeholderText.textContent = text;
  el.videoWrap.classList.remove('has-video');
  el.videoWrap.classList.remove('is-sharing');
}

function showVideo() {
  el.placeholder.hidden = true;
  el.videoWrap.classList.add('has-video');
  el.videoWrap.classList.remove('is-sharing');
}

/**
 * Previa local do que esta sendo compartilhado. Sem isso o transmissor fica
 * olhando para um "carregando" eterno, ja que a tela dele nao volta pelo
 * servidor.
 */
function showPreview() {
  const stream = streamer.displayStream;
  el.preview.srcObject = stream ?? null;
  if (!stream) return;
  el.preview.play?.().catch(() => {});
  el.placeholder.hidden = true;
  el.videoWrap.classList.add('is-sharing');
  el.videoWrap.classList.remove('has-video');
}

function hidePreview() {
  el.preview.srcObject = null;
  el.videoWrap.classList.remove('is-sharing');
}

function renderPeers() {
  const list = [...state.peers.values()].sort((a, b) => {
    if (a.id === state.broadcaster?.id) return -1;
    if (b.id === state.broadcaster?.id) return 1;
    return a.name.localeCompare(b.name);
  });

  el.peerList.replaceChildren();
  for (const peer of list) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    if (peer.id === state.broadcaster?.id) dot.classList.add('dot--live');
    else if (peer.id === state.selfId) dot.classList.add('dot--me');

    const name = document.createElement('strong');
    name.textContent = peer.id === state.selfId ? `${peer.name} (voce)` : peer.name;

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = peer.id === state.broadcaster?.id ? 'compartilhando' : '';

    li.append(dot, name, tag);
    el.peerList.appendChild(li);
  }

  const count = list.length;
  el.peerCount.textContent = `${count} ${count === 1 ? 'pessoa' : 'pessoas'}`;
  el.peerBadge.textContent = String(count);
}

function renderRole() {
  const broadcasting = state.role === 'broadcaster';
  el.broadcastPanel.hidden = !broadcasting;
  el.watchPanel.hidden = broadcasting;
  if (broadcasting) {
    if (streamer.displayStream) {
      showPreview();
    } else {
      setPlaceholder('Preparando a captura...', 'Conectando ao seletor de tela do navegador.');
    }
  } else {
    hidePreview();
  }
}

// ------------------------------------------------------------------ entrada

async function enterAsBroadcaster() {
  const name = el.nameInput.value.trim();
  if (!name) {
    landingError('Digite um nome para entrar na sala.');
    el.nameInput.focus();
    return;
  }
  clearLandingError();

  try {
    // Precisa acontecer dentro do gesto do usuario (seletor do navegador).
    await streamer.open({
      wantAudio: el.chkAudio.checked,
      wantMic: el.chkMic.checked,
    });
  } catch (err) {
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
      landingError('Compartilhamento cancelado.');
    } else {
      landingError(err?.message ?? 'Nao foi possivel acessar a tela.');
    }
    return;
  }

  streamer.setSystemAudio(el.chkAudio.checked && Boolean(streamer.systemTrack));
  state.role = 'broadcaster';
  state.name = name;
  setRoom(el.roomInput.value);
  openRoom();
  beginBroadcast();
}

/**
 * Assume a transmissao a partir de dentro da sala (quem ja estava
 * assistindo tambem pode passar a compartilhar a tela).
 */
async function shareFromRoom() {
  if (state.role === 'broadcaster') return;
  try {
    await streamer.open({
      wantAudio: el.chkAudio.checked,
      wantMic: el.chkMic.checked,
    });
  } catch (err) {
    flash(
      err?.name === 'NotAllowedError' || err?.name === 'AbortError'
        ? 'Compartilhamento cancelado.'
        : `Nao foi possivel acessar a tela: ${err?.message ?? 'erro desconhecido'}`
    );
    return;
  }

  streamer.setSystemAudio(el.chkAudio.checked && Boolean(streamer.systemTrack));
  state.role = 'broadcaster';
  state.selfStopped = false;
  player.clear(); // deixa de exibir a transmissao que estava assistindo
  renderRole();
  beginBroadcast();
}

function enterAsViewer() {
  const name = el.nameInput.value.trim();
  if (!name) {
    landingError('Digite um nome para entrar na sala.');
    el.nameInput.focus();
    return;
  }
  clearLandingError();
  state.role = 'viewer';
  state.name = name;
  setRoom(el.roomInput.value);
  openRoom();
}

function openRoom() {
  el.landing.hidden = true;
  el.room.hidden = false;
  setStatus('Conectando...', 'idle');
  setPlaceholder('Conectando a sala...', 'Estabelecendo conexao com o servidor.');
  renderRole();
  net.connect();
}

function leaveRoom() {
  streamer.stop();
  player.clear();
  net.close();
  state.role = 'viewer';
  state.announced = false;
  state.selfStopped = false;
  state.waitingInit = false;
  state.retrying = false;
  state.peers.clear();
  state.broadcaster = null;
  state.selfId = null;
  state.epoch = null;
  state.mimeType = null;
  el.room.hidden = true;
  el.landing.hidden = false;
  setStatus('Conectando...', 'idle');
}

// -------------------------------------------------------------- transmissao

function announceBroadcast() {
  if (state.announced || !streamer.mimeType) return;
  if (net.state !== 'online') return;
  net.send({ type: 'start', mimeType: streamer.mimeType });
  state.announced = true;
}

/**
 * Anuncia a transmissao e garante que o gravador esteja rodando.
 * A ordem importa: o 'start' precisa chegar ao servidor antes do
 * primeiro chunk da gravacao.
 */
function beginBroadcast() {
  if (net.state !== 'online') return;
  announceBroadcast();
  if (streamer.isRecording) streamer.restart();
  else streamer.startRecording();
}

function notifyRestart() {
  net.send({ type: 'restart', mimeType: streamer.mimeType });
}

function stopSharing() {
  streamer.stop();
  net.send({ type: 'stop' });
  state.role = 'viewer';
  state.announced = false;
  state.broadcaster = null;
  state.selfStopped = true;
  state.waitingInit = false;
  state.retrying = false;
  player.clear();
  renderRole();
  renderPeers();
  setPlaceholder('Voce parou de compartilhar', 'Aguardando outro transmissor.');
  setStatus('Conectado', 'ok');
}

async function changeSource() {
  try {
    await streamer.open({
      wantAudio: el.chkAudio.checked,
      wantMic: el.chkMic.checked,
    });
  } catch (err) {
    flash(err?.name === 'NotAllowedError' ? 'Troca de fonte cancelada.' : `Troca de fonte falhou: ${err?.message}`);
    return;
  }
  streamer.setSystemAudio(el.chkAudio.checked && Boolean(streamer.systemTrack));
  el.ctlAudio.checked = streamer.systemTrack ? el.chkAudio.checked : false;
  el.ctlAudio.disabled = !streamer.systemTrack;
  showPreview(); // a previa local passa a mostrar a nova fonte

  // A nova epoch precisa ser enviada ANTES do primeiro chunk novo.
  notifyRestart();
  streamer.startRecording();
  flash('Fonte da tela trocada.');
}

// ------------------------------------------------------------------- chat

el.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  net.send({ type: 'chat', text });
  el.chatInput.value = '';
});

// -------------------------------------------------------------- eventos UI

el.btnShare.addEventListener('click', enterAsBroadcaster);
el.btnShare2.addEventListener('click', shareFromRoom);
el.btnWatch.addEventListener('click', enterAsViewer);
el.btnNewRoom.addEventListener('click', () => {
  el.roomInput.value = randomRoom();
  setRoom(el.roomInput.value);
});
el.btnCopyLink.addEventListener('click', copyLink);
el.btnCopyLink2.addEventListener('click', copyLink);
el.btnLeave.addEventListener('click', leaveRoom);
el.nameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') enterAsViewer();
});
el.roomInput.addEventListener('change', () => setRoom(el.roomInput.value));

el.btnStopShare.addEventListener('click', stopSharing);
el.btnChangeSource.addEventListener('click', changeSource);

el.ctlMic.addEventListener('change', async () => {
  if (state.role !== 'broadcaster') return;
  if (el.ctlMic.checked) {
    const audioBefore = streamer.recordAudioTrack();
    try {
      await streamer.enableMic();
    } catch {
      el.ctlMic.checked = false;
      flash('Nao foi possivel acessar o microfone.');
      return;
    }
    if (streamer.recordAudioTrack() !== audioBefore) {
      // A track de audio gravada mudou (entrou o microfone ou a mixagem):
      // o gravador precisa ser refeito.
      streamer.restart();
    }
  } else {
    streamer.disableMic();
  }
});

el.ctlAudio.addEventListener('change', () => {
  if (state.role !== 'broadcaster') return;
  streamer.setSystemAudio(el.ctlAudio.checked);
});

el.btnPlayOverlay.addEventListener('click', () => {
  player.video.play().catch(() => {});
  el.btnPlayOverlay.hidden = true;
});

el.btnFullscreen.addEventListener('click', () => {
  const target = el.videoWrap;
  if (document.fullscreenElement) document.exitFullscreen?.();
  else target.requestFullscreen?.().catch(() => {});
});

/**
 * Pede um fluxo de video novo.
 *
 * - Se quem compartilha somos nos mesmos, reiniciamos o gravador local (o
 *   epoch novo e announceado por nos).
 * - Se nao ha transmissor nenhum, avisa na hora em vez de esperar por algo
 *   que nunca vai acontecer.
 * - Caso contrario, pede ao transmissor que reenvie o cabecalho do stream.
 */
function requestFreshStream() {
  if (state.role === 'broadcaster') {
    setPlaceholder('Reconectando...', 'Reiniciando a gravacao para reenviar o inicio do video.');
    if (streamer.isRecording) {
      streamer.restart(); // dispara 'restart' -> novo epoch no servidor
    } else {
      notifyRestart();
      streamer.startRecording();
    }
    return;
  }

  if (!state.broadcaster) {
    state.retrying = false;
    state.waitingInit = false;
    setPlaceholder(
      'Ninguem esta transmitindo',
      'Aguardando alguem compartilhar a tela. Voce pode assumir a transmissao abaixo.'
    );
    return;
  }

  net.send({ type: 'need-init' });
}

/**
 * Pede um fluxo novo ao transmissor porque o que chegou aqui esta quebrado.
 *
 * Um stream de video com "buracos" (chunks perdidos, fila estourada) nao se
 * recupera sozinho: o parser de WebM para de avancar e o video fica
 * congelado para sempre. A unica saida e um epoch novo, com o cabecalho
 * (init segment) do fluxo recomecando do zero.
 */
function requestResync(reason, title = 'Sincronizando o video...') {
  if (state.role !== 'viewer') return;
  if (!state.broadcaster) return;
  const now = Date.now();
  if (now - state.lastResyncAt < 6000) return; // evita pedir em loop
  state.lastResyncAt = now;
  state.resyncing = true;
  state.waitingInit = true;
  state.configuredAt = performance.now();
  setPlaceholder(
    title,
    reason ?? 'O fluxo chegou quebrado; pedindo um novo inicio de video ao transmissor.'
  );
  net.send({ type: 'need-init' });
}

/**
 * Avisa o transmissor que a captura parou de produzir dados (acontece quando a
 * janela e minimizada ou quando o sistema dorme). Sem esse aviso o
 * espectador so veria um video congelado, sem nenhuma explicacao.
 */
function renderBroadcastWarning() {
  const stalled = state.role === 'broadcaster' && streamer.stalled;
  if (!stalled) {
    el.broadcastWarning.hidden = true;
    return;
  }
  el.broadcastWarning.hidden = false;
  el.broadcastWarning.textContent =
    'A captura parou de enviar dados. Se esta aba estiver em segundo plano, ' +
    'clique nela para voltar a transmitir.';
}

el.btnRetry.addEventListener('click', () => {
  el.btnRetry.hidden = true;
  state.retrying = true;
  state.waitingInit = false;
  state.configuredAt = performance.now();
  setPlaceholder('Reconectando...', 'Pedindo um novo fluxo de video ao transmissor.');
  requestFreshStream();
});

el.btnSnapshot.addEventListener('click', () => {
  const video = player.video;
  if (!video.videoWidth) {
    flash('Nao ha imagem para capturar.');
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `captura-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
});

// ------------------------------------------------------------- streamer/player

streamer.addEventListener('chunk', (event) => {
  state.sentBytes += event.detail.byteLength ?? 0;
  net.sendBinary(event.detail);
});

streamer.addEventListener('started', (event) => {
  state.mimeType = event.detail.mimeType;
  el.ctlAudio.disabled = !streamer.systemTrack;
  el.ctlAudio.checked = Boolean(streamer.systemTrack) && el.chkAudio.checked;
  el.ctlMic.checked = Boolean(streamer.micTrack);
  announceBroadcast();
});

streamer.addEventListener('restart', () => {
  notifyRestart();
});

streamer.addEventListener('ended', () => {
  if (state.role === 'broadcaster') stopSharing();
});

player.addEventListener('ready', () => {
  el.btnRetry.hidden = true;
  showVideo();
});

player.addEventListener('needplay', () => {
  el.btnPlayOverlay.hidden = false;
});

player.addEventListener('error', (event) => {
  const message = event.detail?.message ?? 'desconhecido';
  flash(`Erro de decodificacao: ${message}`);
  setPlaceholder('Nao foi possivel decodificar o video', `${message}. Use "Reconectar video" para tentar de novo.`);
  el.btnRetry.hidden = false;
});

// ------------------------------------------------------------------ rede

net.addEventListener('open', () => {
  net.send({ type: 'hello', name: state.name, room: state.room });
  if (state.role === 'broadcaster') {
    // Reanuncia a transmissao (reconexao) e reinicia o gravador para que
    // os viewers recebam um cabecalho (init segment) valido.
    state.announced = false;
    beginBroadcast();
  }
});

net.addEventListener('status', (event) => {
  const { state: status } = event.detail;
  if (status === 'connecting') setStatus('Conectando...', 'idle');
  if (status === 'offline') setStatus('Reconectando...', 'idle');
});

net.addEventListener('close', () => {
  state.announced = false;
  if (state.role === 'broadcaster') {
    setStatus('Reconectando...', 'idle');
  }
});

net.addEventListener('binary', (event) => {
  if (state.role === 'broadcaster') return;
  player.push(event.detail);
});

net.addEventListener('message', (event) => {
  handleServerMessage(event.detail);
});

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'welcome': {
      net.metaId = msg.id;
      state.selfId = msg.id;
      state.peers = new Map((msg.peers ?? []).map((peer) => [peer.id, peer]));
      state.epoch = msg.epoch;
      state.mimeType = msg.mimeType;
      state.broadcaster = msg.broadcaster ?? null;
      renderPeers();
      setStatus('Conectado', 'ok');
      // Sem transmissor em andamento: o texto do placeholder deixa de ser
      // "conectando" (a conexao ja esta feita) e passa a explicar a espera.
      if (state.role === 'viewer' && !state.broadcaster) {
        setPlaceholder(
          'Aguardando uma transmissao',
          'Ninguem esta compartilhando a tela ainda. Voce pode assumir a transmissao abaixo.'
        );
      }
      break;
    }

    case 'peer-joined': {
      state.peers.set(msg.peer.id, { id: msg.peer.id, name: msg.peer.name });
      renderPeers();
      flash(`${msg.peer.name} entrou na sala.`);
      break;
    }

    case 'peer-left': {
      state.peers.delete(msg.peer.id);
      renderPeers();
      flash(`${msg.peer.name} saiu da sala.`);
      break;
    }

    case 'stream-started': {
      state.epoch = msg.epoch;
      state.mimeType = msg.mimeType;
      state.broadcaster = msg.broadcaster ?? state.broadcaster;

      if (state.role === 'broadcaster') {
        setStatus('AO VIVO', 'live');
        break;
      }

      if (!msg.ready) {
        state.waitingInit = true;
        state.retrying = false;
        state.configuredAt = performance.now();
        setPlaceholder('Preparando a transmissao...', 'O transmissor esta reiniciando o fluxo.');
        setStatus('Preparando', 'idle');
        break;
      }

      state.waitingInit = false;
      state.retrying = false;
      state.resyncing = false;
      state.selfStopped = false;
      state.configuredAt = performance.now();
      el.btnRetry.hidden = true;
      player.configure({ mimeType: msg.mimeType, epoch: msg.epoch });
      showVideo();
      setStatus('AO VIVO', 'live');
      el.overlayBar.hidden = false;
      el.overlayName.textContent = state.broadcaster?.name ?? '';
      break;
    }

    case 'stream-stopped': {
      // Outro cliente assumiu a transmissao: voltamos a ser espectador.
      if (state.role === 'broadcaster') {
        // Nao ha o que fazer se quem assumiu a transmissao somos nos.
        if (msg.broadcaster?.id === state.selfId) break;
        streamer.stop();
        state.role = 'viewer';
        state.announced = false;
        state.broadcaster = null;
        state.waitingInit = false;
        state.retrying = false;
        renderRole();
        renderPeers();
        flash('Outro participante assumiu a transmissao.');
        break;
      }

      // Foi o proprio usuario que parou: mantem a mensagem que ele ja viu.
      if (state.selfStopped) {
        state.selfStopped = false;
        state.retrying = false;
        break;
      }

      state.broadcaster = null;
      state.waitingInit = false;
      state.retrying = false;
      player.clear();
      el.overlayBar.hidden = true;
      setPlaceholder('Nenhuma transmissao ativa', 'Aguardando alguem compartilhar a tela.');
      setStatus('Conectado', 'ok');
      renderPeers();
      break;
    }

    case 'need-init': {
      // Alguem entrou no meio da transmissao: reinicia o gravador para
      // reenviar o cabecalho do stream (init segment).
      if (state.role === 'broadcaster') streamer.scheduleRestart();
      break;
    }

    case 'chat': {
      const li = document.createElement('li');
      const who = document.createElement('b');
      who.textContent = msg.name;
      const text = document.createElement('span');
      text.textContent = msg.text;
      li.append(who, text);
      el.chatList.appendChild(li);
      el.chatList.scrollTop = el.chatList.scrollHeight;
      break;
    }

    case 'error': {
      if (el.room.hidden) landingError(msg.message);
      else flash(msg.message);
      break;
    }

    default:
      break;
  }
}

// ------------------------------------------------------------------ stats

// Vigia do player: o Chrome NAO abre o MediaSource enquanto a aba esta
// oculta (ele adia o 'sourceopen' ate a aba voltar a ficar visivel). Sem
// esse aviso a tela ficaria em "carregando" para sempre, sem explicacao.
// Esta vigia tambem garante que nenhum estado fique preso ("Reconectando..."
// sem resposta do transmissor, por exemplo).
setInterval(() => {
  if (el.room.hidden) return;

  const waited = performance.now() - state.configuredAt;

  if (state.retrying) {
    // Pedimos um fluxo novo e nada chegou: nao deixa o texto preso.
    if (waited < 10000) return;
    state.retrying = false;
    state.waitingInit = false;
    if (state.role === 'broadcaster') {
      setPlaceholder(
        'Nao foi possivel reiniciar a gravacao',
        'Use "Trocar fonte" na janela de compartilhamento para recomecar a captura.'
      );
    } else if (!state.broadcaster) {
      setPlaceholder(
        'Ninguem esta transmitindo',
        'Aguardando alguem compartilhar a tela. Voce pode assumir a transmissao abaixo.'
      );
    } else {
      setPlaceholder(
        'O transmissor nao respondeu',
        'Clique em "Reconectar video" para tentar de novo.'
      );
      el.btnRetry.hidden = false;
    }
    return;
  }

  if (state.role !== 'viewer') return;

  if (state.waitingInit) {
    // O transmissor nao reenviou o cabecalho do fluxo: desiste de pedir
    // (senao o transmissor reinicia o gravador a cada 3 s para sempre).
    if (waited < 15000) return;
    state.waitingInit = false;
    setPlaceholder(
      'Sem imagem do transmissor',
      'O transmissor nao reenviou o inicio do video. Clique em "Reconectar video" para tentar de novo.'
    );
    el.btnRetry.hidden = false;
    return;
  }

  if (!player.configured) return;

  // O fluxo chegou quebrado (perdeu chunks ou o buffer parou de crescer):
  // o parser de WebM nao se recupera, entao pedimos um epoch novo.
  if (document.visibilityState === 'visible' && player.isStalled()) {
    requestResync();
    return;
  }

  if (player.isOpen) {
    // MediaSource aberto, mas nenhum frame decodificado: o formato enviado
    // pelo transmissor chegou sem imagem (codec nao suportado, por exemplo).
    if (waited > 12000 && player.video.videoWidth === 0) {
      setPlaceholder(
        'O fluxo chegou sem imagem',
        'O video nao pode ser decodificado neste navegador. Clique em "Reconectar video" para tentar de novo.'
      );
      el.btnRetry.hidden = false;
    }
    return;
  }

  if (document.visibilityState !== 'visible') {
    // Aba oculta (ou janela encoberta por outra): o Chrome adia o
    // 'sourceopen' e nada decodifica ate a aba voltar a ficar visivel.
    // Explica isso em vez de girar infinitamente.
    setPlaceholder(
      'Janela em segundo plano',
      'O Chrome pausa a decodificacao enquanto a aba ou a janela esta oculta. ' +
        'Clique nesta janela para ver o video (a imagem volta sozinha).'
    );
    el.btnRetry.hidden = true;
    return;
  }

  if (waited < 8000) return;

  setPlaceholder(
    'Nao foi possivel iniciar o video',
    'O navegador nao conseguiu abrir o fluxo. Clique em "Reconectar video" para tentar de novo.'
  );
  el.btnRetry.hidden = false;
}, 1000);

// Ao voltar para primeiro plano, o Chrome conclui a abertura do MediaSource
// que havia adiado. Se nao concluir, pedimos um fluxo novo ao transmissor.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (el.room.hidden) return;

  if (state.role === 'broadcaster') {
    // A captura pode ter pausado com a aba oculta. Reiniciando o gravador o
    // fluxo recomeca limpo e os espectadores recebem um cabecalho novo.
    if (streamer.stalled && streamer.isRecording) {
      flash('Captura pausada: reiniciando o fluxo.');
      streamer.restart();
    }
    return;
  }

  if (state.role !== 'viewer') return;
  if (!player.configured) return;
  if (player.isOpen && !player.isStalled()) return;
  setPlaceholder('Retomando o video...', 'Conectando ao fluxo do transmissor.');
  setTimeout(() => {
    if (player.isOpen && !player.isStalled()) return;
    requestResync('O video ficou pausado enquanto a aba estava oculta.', 'Retomando o video...');
  }, 1200);
});

// Enquanto o espectador espera o "init segment", pede periodicamente que o
// transmissor reinicie o gravador. Isso cobre o caso em que o transmissor
// ignorou (ou nao recebeu) o primeiro pedido de `need-init`.
setInterval(() => {
  if (el.room.hidden) return;
  if (state.role !== 'viewer' || !state.waitingInit) return;
  net.send({ type: 'need-init' });
}, 3000);

setInterval(() => {
  if (el.room.hidden) return;
  const now = performance.now();
  const seconds = (now - state.lastSample) / 1000;
  const delta = player.bytes - state.lastBytes;
  const sentDelta = state.sentBytes - state.lastSent;
  state.lastBytes = player.bytes;
  state.lastSent = state.sentBytes;
  state.lastSample = now;
  const bps = seconds > 0 ? delta / seconds : 0;
  const sentBps = seconds > 0 ? sentDelta / seconds : 0;
  const rate = bps >= 1024 ? `${(bps / 1024).toFixed(1)} KB/s` : `${Math.round(bps)} B/s`;
  const sentRate =
    sentBps >= 1024 ? `${(sentBps / 1024).toFixed(1)} KB/s` : `${Math.round(sentBps)} B/s`;

  const w = player.video.videoWidth;
  const h = player.video.videoHeight;
  el.overlayRes.textContent = w ? `${w}x${h} - ${rate}` : '';

  // Descricao curta do estado do fluxo: mostra em que ponto o video parou.
  let flow;
  if (state.role === 'broadcaster') {
    flow = streamer.isRecording ? `enviando ${sentRate}` : 'gravador parado';
  } else if (!player.configured) {
    flow = state.waitingInit ? 'aguardando cabecalho' : 'sem transmissao';
  } else if (player.isOpen) {
    flow = w ? `recebendo ${rate}` : 'aberto, sem imagem';
  } else {
    flow = 'abrindo o video...';
  }

  el.stats.replaceChildren();
  const rows = [
    ['resolucao', w ? `${w}x${h}` : '-'],
    ['recebido', rate],
    ['pessoas', String(state.peers.size)],
    ['conexao', net.state],
    ['fluxo', flow],
    ['aba', document.visibilityState === 'visible' ? 'visivel' : 'oculta'],
  ];
  for (const [label, value] of rows) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    wrap.append(dt, dd);
    el.stats.appendChild(wrap);
  }

  renderBroadcastWarning();
}, 1000);

// Relatorio periodico para o log do servidor: permite ver se o audio do
// espectador picota por falta de buffer (rede) ou se o fluxo chega inteiro.
// Contadores vao como diferenca desde o ultimo relatorio.
const REPORT_MS = 5000;
let lastReport = null;
setInterval(() => {
  if (el.room.hidden || net.state !== 'online') return;
  const now = performance.now();
  const prev = lastReport?.role === state.role ? lastReport : null;
  const seconds = prev ? (now - prev.at) / 1000 : REPORT_MS / 1000;
  // Contador menor que o anterior = foi zerado (nova epoch): conta do zero.
  const delta = (value, key) => (!prev ? 0 : value >= prev[key] ? value - prev[key] : value);

  if (state.role === 'broadcaster') {
    if (!streamer.isRecording) return;
    const s = streamer.stats();
    net.send({
      type: 'stats',
      role: 'broadcaster',
      chunksPerSec: delta(s.chunks, 'chunks') / seconds,
      bytesPerSec: delta(state.sentBytes, 'bytes') / seconds,
      pendingBytes: net.buffered,
      audio: s.audio,
      visible: document.visibilityState === 'visible',
    });
    lastReport = { role: state.role, at: now, chunks: s.chunks, bytes: state.sentBytes };
    return;
  }

  if (!player.configured) return;
  const p = player.stats();
  net.send({
    type: 'stats',
    role: 'viewer',
    ahead: p.ahead,
    paused: p.paused,
    rebuffers: delta(p.rebuffers, 'rebuffers'),
    rebuffersTotal: p.rebuffers,
    jumps: delta(p.jumps, 'jumps'),
    chunksPerSec: delta(p.appended, 'appended') / seconds,
    bytesPerSec: delta(player.bytes, 'bytes') / seconds,
    audioBytesPerSec: p.audioBytes == null ? null : delta(p.audioBytes, 'audioBytes') / seconds,
    queued: p.queued,
    dropped: p.dropped,
    droppedFrames: p.droppedFrames,
    visible: document.visibilityState === 'visible',
  });
  lastReport = {
    role: state.role,
    at: now,
    rebuffers: p.rebuffers,
    jumps: p.jumps,
    appended: p.appended,
    bytes: player.bytes,
    audioBytes: p.audioBytes ?? 0,
  };
}, REPORT_MS);

// ------------------------------------------------------------------- boot

// Hook de depuracao (console do navegador): window.__wss.state / .player / .streamer
window.__wss = { state, player, streamer, net };

const params = new URLSearchParams(location.search);
setRoom(params.get('room') ?? 'principal');
el.nameInput.focus();

// A captura de tela so funciona em contexto seguro (https ou localhost).
if (!window.isSecureContext) el.landingSecurity.hidden = false;
