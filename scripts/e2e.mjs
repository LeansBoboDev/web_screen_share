/**
 * Teste end-to-end no navegador (Chrome/Edge headless via CDP).
 *
 * Valida o caminho completo:
 *   captura -> MediaRecorder -> WebSocket -> servidor -> WebSocket -> MSE -> <video>
 *
 * Tres abas sao abertas na mesma sala:
 *  - uma "compartilha" (captura falsa gerada por canvas, para nao depender de
 *    permissao real de tela);
 *  - uma apenas assiste;
 *  - uma entra DEPOIS do inicio da transmissao (caminho critico do init
 *    segment / epoch).
 *
 * Uso: npm run e2e   (o servidor precisa estar rodando)
 */
import { launchBrowser, newPage, evaluate, sleep, bringToFront } from './lib/cdp.mjs';

const PORT = Number(process.env.PORT) || 8080;
const SITE = `http://localhost:${PORT}`;

let failures = 0;
function check(label, ok, extra = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}${extra ? ` -> ${extra}` : ''}`);
}

const health = await fetch(`${SITE}/api/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`Servidor nao responde em ${SITE}. Rode "npm start" antes.`);
  process.exit(1);
}

const { cdp, close } = await launchBrowser(9333);

const errors = [];
const logs = [];
cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
  errors.push(`[${sessionId.slice(0, 6)}] ${params.exceptionDetails?.exception?.description ?? 'excecao'}`);
});
cdp.on('Runtime.consoleAPICalled', (params, sessionId) => {
  const text = params.args.map((a) => a.value ?? a.description).join(' ');
  logs.push(`[${sessionId.slice(0, 6)}] ${params.type}: ${text}`);
  if (params.type === 'error') errors.push(`[console.error] ${text}`);
});

const room = `e2e${Date.now().toString(36).slice(-5)}`;
const url = `${SITE}/?room=${room}`;

const broadcaster = await newPage(cdp, url);
const viewer = await newPage(cdp, url);

await sleep(1500);

// -- aba do transmissor: captura falsa + clique em compartilhar -------------
const FAKE_CAPTURE = `
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    let t = 0;
    setInterval(() => {
      t += 1;
      ctx.fillStyle = 'hsl(' + ((t * 4) % 360) + ', 70%, 45%)';
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 48px sans-serif';
      ctx.fillText('FRAME ' + t, 40, 190);
    }, 33);
    const stream = canvas.captureStream(30);
    window.__fakeStream = stream;
    return stream;
  };
  document.getElementById('name-input').value = 'Transmissor E2E';
  document.getElementById('btn-share').click();
  'ok';
`;

const prepared = await evaluate(cdp, broadcaster.sessionId, FAKE_CAPTURE);
check('aba do transmissor aceitou a captura falsa', prepared === 'ok');

await sleep(800);

// -- aba do espectador: apenas assistir ------------------------------------
const joined = await evaluate(
  cdp,
  viewer.sessionId,
  `document.getElementById('name-input').value = 'Espectador E2E';
   document.getElementById('btn-watch').click();
   'ok';`
);
check('aba do espectador entrou na sala', joined === 'ok');

// -- espera a midia chegar e ser decodificada ------------------------------
async function waitForVideo(sessionId, timeoutMs = 15000) {
  // O Chrome so decodifica com a aba visivel: traz a aba para o primeiro plano.
  await bringToFront(cdp, sessionId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const size = await evaluate(cdp, sessionId, `document.getElementById('video').videoWidth`);
    if (size > 0) return size;
  }
  return 0;
}

const viewerWidth = await waitForVideo(viewer.sessionId);
check('video decodificou a transmissao (MSE)', viewerWidth > 0, `${viewerWidth}px`);

const viewerState = await evaluate(
  cdp,
  viewer.sessionId,
  `(() => ({
     pill: document.getElementById('status-pill').textContent,
     overlay: document.getElementById('overlay-bar').hidden === false,
     peers: document.getElementById('peer-list').children.length,
     stats: document.getElementById('stats').textContent.replace(/\\s+/g, ' ').trim(),
     hasVideo: document.getElementById('video-wrap').classList.contains('has-video'),
     bytes: window.__wss.player.bytes
   }))()`
);
check('status do espectador indica AO VIVO', viewerState.pill.includes('AO VIVO'), viewerState.pill);
check('barra de overlay visivel', viewerState.overlay === true);
check('sala lista os 2 participantes', viewerState.peers === 2, `peers=${viewerState.peers}`);
check('estatisticas de streaming preenchidas', /KB\/s|B\/s/.test(viewerState.stats), viewerState.stats);
check('bytes de midia recebidos', viewerState.bytes > 0, `bytes=${viewerState.bytes}`);

const broadcasterState = await evaluate(
  cdp,
  broadcaster.sessionId,
  `(() => ({
     pill: document.getElementById('status-pill').textContent,
     panel: document.getElementById('broadcast-panel').hidden === false,
     sharing: document.getElementById('video-wrap').classList.contains('is-sharing'),
     preview: document.getElementById('preview').videoWidth,
     placeholderHidden: document.getElementById('placeholder').hidden
   }))()`
);
check('transmissor mostra o painel de controle', broadcasterState.panel === true);
check('transmissor marcado como AO VIVO', broadcasterState.pill.includes('AO VIVO'), broadcasterState.pill);

// Quem compartilha precisa ver a propria tela: sem isso a janela do
// transmissor ficaria com um "carregando" eterno.
await bringToFront(cdp, broadcaster.sessionId);
await sleep(1200);
const previewState = await evaluate(
  cdp,
  broadcaster.sessionId,
  `(() => ({
     sharing: document.getElementById('video-wrap').classList.contains('is-sharing'),
     preview: document.getElementById('preview').videoWidth,
     placeholderHidden: document.getElementById('placeholder').hidden
   }))()`
);
check(
  'transmissor ve a previa local da propria tela',
  previewState.sharing === true && previewState.preview > 0,
  `preview=${previewState.preview}px`
);
check(
  'transmissor nao fica com "carregando" eterno',
  previewState.placeholderHidden === true,
  `placeholder oculto=${previewState.placeholderHidden}`
);

// Quando a captura para de produzir dados (janela minimizada, sistema
// dormindo, troca de monitor), o transmissor precisa avisar: sem isso o
// espectador so veria um video congelado, sem nenhuma explicacao.
await evaluate(
  cdp,
  broadcaster.sessionId,
  `Object.defineProperty(window.__wss.streamer, 'stalled', {
     get: () => true, configurable: true
   });
   'ok';`
);
await sleep(1500);
const stallWarn = await evaluate(
  cdp,
  broadcaster.sessionId,
  `(() => {
     const w = document.getElementById('broadcast-warning');
     return { hidden: w.hidden, text: w.textContent };
   })()`
);
check(
  'transmissor avisa quando a captura para',
  stallWarn.hidden === false && /captura parou/i.test(stallWarn.text),
  JSON.stringify(stallWarn)
);

await evaluate(
  cdp,
  broadcaster.sessionId,
  `delete window.__wss.streamer.stalled; 'ok';`
);
await sleep(1500);
const stallWarnOff = await evaluate(
  cdp,
  broadcaster.sessionId,
  `document.getElementById('broadcast-warning').hidden`
);
check('aviso de captura parada some quando o fluxo volta', stallWarnOff === true);

// -- terceira aba: entra DEPOIS do inicio da transmissao -------------------
const late = await newPage(cdp, url);
await sleep(600);
// Tira a aba nova do primeiro plano ANTES de ela entrar na sala: assim o
// Chrome adia a abertura do MediaSource e o app precisa avisar que esta em
// segundo plano (em vez de girar infinitamente).
await bringToFront(cdp, broadcaster.sessionId);
await evaluate(
  cdp,
  late.sessionId,
  `document.getElementById('name-input').value = 'Espectador Tardio';
   document.getElementById('btn-watch').click();
   'ok';`
);

// A aba nova fica em segundo plano: o Chrome adia a abertura do MediaSource
// e a tela ficaria girando sem explicacao. O app precisa avisar.
await sleep(3000);
const lateHidden = await evaluate(
  cdp,
  late.sessionId,
  `(() => ({
     visibility: document.visibilityState,
     placeholder: document.getElementById('placeholder').hidden
       ? null
       : document.getElementById('placeholder-title').textContent
   }))()`
);
check(
  'aba em segundo plano avisa que o Chrome pausa a decodificacao',
  lateHidden.visibility === 'hidden' && /segundo plano/i.test(lateHidden.placeholder ?? ''),
  JSON.stringify(lateHidden)
);

const lateWidth = await waitForVideo(late.sessionId);
check('espectador tardio decodifica a transmissao', lateWidth > 0, `videoWidth=${lateWidth}`);

const lateVisible = await evaluate(
  cdp,
  late.sessionId,
  `document.getElementById('placeholder').hidden`
);
check('espectador volta ao normal ao voltar para o primeiro plano', lateVisible === true);

// O espectador original estava em segundo plano: ao voltar para o primeiro
// plano o Chrome concludes a abertura do MediaSource e a imagem volta.
const recovered = await waitForVideo(viewer.sessionId);
check('espectador original se recupera apos a troca de epoch', recovered > 0, `videoWidth=${recovered}`);

const lateState = await evaluate(
  cdp,
  late.sessionId,
  `(() => ({ pill: document.getElementById('status-pill').textContent, bytes: window.__wss.player.bytes }))()`
);
check('espectador tardio virou AO VIVO', lateState.pill.includes('AO VIVO'), lateState.pill);
check('espectador tardio recebeu bytes', lateState.bytes > 0, `bytes=${lateState.bytes}`);

// -- chat entre as abas ----------------------------------------------------
await evaluate(
  cdp,
  viewer.sessionId,
  `(() => {
     const input = document.getElementById('chat-input');
     input.value = 'mensagem de teste';
     document.getElementById('chat-form').dispatchEvent(new Event('submit', { cancelable: true }));
     return 'ok';
   })()`
);
await sleep(600);
const chatReceived = await evaluate(
  cdp,
  broadcaster.sessionId,
  `document.getElementById('chat-list').textContent.includes('mensagem de teste')`
);
check('chat chegou na outra aba', chatReceived === true);

// -- captura de imagem (snapshot) -----------------------------------------
const snapshotInfo = await evaluate(
  cdp,
  viewer.sessionId,
  `(() => {
     const v = document.getElementById('video');
     const canvas = document.createElement('canvas');
     canvas.width = v.videoWidth; canvas.height = v.videoHeight;
     const ctx = canvas.getContext('2d');
     ctx.drawImage(v, 0, 0);
     const data = canvas.toDataURL('image/png');
     const px = ctx.getImageData(Math.floor(v.videoWidth/2), Math.floor(v.videoHeight/2), 1, 1).data;
     return { len: data.length, w: canvas.width, h: canvas.height, px: [px[0], px[1], px[2]] };
   })()`
);
check(
  'frame da transmissao pode ser capturado (canvas drawImage)',
  snapshotInfo.len > 100 && snapshotInfo.w > 0 && snapshotInfo.px[0] + snapshotInfo.px[1] + snapshotInfo.px[2] > 0,
  JSON.stringify(snapshotInfo)
);

// -- takeover: o espectador assume a transmissao ----------------------------
await bringToFront(cdp, viewer.sessionId);
const takeoverStarted = await evaluate(
  cdp,
  viewer.sessionId,
  `(() => {
     navigator.mediaDevices.getDisplayMedia = async () => {
       const canvas = document.createElement('canvas');
       canvas.width = 640; canvas.height = 360;
       const ctx = canvas.getContext('2d');
       let t = 0;
       setInterval(() => {
         t += 1;
         ctx.fillStyle = 'hsl(' + ((t * 9) % 360) + ', 70%, 40%)';
         ctx.fillRect(0, 0, 640, 360);
         ctx.fillStyle = '#fff';
         ctx.font = 'bold 40px sans-serif';
         ctx.fillText('NOVO ' + t, 40, 190);
       }, 33);
       return canvas.captureStream(30);
     };
     document.getElementById('btn-share-2').click();
     return 'ok';
   })()`
);
check('espectador iniciou o takeover pela sala', takeoverStarted === 'ok');

await sleep(2500);

const newBroadcaster = await evaluate(
  cdp,
  viewer.sessionId,
  `(() => ({
     panel: document.getElementById('broadcast-panel').hidden === false,
     pill: document.getElementById('status-pill').textContent,
     recording: window.__wss.streamer.isRecording,
     bytes: window.__wss.player.bytes
   }))()`
);
check('novo transmissor mostra o painel de controle', newBroadcaster.panel === true);
check('novo transmissor esta gravando', newBroadcaster.recording === true);
check('novo transmissor marcado como AO VIVO', newBroadcaster.pill.includes('AO VIVO'), newBroadcaster.pill);

const demoted = await evaluate(
  cdp,
  broadcaster.sessionId,
  `(() => ({
     watch: document.getElementById('watch-panel').hidden === false,
     broadcast: document.getElementById('broadcast-panel').hidden === false,
     role: window.__wss.state.role
   }))()`
);
check('transmissor anterior voltou a ser espectador', demoted.role === 'viewer' && demoted.watch === true, JSON.stringify(demoted));
check('painel de compartilhamento do anterior foi ocultado', demoted.broadcast === false);

// Ao voltar para o primeiro plano, o antigo transmissor passa a ver a nova
// transmissao (o Chrome conclui a abertura do MediaSource adiada).
const demotedWidth = await waitForVideo(broadcaster.sessionId, 15000);
check('antigo transmissor passa a ver a nova transmissao', demotedWidth > 0, `videoWidth=${demotedWidth}`);

const lateStillLive = await waitForVideo(late.sessionId, 15000);
check('espectador tardio continuaRecebendo apos o takeover', lateStillLive > 0, `videoWidth=${lateStillLive}`);

// -- botao "Reconectar video": nao pode travar o espectador -----------------
const beforeRetry = await evaluate(cdp, late.sessionId, `window.__wss.player.epoch`);
await evaluate(cdp, late.sessionId, `document.getElementById('btn-retry').click(); 'ok';`);
await sleep(3000);
const afterRetry = await evaluate(
  cdp,
  late.sessionId,
  `(() => ({
     placeholder: document.getElementById('placeholder').hidden
       ? null
       : document.getElementById('placeholder-title').textContent,
     epoch: window.__wss.player.epoch,
     retrying: window.__wss.state.retrying
   }))()`
);
check(
  'reconectar video nao trava o espectador',
  afterRetry.placeholder === null && afterRetry.epoch > beforeRetry && afterRetry.retrying === false,
  JSON.stringify(afterRetry)
);

// -- sala vazia: o espectador espera, mas a tela explica a espera ------------
const empty = await newPage(cdp, `${SITE}/?room=vazio${Date.now().toString(36).slice(-4)}`);
await sleep(1200);
await evaluate(
  cdp,
  empty.sessionId,
  `document.getElementById('name-input').value = 'Espectador Sozinho';
   document.getElementById('btn-watch').click();
   'ok';`
);
await sleep(1500);
const emptyState = await evaluate(
  cdp,
  empty.sessionId,
  `(() => ({
     pill: document.getElementById('status-pill').textContent,
     placeholder: document.getElementById('placeholder').hidden
       ? null
       : document.getElementById('placeholder-title').textContent
   }))()`
);
check('sala sem transmissor explica a espera', /aguardando/i.test(emptyState.placeholder ?? ''), JSON.stringify(emptyState));
check('sala sem transmissor mostra o botao de compartilhar', await evaluate(
  cdp,
  empty.sessionId,
  `document.getElementById('watch-panel').hidden === false`
));

// Reconectar sem ninguem transmitindo nao pode deixar o texto "Reconectando..."
// preso na tela.
await evaluate(cdp, empty.sessionId, `document.getElementById('btn-retry').click(); 'ok';`);
await sleep(1500);
const emptyRetry = await evaluate(
  cdp,
  empty.sessionId,
  `(() => ({
     placeholder: document.getElementById('placeholder').hidden
       ? null
       : document.getElementById('placeholder-title').textContent,
     retrying: window.__wss.state.retrying
   }))()`
);
check(
  'reconectar sem transmissor nao fica em "Reconectando..."',
  /ninguem/i.test(emptyRetry.placeholder ?? '') && emptyRetry.retrying === false,
  JSON.stringify(emptyRetry)
);

// -- erros de console/excecoes ---------------------------------------------
const relevantErrors = errors.filter((e) => !e.includes('favicon'));
check('nenhuma excecao de JS nas abas', relevantErrors.length === 0, relevantErrors.join(' | '));

console.log(failures === 0 ? '\nE2E OK - pipeline completo funcionando.\n' : `\n${failures} verificacao(oes) falharam.\n`);
await close();
process.exit(failures === 0 ? 0 : 1);
