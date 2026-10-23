/**
 * Streamer: captura da tela (getDisplayMedia), mistura de audio e gravacao
 * em chunks via MediaRecorder.
 *
 * Ordem importante: o 'restart' (nova epoch) precisa chegar ao servidor
 * ANTES dos primeiros chunks da nova gravacao, senao os viewers decodificam
 * midia sem o cabecalho (init segment). Por isso a gravacao e controlada em
 * duas etapas: `open()` (captura) e `startRecording()` (grava).
 *
 * Eventos emitidos:
 *  - 'started'  -> {mimeType}  gravador iniciado
 *  - 'chunk'    -> ArrayBuffer  pedaco de midia pronto para enviar
 *  - 'restart'  -> {mimeType}  gravador reiniciado (nova epoch)
 *  - 'ended'    -> {}           o usuario cancelou o compartilhamento no navegador
 */

const CHUNK_MS = 250;
const VIDEO_BITRATE = 2_600_000;
const AUDIO_BITRATE = 128_000;

const MIME_WITH_AUDIO = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
];

const MIME_VIDEO_ONLY = [
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
];

export class Streamer extends EventTarget {
  constructor() {
    super();
    this.displayStream = null;
    this.videoTracks = [];
    this.systemTrack = null;
    this.micTrack = null;
    this.ctx = null;
    this.dest = null;
    this.recorder = null;
    this.recordStream = null;
    this.mimeType = '';
    this.queue = Promise.resolve();
    this.generation = 0;
    this.lastRestart = 0;
    this.restartTimer = null;
    this.lastChunkAt = 0;
    this.chunks = 0;
  }

  get isRecording() {
    return Boolean(this.recorder && this.recorder.state === 'recording');
  }

  /**
   * A captura parou de produzir dados?
   *
   * O Chrome entrega os quadros da tela em ritmo normal mesmo com a aba em
   * segundo plano, mas a captura pode pausar (janela minimizada, sistema
   * dormindo, troca de monitor). Sem isso o espectador ficaria olhando um
   * video congelado sem nenhuma explicacao.
   */
  get stalled() {
    if (!this.isRecording) return false;
    if (!this.lastChunkAt) return false;
    return Date.now() - this.lastChunkAt > 4000;
  }

  // ------------------------------------------------------------- captura

  /**
   * Abre o seletor de tela do navegador e prepara a mixagem de audio.
   * Nao comeca a gravar: use `startRecording()`.
   * @param {{wantAudio?:boolean, wantMic?:boolean}} options
   */
  async open({ wantAudio = false, wantMic = false } = {}) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      // `navigator.mediaDevices` nao existe fora de um contexto seguro
      // (http:// sem localhost). O erro precisa dizer isso, senao parece
      // que o servidor quebrou.
      throw new Error(
        window.isSecureContext
          ? 'Este navegador nao suporta captura de tela (getDisplayMedia).'
          : 'Captura de tela exige um endereco seguro: abra o site por https:// ou por http://localhost.'
      );
    }

    this._release();

    const video = { frameRate: { ideal: 30 }, cursor: 'always' };
    const attempts = wantAudio
      ? [
          { video, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } },
          { video, audio: true },
        ]
      : [{ video, audio: false }];

    let display = null;
    let lastError = null;
    for (const constraints of attempts) {
      try {
        display = await navigator.mediaDevices.getDisplayMedia(constraints);
        break;
      } catch (err) {
        lastError = err;
        if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') throw err;
      }
    }
    if (!display) throw lastError ?? new Error('Nao foi possivel iniciar a captura de tela.');

    this.displayStream = display;
    this.videoTracks = display.getVideoTracks();
    this.systemTrack = display.getAudioTracks()[0] ?? null;
    if (this.systemTrack) this.systemTrack.enabled = false; // o usuario liga depois

    if (wantMic) {
      try {
        await this.enableMic();
      } catch {
        /* microfone opcional */
      }
    }

    this.videoTracks[0]?.addEventListener('ended', () => {
      this.dispatchEvent(new Event('ended'));
    });

    this._prepare();
    return this.mimeType;
  }

  /**
   * Track de audio que vai para o gravador.
   *
   * Com uma unica fonte a track vai direto para o MediaRecorder. Passar pelo
   * Web Audio sem necessidade reamostra o audio na taxa do dispositivo de
   * saida do sistema; com um headset Bluetooth em modo chamada (HFP) isso
   * e 16 kHz ou menos e o audio chega com som de radio.
   */
  recordAudioTrack() {
    const sources = [this.systemTrack, this.micTrack].filter(Boolean);
    if (sources.length <= 1) return sources[0] ?? null;
    return this._mix(sources) ?? sources[0];
  }

  /** Mistura audio do sistema e microfone em 48 kHz (taxa nativa do Opus). */
  _mix(sources) {
    if (this.dest) return this.dest.stream.getAudioTracks()[0] ?? null;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    // Alguns navegadores recusam ligar uma track a um contexto com taxa
    // diferente da dela: nesse caso tenta de novo com a taxa padrao.
    for (const options of [{ sampleRate: 48_000 }, undefined]) {
      let ctx = null;
      try {
        ctx = new AudioCtx(options);
        const dest = ctx.createMediaStreamDestination();
        for (const track of sources) {
          ctx.createMediaStreamSource(new MediaStream([track])).connect(dest);
        }
        ctx.resume?.().catch(() => {});
        this.ctx = ctx;
        this.dest = dest;
        return dest.stream.getAudioTracks()[0] ?? null;
      } catch (err) {
        console.warn('[streamer] falha ao mixar audio', err);
        ctx?.close?.().catch(() => {});
      }
    }
    return null;
  }

  // ---------------------------------------------------------- gravacao

  _buildStream() {
    const tracks = this.videoTracks.filter(Boolean);
    const audio = this.recordAudioTrack();
    if (audio) tracks.push(audio);
    return new MediaStream(tracks);
  }

  _pickMime(hasAudio) {
    const list = hasAudio ? MIME_WITH_AUDIO : MIME_VIDEO_ONLY;
    for (const type of list) {
      try {
        if (window.MediaRecorder?.isTypeSupported?.(type)) return type;
      } catch {
        /* ignore */
      }
    }
    return '';
  }

  /** Recalcula mimeType e stream de gravacao (apos mudanca de audio/fonte). */
  _prepare() {
    this.mimeType = this._pickMime(this.hasAudioTrack());
    this.recordStream = this._buildStream();
  }

  startRecording() {
    if (this.recorder && this.recorder.state !== 'inactive') return;
    this._prepare();

    const options = { videoBitsPerSecond: VIDEO_BITRATE };
    if (this.mimeType) options.mimeType = this.mimeType;
    if (this.hasAudioTrack()) options.audioBitsPerSecond = AUDIO_BITRATE;

    const generation = ++this.generation;
    const recorder = new MediaRecorder(this.recordStream, options);
    this.recorder = recorder;

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      this.lastChunkAt = Date.now();
      this.chunks += 1;
      // Serializa os envios para preservar a ordem dos chunks.
      this.queue = this.queue
        .then(() => event.data.arrayBuffer())
        .then((buffer) => {
          // Chunk de uma gravacao antiga (ex.: apos um restart): descarta.
          if (generation !== this.generation) return;
          this.dispatchEvent(new CustomEvent('chunk', { detail: buffer }));
        })
        .catch(() => {});
    };

    recorder.onstop = () => {
      if (this.recorder === recorder) this.dispatchEvent(new Event('stopped'));
    };

    recorder.start(CHUNK_MS);
    this.dispatchEvent(new CustomEvent('started', { detail: { mimeType: this.mimeType } }));
  }

  /**
   * Reinicia o gravador. O evento 'restart' e emitido ANTES de comecar a
   * nova gravacao, garantindo que o servidor receba a nova epoch antes dos
   * primeiros chunks.
   */
  restart() {
    if (!this.recorder) return;
    try {
      this.recorder.stop();
    } catch {
      /* ignore */
    }
    this.recorder = null;
    this.generation += 1; // invalida chunks em voo da gravacao anterior
    this._prepare();
    this.dispatchEvent(new CustomEvent('restart', { detail: { mimeType: this.mimeType } }));
    this.startRecording();
  }

  /** Reinicio com debounce (usado quando alguem entra no meio da transmissao). */
  scheduleRestart(minInterval = 1500) {
    const elapsed = Date.now() - this.lastRestart;
    const wait = Math.max(0, minInterval - elapsed);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.lastRestart = Date.now();
      this.restart();
    }, wait);
  }

  // -------------------------------------------------------------- audio

  async enableMic() {
    if (this.micTrack) {
      this.micTrack.enabled = true;
      return true;
    }
    if (!navigator.mediaDevices?.getUserMedia) return false;
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.micTrack = micStream.getAudioTracks()[0];
    this.micTrack.enabled = true;
    return true;
  }

  disableMic() {
    if (this.micTrack) this.micTrack.enabled = false;
  }

  setSystemAudio(enabled) {
    if (this.systemTrack) this.systemTrack.enabled = enabled;
  }

  hasAudioTrack() {
    return Boolean(this.systemTrack || this.micTrack);
  }

  // -------------------------------------------------------------- parar

  stop() {
    clearTimeout(this.restartTimer);
    this._release();
  }

  _release() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        /* ignore */
      }
    }
    this.recorder = null;
    this.generation += 1;
    for (const track of this.videoTracks) track.stop();
    for (const track of this.displayStream?.getAudioTracks() ?? []) track.stop();
    this.micTrack?.stop();
    try {
      this.ctx?.close?.();
    } catch {
      /* ignore */
    }
    this.videoTracks = [];
    this.systemTrack = null;
    this.micTrack = null;
    this.ctx = null;
    this.dest = null;
    this.displayStream = null;
    this.recordStream = null;
  }
}
