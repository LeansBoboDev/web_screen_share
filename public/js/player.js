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
 * acumular memoria. Se a fila estourar, o fluxo chega com buracos e o parser
 * de WebM nunca mais avanca: nesse caso `isStalled()` avisa o app para pedir
 * um epoch novo ao transmissor (o fluxo recomeca limpo).
 *
 * Eventos emitidos:
 *  - 'ready'    -> buffer pronto
 *  - 'playing'  -> video comecou a tocar
 *  - 'needplay' -> autoplay bloqueado pelo navegador (mostrar botao)
 *  - 'error'    -> {message}
 */

const MAX_QUEUE = 60; // ~15 s de chunks (4 por segundo)
const STALL_MS = 6000; // buffer parado por isso => fluxo quebrado

// Folga de buffer (segundos) antes de tocar. Tocar colado no fim do buffer
// faz qualquer atraso da rede (Wi-Fi) esvaziar o buffer: no video isso passa
// despercebido, mas o audio chega picotado, com estalos e chiado.
const START_BUFFER = 0.8;
// Ficou mais atrasado que isso em relacao ao ao vivo: pula para perto do fim.
const MAX_LAG = 3;

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
    // Diagnostico: quantos chunks entraram, quantos foram aplicados no
    // buffer e quantos foram perdidos (fila estourou).
    this.appended = 0;
    this.dropped = 0;
    this.updateEnd = 0;
    this.bufferError = null;
    this.lastBufferedEnd = 0;
    this.lastProgressAt = 0;
  }

  /**
   * O fluxo parou de avancar?
   *
   * Duas situacoes quebram o video de vez (o parser de WebM nao se recupera
   * de um stream com buracos e o buffer fica congelado):
   *  1. algum chunk foi descartado (a fila estourou porque a aba ficou
   *     oculta e o Chrome adiou a abertura do MediaSource);
   *  2. o buffer parou de crescer mesmo com bytes chegando.
   *
   * Em ambos os casos a solucao e pedir um epoch novo ao transmissor: ele
   * reinicia o gravador e reenvia o cabecalho (init segment) do fluxo.
   */
  isStalled() {
    if (!this.configured) return false;
    if (this.dropped > 0) return true;

    const buffer = this.sourceBuffer;
    if (!buffer || !buffer.buffered.length) return false;

    const end = buffer.buffered.end(buffer.buffered.length - 1);
    if (end > this.lastBufferedEnd + 0.001) {
      this.lastBufferedEnd = end;
      this.lastProgressAt = Date.now();
      return false;
    }
    if (!this.lastProgressAt) {
      this.lastProgressAt = Date.now();
      return false;
    }
    return Date.now() - this.lastProgressAt > STALL_MS;
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
    this.appended = 0;
    this.dropped = 0;
    this.updateEnd = 0;
    this.bufferError = null;
    this.lastBufferedEnd = 0;
    this.lastProgressAt = Date.now();
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

  /**
   * Lista de mimeTypes aceitos, do mais especifico para o mais generico.
   * Cada navegador suporta um subconjunto diferente de codecs; se o tipo
   * exato declarado pelo transmissor nao for suportado, tentamos a familia
   * (webm/mp4) antes de desistir.
   */
  _candidates(mimeType) {
    const list = [mimeType];
    const base = mimeType.split(';')[0].trim().toLowerCase();
    if (base === 'video/webm') {
      list.push('video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm');
    } else if (base === 'video/mp4') {
      list.push(
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1.42E01E',
        'video/mp4'
      );
    }
    return [...new Set(list)];
  }

  _create() {
    if (!('MediaSource' in window)) {
      this._fail('Navegador sem suporte a MediaSource.');
      return;
    }

    const candidates = this._candidates(this.mimeType);
    const supported = candidates.find((type) => {
      try {
        return MediaSource.isTypeSupported(type);
      } catch {
        return false;
      }
    });
    if (!supported) {
      this._fail(`Formato nao suportado pelo navegador: ${this.mimeType}`);
      return;
    }
    if (supported !== this.mimeType) {
      console.warn(`[player] usando "${supported}" no lugar de "${this.mimeType}"`);
    }
    this.mimeType = supported;

    const ms = new MediaSource();
    this.mediaSource = ms;
    this._onSourceOpen = () => {
      if (this.mediaSource !== ms) return;
      try {
        const buffer = ms.addSourceBuffer(this.mimeType);
        // 'sequence' (padrao do MSE) trata os chunks como um fluxo continuo de
        // bytes. E o que o MediaRecorder produz: cada chunk e um pedaco de
        // WebM com os clusters de video e audio intercalados. No modo
        // 'segments' o Chrome exige que cada append seja um segmento
        // completo e independente, e os chunks seguintes (que trazem apenas
        // clusters, sem cabecalho) sao descartados silenciosamente: o video
        // parava no primeiro quadro (readyState=1, tela preta).
        buffer.mode = 'sequence';
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

    this.video.addEventListener('waiting', this._onWaiting);
    this.video.src = this.objectUrl;
    this.dispatchEvent(new Event('element'));
  }

  _onUpdateEnd = () => {
    this.updateEnd += 1;
    this._play();
    this._drain();
  };

  /**
   * O buffer esvaziou durante a reproducao. Sem pausar, o navegador volta a
   * tocar assim que chega o proximo pedacinho e esvazia de novo em seguida
   * (audio picotado). Pausando, `_play()` so retoma com a folga refeita.
   */
  _onWaiting = (event) => {
    if (event.target !== this.video || this.video.ended) return;
    this.video.pause();
  };

  /** Quantos segundos de midia ha no buffer a frente da posicao atual. */
  _ahead() {
    const buffered = this.video.buffered;
    if (!buffered.length) return { ahead: 0, end: 0 };
    const end = buffered.end(buffered.length - 1);
    return { ahead: end - this.video.currentTime, end };
  }

  _onBufferError = () => {
    this.bufferError = 'Erro no buffer de midia.';
    this._fail(this.bufferError);
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
      this.dropped += 1;
    }
    this._drain();
  }

  _drain() {
    const buffer = this.sourceBuffer;
    if (!buffer || buffer.updating || !this.queue.length) return;
    const chunk = this.queue.shift();
    try {
      buffer.appendBuffer(chunk);
      this.appended += 1;
    } catch (err) {
      if (err?.name === 'QuotaExceededError') {
        // Buffer cheio: descarta o conteudo antigo e segue.
        try {
          buffer.remove(0, buffer.buffered.length ? buffer.buffered.end(0) : 0);
        } catch {
          /* ignore */
        }
      } else {
        this.bufferError = err?.message ?? 'Falha ao decodificar o chunk.';
        this._fail(this.bufferError);
      }
    }
  }

  _play() {
    const { ahead, end } = this._ahead();
    if (ahead > MAX_LAG) {
      this.video.currentTime = end - START_BUFFER;
    }
    if (this.video.paused && ahead >= START_BUFFER) {
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
