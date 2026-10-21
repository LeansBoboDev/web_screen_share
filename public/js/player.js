/**
 * Player: decodifica os chunks de midia recebidos do servidor usando
 * MediaSource (MSE) e alimenta um <video>.
 *
 * Detalhe importante: quando a transmissao reinicia (nova epoch) o <video>
 * precisa trocar de MediaSource. Como o desanexamento do MediaSource antigo
 * acontece de forma assincrona no elemento, a troca e feita em duas etapas
 * (reset -> espera 'emptied' -> novo MediaSource). Sem essa espera o Chrome
 * fecha o MediaSource novo imediatamente e o video nunca decodifica.
 *
 * Outro detalhe do Chrome: em uma aba em segundo plano (oculta) o evento
 * 'sourceopen' fica adiado ate a aba voltar a ficar visivel. Os chunks que
 * chegam nesse periodo ficam em uma fila com tamanho limitado, para nao
 * acumular memoria.
 *
 * Eventos emitidos:
 *  - 'ready'    -> buffer pronto
 *  - 'playing'  -> video comecou a tocar
 *  - 'needplay' -> autoplay bloqueado pelo navegador (mostrar botao)
 *  - 'error'    -> {message}
 */

const MAX_QUEUE = 60; // ~15 s de chunks (4 por segundo)

export class Player extends EventTarget {
  constructor(video) {
    super();
    this.video = video;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.mimeType = null;
    this.epoch = null;
    this.configured = false;
    this.objectUrl = null;
    this.bytes = 0;
    this.token = 0;
  }

  /** O MediaSource esta anexado ao elemento <video>? */
  get isOpen() {
    return this.mediaSource?.readyState === 'open';
  }

  /** (Re)configura o player para uma nova transmissao/epoch. */
  async configure({ mimeType, epoch }) {
    if (!mimeType) return;
    const token = ++this.token;
    this.mimeType = mimeType;
    this.epoch = epoch;
    this.configured = true;
    this.queue = [];
    this._resetElement();
    if (token !== this.token) return; // houve outra configuracao no meio
    this._create();
  }

  /** Solta o MediaSource anterior. */
  _resetElement() {
    this._release();
  }

  _release() {
    if (this.sourceBuffer) {
      this.sourceBuffer.removeEventListener('updateend', this._onUpdateEnd);
      this.sourceBuffer.removeEventListener('error', this._onBufferError);
    }
    const oldUrl = this.objectUrl;
    if (this.mediaSource) {
      this.mediaSource.removeEventListener('sourceopen', this._onSourceOpen);
      try {
        if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
      } catch {
        /* ignore */
      }
    }
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.objectUrl = null;
    // Revoga a blob URL antiga IMEDIATAMENTE: no Chrome o blob URL de um
    // MediaSource "vivo" ocupa o unico slot disponivel, e o MediaSource
    // anterior so e fechado quando a URL e revogada. Sem isso o novo
    // MediaSource nunca dispara 'sourceopen'.
    if (oldUrl) {
      try {
        URL.revokeObjectURL(oldUrl);
      } catch {
        /* ignore */
      }
    }
  }

  _create() {
    if (!('MediaSource' in window)) {
      this._fail('Navegador sem suporte a MediaSource.');
      return;
    }
    if (!MediaSource.isTypeSupported(this.mimeType)) {
      this._fail(`Formato nao suportado pelo navegador: ${this.mimeType}`);
      return;
    }

    const ms = new MediaSource();
    this.mediaSource = ms;
    this._onSourceOpen = () => {
      if (this.mediaSource !== ms) return;
      try {
        const buffer = ms.addSourceBuffer(this.mimeType);
        buffer.mode = 'segments';
        buffer.addEventListener('updateend', this._onUpdateEnd);
        buffer.addEventListener('error', this._onBufferError);
        this.sourceBuffer = buffer;
        this.dispatchEvent(new Event('ready'));
        this._drain();
      } catch (err) {
        this._fail(err?.message ?? 'Falha ao criar o buffer de midia.');
      }
    };
    ms.addEventListener('sourceopen', this._onSourceOpen);

    this.objectUrl = URL.createObjectURL(ms);

    // Usa um elemento <video> novo a cada epoch: o Chrome deixa o elemento
    // antigo em um estado inconsistente quando o MediaSource e trocado, e o
    // novo MediaSource acaba fechado sem nunca disparar 'sourceopen'.
    const previous = this.video;
    const fresh = previous.cloneNode(false);
    fresh.removeAttribute('src');
    previous.replaceWith(fresh);
    this.video = fresh;

    this.video.src = this.objectUrl;
    this.dispatchEvent(new Event('element'));
  }

  _onUpdateEnd = () => {
    this._drain();
  };

  _onBufferError = () => {
    this._fail('Erro no buffer de midia.');
  };

  /** Recebe um chunk binario da transmissao. */
  push(chunk) {
    if (!this.configured || !chunk) return;
    this.bytes += chunk.byteLength ?? 0;
    this.queue.push(chunk);
    // Limita a fila: em aba oculta o Chrome adia a abertura do MediaSource e
    // os chunks se acumulariam sem limite. O primeiro chunk (init segment)
    // e preservado para que a decodificacao ainda funcione.
    if (this.queue.length > MAX_QUEUE) {
      this.queue.splice(1, this.queue.length - MAX_QUEUE);
    }
    this._drain();
  }

  _drain() {
    const buffer = this.sourceBuffer;
    if (!buffer || buffer.updating || !this.queue.length) return;
    const chunk = this.queue.shift();
    try {
      buffer.appendBuffer(chunk);
      this._play();
    } catch (err) {
      if (err?.name === 'QuotaExceededError') {
        // Buffer cheio: descarta o conteudo antigo e segue.
        try {
          buffer.remove(0, buffer.buffered.length ? buffer.buffered.end(0) : 0);
        } catch {
          /* ignore */
        }
      } else {
        this._fail(err?.message ?? 'Falha ao decodificar o chunk.');
      }
    }
  }

  _play() {
    if (this.video.paused) {
      const promise = this.video.play();
      if (promise?.catch) {
        promise
          .then(() => this.dispatchEvent(new Event('playing')))
          .catch(() => this.dispatchEvent(new Event('needplay')));
      }
    }
  }

  /** Limpa o video (transmissao encerrada). */
  clear() {
    this.token += 1;
    this.configured = false;
    this.queue = [];
    this._release();
    try {
      this.video.pause();
    } catch {
      /* ignore */
    }
    this.video.removeAttribute('src');
  }

  destroy() {
    this.clear();
  }

  _fail(message) {
    this.dispatchEvent(new CustomEvent('error', { detail: { message } }));
  }
}
