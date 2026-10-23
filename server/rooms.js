import { randomUUID } from 'node:crypto';

/**
 * Gerenciador de salas + retransmissao de midia.
 *
 * Modelo:
 *  - Cada sala tem no maximo um "broadcaster" (quem esta compartilhando a tela).
 *  - Todos os outros clientes da sala sao "viewers" e recebem os chunks de midia.
 *  - O texto (JSON) trafega como mensagem de controle; a midia trafega como
 *    frame binario opaco, repassado sem alteracao.
 */

const DEFAULT_ROOM = 'principal';
const ROOM_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_NAME = 40;
const MAX_CHAT = 500;
const MAX_BACKLOG = 8 * 1024 * 1024; // descarta quadro se o cliente nao consegue consumir
const HEARTBEAT_MS = 30_000;

// Log de diagnostico. Desligue com LOG=0 (ou WSS_LOG=0).
const LOG_ENABLED = !['0', 'false', 'off'].includes(
  String(process.env.LOG ?? process.env.WSS_LOG ?? '1').toLowerCase()
);

function log(...args) {
  if (LOG_ENABLED) console.log(...args);
}

export class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  stats() {
    return {
      salas: this.rooms.size,
      clientes: [...this.rooms.values()].reduce((acc, r) => acc + r.clients.size, 0),
      transmitindo: [...this.rooms.values()].filter((r) => r.broadcaster).length,
    };
  }

  /** @returns {Room} */
  room(id) {
    let room = this.rooms.get(id);
    if (!room) {
      room = {
        id,
        clients: new Map(), // id -> ws
        broadcaster: null, // ws
        epoch: 0, // incrementa a cada novo/restart de transmissao
        mimeType: null,
        createdAt: Date.now(),
      };
      this.rooms.set(id, room);
    }
    return room;
  }

  handleConnection(ws) {
    ws.meta = {
      id: randomUUID().slice(0, 8),
      name: 'Anonimo',
      roomId: null,
      role: 'viewer', // viewer | broadcaster
      alive: true,
    };

    ws.on('pong', () => {
      ws.meta.alive = true;
    });

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) this.relayMedia(ws, data);
        else this.handleControl(ws, data.toString());
      } catch (err) {
        console.error('[erro ao processar mensagem]', err);
      }
    });

    ws.on('close', () => this.remove(ws));
    ws.on('error', () => this.remove(ws));
  }

  // ---------------------------------------------------------------- controle

  handleControl(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.fail(ws, 'Mensagem JSON invalida.');
    }
    if (!msg || typeof msg.type !== 'string') {
      return this.fail(ws, 'Mensagem invalida.');
    }

    switch (msg.type) {
      case 'hello':
        return this.join(ws, msg);
      case 'start':
        return this.startBroadcast(ws, msg);
      case 'restart':
        return this.restartBroadcast(ws, msg);
      case 'stop':
        return this.stopBroadcast(ws, msg);
      case 'chat':
        return this.relayChat(ws, msg);
      case 'need-init':
        return this.requestInit(ws);
      case 'ping':
        return this.send(ws, { type: 'pong', ts: Date.now() });
      case 'stats':
        return this.logStats(ws, msg);
      default:
        return this.fail(ws, `Tipo de mensagem desconhecido: ${msg.type}`);
    }
  }

  join(ws, msg) {
    if (ws.meta.roomId) return; // ja conectado a uma sala

    const name = sanitizeName(msg.name);
    const roomId = ROOM_PATTERN.test(String(msg.room ?? '')) ? String(msg.room) : DEFAULT_ROOM;
    const room = this.room(roomId);

    ws.meta.name = name;
    ws.meta.roomId = roomId;
    ws.meta.role = 'viewer';
    room.clients.set(ws.meta.id, ws);

    this.send(ws, {
      type: 'welcome',
      id: ws.meta.id,
      name,
      room: roomId,
      peers: this.peerList(room),
      broadcasting: Boolean(room.broadcaster),
      broadcaster: room.broadcaster
        ? { id: room.broadcaster.meta.id, name: room.broadcaster.meta.name }
        : null,
      epoch: room.epoch,
      mimeType: room.mimeType,
      ts: Date.now(),
    });

    this.broadcast(room, { type: 'peer-joined', peer: { id: ws.meta.id, name } }, ws);
    log(`[sala ${roomId}] entrou "${name}" (${ws.meta.id}) - ${room.clients.size} pessoa(s)`);

    // O novato entrou durante uma transmissao: pede o "cabecalho" (init segment)
    // ao broadcaster, que reinicia o gravador para reenviar os primeiros bytes.
    if (room.broadcaster) {
      log(`[sala ${roomId}] "${name}" entrou durante a transmissao -> precisa do init segment`);
      this.send(ws, {
        type: 'stream-started',
        epoch: room.epoch,
        mimeType: room.mimeType,
        ready: false,
        broadcaster: { id: room.broadcaster.meta.id, name: room.broadcaster.meta.name },
      });
      this.send(room.broadcaster, { type: 'need-init', peer: { id: ws.meta.id, name } });
    }
  }

  startBroadcast(ws, msg) {
    const room = this.room(ws.meta.roomId ?? DEFAULT_ROOM);
    ws.meta.roomId = room.id;

    if (room.broadcaster && room.broadcaster !== ws) {
      // Assumir a transmissao: derruba a anterior.
      room.broadcaster.meta.role = 'viewer';
      this.broadcast(
        room,
        {
          type: 'stream-stopped',
          reason: 'takeover',
          broadcaster: { id: ws.meta.id, name: ws.meta.name },
        },
        ws // o novo transmissor nao precisa ser avisado
      );
    }

    room.broadcaster = ws;
    ws.meta.role = 'broadcaster';
    room.epoch += 1;
    room.mimeType = typeof msg.mimeType === 'string' ? msg.mimeType : null;

    log(
      `[sala ${room.id}] "${ws.meta.name}" começou a transmitir (epoch ${room.epoch}, ${room.mimeType})`
    );

    this.broadcast(room, {
      type: 'stream-started',
      epoch: room.epoch,
      mimeType: room.mimeType,
      ready: true,
      broadcaster: { id: ws.meta.id, name: ws.meta.name },
    });
  }

  restartBroadcast(ws, msg) {
    const room = this.room(ws.meta.roomId ?? DEFAULT_ROOM);
    if (room.broadcaster !== ws) return; // nao e o broadcaster atual
    room.epoch += 1;
    if (typeof msg.mimeType === 'string') room.mimeType = msg.mimeType;

    log(`[sala ${room.id}] reinicio do fluxo (epoch ${room.epoch})`);

    this.broadcast(room, {
      type: 'stream-started',
      epoch: room.epoch,
      mimeType: room.mimeType,
      ready: true,
      broadcaster: { id: ws.meta.id, name: ws.meta.name },
    });
  }

  stopBroadcast(ws) {
    const room = this.room(ws.meta.roomId ?? DEFAULT_ROOM);
    if (room.broadcaster !== ws) return;
    room.broadcaster = null;
    ws.meta.role = 'viewer';
    log(`[sala ${room.id}] "${ws.meta.name}" parou de transmitir`);
    this.broadcast(room, { type: 'stream-stopped', reason: 'stopped' });
  }

  requestInit(ws) {
    const room = this.room(ws.meta.roomId ?? DEFAULT_ROOM);
    if (room.broadcaster && room.broadcaster !== ws) {
      log(`[sala ${room.id}] "${ws.meta.name}" pediu need-init`);
      this.send(room.broadcaster, { type: 'need-init', peer: { id: ws.meta.id, name: ws.meta.name } });
    }
  }

  relayChat(ws, msg) {
    const room = this.room(ws.meta.roomId ?? DEFAULT_ROOM);
    const text = String(msg.text ?? '').slice(0, MAX_CHAT).trim();
    if (!text) return;
    this.broadcast(room, {
      type: 'chat',
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: ws.meta.name,
      text,
      ts: Date.now(),
    });
  }

  /**
   * Relatorio periodico de diagnostico enviado pelos navegadores.
   * Espectador: "pausas" > 0 significa que o buffer esvaziou (rede nao deu
   * vazao) e o audio foi cortado. Transmissor: "pendente" crescendo indica
   * upload insuficiente.
   */
  logStats(ws, msg) {
    if (!ws.meta.roomId) return;
    const now = Date.now();
    if (now - (ws.meta.lastStatsAt ?? 0) < 1000) return; // limita abuso
    ws.meta.lastStatsAt = now;

    const time = new Date(now).toLocaleTimeString('pt-BR');
    const who = `[${time}] [sala ${ws.meta.roomId}] "${ws.meta.name}"`;
    const tab = msg.visible === false ? ', ABA OCULTA' : '';

    if (msg.role === 'broadcaster') {
      const a = msg.audio && typeof msg.audio === 'object' ? msg.audio : null;
      const audio = a
        ? `audio ${text(a.source)} ${num(a.sampleRate, 0)}Hz ${num(a.channels, 0)}ch` +
          ` (sistema ${onOff(a.system)}, mic ${onOff(a.mic)})`
        : 'sem audio';
      log(
        `${who} transmissor: ${audio}, ${num(msg.chunksPerSec, 1)} chunks/s,` +
          ` ${kb(msg.bytesPerSec)}/s, pendente ${kb(msg.pendingBytes)}${tab}`
      );
      return;
    }

    const audioRate = msg.audioBytesPerSec == null ? '' : `, audio ${kb(msg.audioBytesPerSec)}/s`;
    const alert = num(msg.rebuffers, 0) > 0 ? '  <-- BUFFER ESVAZIOU' : '';
    log(
      `${who} espectador: buffer ${num(msg.ahead, 2)}s${msg.paused ? ' (pausado)' : ''},` +
        ` pausas ${num(msg.rebuffers, 0)} (total ${num(msg.rebuffersTotal, 0)}),` +
        ` saltos ${num(msg.jumps, 0)}, ${num(msg.chunksPerSec, 1)} chunks/s,` +
        ` ${kb(msg.bytesPerSec)}/s${audioRate}, fila ${num(msg.queued, 0)},` +
        ` descartados ${num(msg.dropped, 0)}, quadros perdidos ${num(msg.droppedFrames, 0)}${tab}${alert}`
    );
  }

  // ------------------------------------------------------------------- midia

  relayMedia(ws, data) {
    if (ws.meta.role !== 'broadcaster') return;
    const room = this.rooms.get(ws.meta.roomId);
    if (!room || room.broadcaster !== ws) return;

    for (const client of room.clients.values()) {
      if (client === ws) continue;
      if (client.readyState !== 1) continue;
      // Cliente lento: descarta o quadro em vez de acumular memoria infinita.
      if (client.bufferedAmount > MAX_BACKLOG) continue;
      client.send(data, { binary: true });
    }
  }

  // ------------------------------------------------------------------ utilitarios

  remove(ws) {
    const roomId = ws.meta?.roomId;
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.clients.delete(ws.meta.id);

    if (room.broadcaster === ws) {
      room.broadcaster = null;
      log(`[sala ${room.id}] "${ws.meta.name}" saiu durante a transmissao`);
      this.broadcast(room, { type: 'stream-stopped', reason: 'left' });
    }

    log(`[sala ${room.id}] saiu "${ws.meta.name}" - ${room.clients.size} pessoa(s)`);
    this.broadcast(room, { type: 'peer-left', peer: { id: ws.meta.id, name: ws.meta.name } });

    if (room.clients.size === 0) this.rooms.delete(roomId);
  }

  peerList(room) {
    return [...room.clients.values()].map((c) => ({
      id: c.meta.id,
      name: c.meta.name,
      role: c.meta.role,
    }));
  }

  broadcast(room, payload, except = null) {
    const data = JSON.stringify(payload);
    for (const client of room.clients.values()) {
      if (client === except) continue;
      if (client.readyState !== 1) continue;
      client.send(data);
    }
  }

  send(ws, payload) {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify(payload));
  }

  fail(ws, message) {
    this.send(ws, { type: 'error', message });
  }

  heartbeat() {
    for (const room of this.rooms.values()) {
      for (const ws of room.clients.values()) {
        if (!ws.meta.alive) {
          ws.terminate();
          continue;
        }
        ws.meta.alive = false;
        try {
          ws.ping();
        } catch {
          /* socket ja morreu */
        }
      }
    }
  }

  closeAll() {
    for (const room of this.rooms.values()) {
      for (const ws of room.clients.values()) {
        try {
          ws.close(1001, 'servidor encerrando');
        } catch {
          /* ignore */
        }
      }
    }
    clearInterval(this.timer);
  }
}

// Formatadores do log de stats: os valores vem do navegador, entao tudo e
// convertido/limitado antes de ir para o terminal.
function num(value, digits) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '?';
}

function kb(bytes) {
  const n = Number(bytes);
  return Number.isFinite(n) ? `${(n / 1024).toFixed(1)} KB` : '?';
}

function text(value) {
  return String(value ?? '?').replace(/[^\w-]/g, '').slice(0, 20) || '?';
}

function onOff(value) {
  if (value == null) return '-';
  return value ? 'on' : 'off';
}

function sanitizeName(name) {
  const clean = String(name ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, MAX_NAME);
  return clean || 'Anonimo';
}
