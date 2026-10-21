/**
 * Teste end-to-end com CAPTURA DE TELA REAL.
 *
 * O e2e.mjs usa captura falsa (canvas) para nao depender de permissao. Este
 * teste cobre o caminho real: `getDisplayMedia()` de verdade, em DOIS
 * navegadores separados (processos distintos), que e como as pessoas usam.
 *
 * O Chrome headless escolhe a fonte automaticamente com a flag
 * `--auto-select-desktop-capture-source=Entire screen`.
 *
 * Uso: npm run e2e:real   (o servidor precisa estar rodando)
 */
import { launchBrowser, newPage, evaluate, sleep, bringToFront } from './lib/cdp.mjs';

const PORT = Number(process.env.PORT) || 8080;
const SITE = `http://localhost:${PORT}`;
const CAPTURE_ARGS = ['--auto-select-desktop-capture-source=Entire screen'];

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

const errors = [];
function hook(cdp, tag) {
  cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
    errors.push(`[${tag}] ${params.exceptionDetails?.exception?.description ?? 'excecao'}`);
  });
  cdp.on('Runtime.consoleAPICalled', (params) => {
    const text = params.args.map((a) => a.value ?? a.description).join(' ');
    if (params.type === 'error') errors.push(`[${tag}] console.error: ${text}`);
  });
}

// Dois navegadores SEPARADOS (processos distintos), como no uso real.
const A = await launchBrowser(9350, CAPTURE_ARGS);
const B = await launchBrowser(9351, CAPTURE_ARGS);
hook(A.cdp, 'A');
hook(B.cdp, 'B');

const room = `real${Date.now().toString(36).slice(-5)}`;
const url = `${SITE}/?room=${room}`;

const tabA = await newPage(A.cdp, url);
const tabB = await newPage(B.cdp, url);
await sleep(1500);

const DUMP = `
  (() => ({
    role: window.__wss.state.role,
    pill: document.getElementById('status-pill').textContent,
    placeholder: document.getElementById('placeholder').hidden
      ? null
      : document.getElementById('placeholder-title').textContent,
    sharing: document.getElementById('video-wrap').classList.contains('is-sharing'),
    previewW: document.getElementById('preview').videoWidth,
    videoW: document.getElementById('video').videoWidth,
    videoReady: document.getElementById('video').readyState,
    mime: window.__wss.state.mimeType,
    recording: window.__wss.streamer.isRecording,
    bytes: window.__wss.player.bytes,
    dropped: window.__wss.player.dropped,
    msState: window.__wss.player.mediaSource ? window.__wss.player.mediaSource.readyState : null
  }))()
`;

// -- 1) transmissor captura a tela de verdade --------------------------------
await evaluate(
  A.cdp,
  tabA.sessionId,
  `document.getElementById('name-input').value = 'Transmissor';
   document.getElementById('btn-share').click();
   'ok';`
);
await sleep(4000);

const a1 = await evaluate(A.cdp, tabA.sessionId, DUMP);
check('captura real de tela iniciada', a1.recording === true, `mime=${a1.mime}`);
check('transmissor marcado como AO VIVO', a1.pill.includes('AO VIVO'), a1.pill);
check('transmissor ve a previa local (sem "carregando" eterno)', a1.sharing === true && a1.previewW > 0, `preview=${a1.previewW}px`);
check('transmissor nao fica girando no placeholder', a1.placeholder === null, `placeholder=${a1.placeholder}`);

// -- 2) espectador entra depois e recebe a imagem ----------------------------
await evaluate(
  B.cdp,
  tabB.sessionId,
  `document.getElementById('name-input').value = 'Espectador';
   document.getElementById('btn-watch').click();
   'ok';`
);
await sleep(3000);
await bringToFront(B.cdp, tabB.sessionId);

// Espera aparecer um frame de verdade (readyState >= 2), nao so as dimensoes.
let b1 = await evaluate(B.cdp, tabB.sessionId, DUMP);
for (let i = 0; i < 20 && b1.videoReady < 2; i += 1) {
  await sleep(500);
  b1 = await evaluate(B.cdp, tabB.sessionId, DUMP);
}

check('espectador decodifica a midia real', b1.videoW > 0 && b1.videoReady >= 2, `videoWidth=${b1.videoW} readyState=${b1.videoReady}`);
check('espectador recebeu bytes pelo servidor', b1.bytes > 0, `bytes=${b1.bytes}`);
check('MediaSource do espectador esta aberto', b1.msState === 'open', `ms=${b1.msState}`);
check('espectador marcado como AO VIVO', b1.pill.includes('AO VIVO'), b1.pill);

// -- 3) ordem inversa: espectador entra antes do transmissor -----------------
const room2 = `inv${Date.now().toString(36).slice(-5)}`;
const url2 = `${SITE}/?room=${room2}`;
const tabA2 = await newPage(A.cdp, url2);
const tabB2 = await newPage(B.cdp, url2);
await sleep(1500);

// Garante que a aba do espectador 2 fique em segundo plano (a aba 1 do
// navegador B continua em primeiro plano).
await bringToFront(B.cdp, tabB.sessionId);
await sleep(500);

await evaluate(
  B.cdp,
  tabB2.sessionId,
  `document.getElementById('name-input').value = 'Espectador 2';
   document.getElementById('btn-watch').click();
   'ok';`
);
await sleep(2000);
const b2before = await evaluate(B.cdp, tabB2.sessionId, DUMP);
check('espectador que entrou antes explica a espera', /aguardando/i.test(b2before.placeholder ?? ''), `placeholder=${b2before.placeholder}`);

await evaluate(
  A.cdp,
  tabA2.sessionId,
  `document.getElementById('name-input').value = 'Transmissor 2';
   document.getElementById('btn-share').click();
   'ok';`
);
await sleep(4000);

// A aba do espectador fica em segundo plano por ~20 s. O Chrome adia a
// abertura do MediaSource, a fila de chunks estoura e o fluxo chega
// quebrado: e exatamente o cenario que deixava o video preso em
// "carregando" para sempre.
await sleep(20000);
const hidden = await evaluate(B.cdp, tabB2.sessionId, DUMP);
check(
  'aba oculta avisa que o video fica pausado',
  /segundo plano/i.test(hidden.placeholder ?? ''),
  `placeholder=${hidden.placeholder}`
);
check(
  'fila de chunks estoura com a aba oculta (fluxo quebrado)',
  hidden.dropped > 0,
  `dropped=${hidden.dropped}`
);

await bringToFront(B.cdp, tabB2.sessionId);

let b2 = await evaluate(B.cdp, tabB2.sessionId, DUMP);
for (let i = 0; i < 40 && b2.videoReady < 2; i += 1) {
  await sleep(500);
  b2 = await evaluate(B.cdp, tabB2.sessionId, DUMP);
}
check('espectador que entrou antes recebe a imagem', b2.videoW > 0 && b2.videoReady >= 2, `videoWidth=${b2.videoW} readyState=${b2.videoReady}`);
check(
  'espectador se recupera sozinho depois de esconder a aba',
  b2.videoReady >= 2 && b2.placeholder === null,
  `readyState=${b2.videoReady} placeholder=${b2.placeholder}`
);

const relevantErrors = errors.filter((e) => !e.includes('favicon'));
check('nenhuma excecao de JS nos navegadores', relevantErrors.length === 0, relevantErrors.join(' | '));

console.log(
  failures === 0
    ? '\nE2E REAL OK - captura de tela real funcionando em dois navegadores.\n'
    : `\n${failures} verificacao(oes) falharam.\n`
);

A.close();
B.close();
process.exit(failures === 0 ? 0 : 1);
