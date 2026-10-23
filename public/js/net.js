/**
 * Cliente WebSocket com reconexao automatica.
 *
 * Eventos emitidos:
 *  - 'open'   -> conexao established
 *  - 'close'  -> conexao encerrada (tentara reconectar, salvo closedByUser)
 *  - 'status' -> {state: 'connecting'|'online'|'offline', attempt}
 *  - 'message'-> objeto JSON recebido do servidor
 *  - 'binary' -> ArrayBuffer de midia recebido do servidor
 */
export class Net extends EventTarget {
  constructor(path = '/ws') {
    super();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.url = `${proto}://${location.host}${path}`;
    this.ws = null;
    this.state = 'idle';
    this.closedByUser = false;
    this.attempt = 0;
    this.outbox = [];
    this.timer = null;
  }

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.closedByUser = false;
    this._setStatus('connecting');

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }

    this.ws.binaryType = 'arraybuffer';

    this.ws.addEventListener('open', () => {
      this.attempt = 0;
      this.state = 'online';
      this._setStatus('online');
      this.dispatchEvent(new Event('open'));
      // Reenvia o que ficou na fila enquanto estava offline.
      const pending = this.outbox.splice(0, this.outbox.length);
      for (const item of pending) this._rawSend(item);
    });

    this.ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        this.dispatchEvent(new CustomEvent('message', { detail: payload }));
      } else {
        this.dispatchEvent(new CustomEvent('binary', { detail: event.data }));
      }
    });

    this.ws.addEventListener('close', () => {
      this.state = 'offline';
      this._setStatus('offline');
      this.dispatchEvent(new Event('close'));
      if (!this.closedByUser) this._scheduleReconnect();
    });

    this.ws.addEventListener('error', () => {
      /* o evento 'close' cuida da reconexao */
    });
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.timer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** Envia um objeto JSON de controle. */
  send(payload) {
    const raw = JSON.stringify(payload);
    if (this.ws && this.ws.readyState === 1) this._rawSend(raw);
    else this.outbox.push(raw);
  }

  /** Bytes ainda na fila de envio do socket (rede nao esta dando vazao). */
  get buffered() {
    return this.ws?.bufferedAmount ?? 0;
  }

  /** Envia um frame binario de midia (descarta se offline). */
  sendBinary(buffer) {
    if (this.ws && this.ws.readyState === 1 && this.ws.bufferedAmount < 8 * 1024 * 1024) {
      this.ws.send(buffer);
    }
  }

  _rawSend(data) {
    try {
      this.ws.send(data);
    } catch {
      /* socket fechado no meio do caminho */
    }
  }

  _scheduleReconnect() {
    clearTimeout(this.timer);
    this.attempt += 1;
    const delay = Math.min(1000 * 2 ** Math.min(this.attempt, 4), 15000);
    this._setStatus('connecting');
    this.timer = setTimeout(() => this.connect(), delay);
  }

  _setStatus(state) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, attempt: this.attempt } }));
  }
}
