/**
 * Cliente minimo do Chrome DevTools Protocol (CDP) via WebSocket nativo.
 * Usado pelos testes automatizados (scripts/e2e.mjs).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class Cdp {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error(`cdp connect: ${e.message ?? 'erro'}`)));
      this.ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? '')}`));
          else res(msg.result);
          return;
        }
        if (msg.method) {
          for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
        }
      });
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout no comando ${method}`));
        }
      }, 20000);
    });
  }

  on(method, fn) {
    const list = this.handlers.get(method) ?? [];
    list.push(fn);
    this.handlers.set(method, list);
  }
}

/** Sobe um navegador headless e devolve { cdp, close }. */
export async function launchBrowser(port = 9333) {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Nenhum navegador (Chrome/Edge) encontrado.');

  const userDataDir = mkdtempSync(path.join(tmpdir(), 'wss-cdp-'));
  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu',
      '--use-fake-ui-for-media-stream',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  const close = () => {
    try {
      browser.kill();
    } catch {
      /* ignore */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  let version = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) {
    close();
    throw new Error('Nao foi possivel iniciar o navegador headless.');
  }

  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.connect();
  return { cdp, close, port };
}

/** Abre uma aba nova e retorna { targetId, sessionId }. */
export async function newPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  if (url) await cdp.send('Page.navigate', { url }, sessionId);
  return { targetId, sessionId };
}

/** Avalia uma expressao na aba e devolve o valor. */
export async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'erro na avaliacao');
  }
  return result.result.value;
}

/**
 * Coloca a aba em primeiro plano.
 *
 * Importante: o Chrome adia o evento 'sourceopen' do MediaSource enquanto a
 * aba esta oculta, entao a midia so decodifica com a aba visivel.
 */
export async function bringToFront(cdp, sessionId) {
  await cdp.send('Page.bringToFront', {}, sessionId);
  await sleep(250);
}
