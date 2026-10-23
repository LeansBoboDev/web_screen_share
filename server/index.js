import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer } from 'ws';

import { RoomManager } from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

/**
 * Versao do codigo em execucao, calculada ao iniciar o servidor.
 *  - label: commit do git (com "*" se houver alteracoes nao commitadas),
 *    para comparar com `git log`.
 *  - id: hash do conteudo de public/ e server/. E o que o navegador usa
 *    para saber se a pagina aberta ficou desatualizada.
 */
function computeVersion() {
  const hash = createHash('sha1');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(path.relative(ROOT, full)).update(fs.readFileSync(full));
    }
  };
  walk(path.join(ROOT, 'public'));
  walk(path.join(ROOT, 'server'));
  const id = hash.digest('hex').slice(0, 8);

  let label = id;
  try {
    const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    label = git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain') ? '*' : '');
  } catch {
    /* sem git: fica so o hash do conteudo */
  }
  return { id, label };
}

const VERSION = computeVersion();

const app = express();
app.disable('x-powered-by');

// Versao embutida na pagina. Nunca vai para o cache: e lida a cada carga.
app.get('/js/version.js', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript');
  res.send(`export const VERSION = ${JSON.stringify(VERSION)};\n`);
});

// Site estatico (public/)
app.use(
  express.static(path.join(ROOT, 'public'), {
    extensions: ['html'],
    maxAge: '0h',
  })
);

// Endpoint simples de health-check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: VERSION, uptime: process.uptime(), rooms: manager.stats() });
});

const server = http.createServer(app);

// WebSocket: canal de sinalizacao + retransmissao da midia
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 * 1024 });

const manager = new RoomManager({ version: VERSION.id });

wss.on('connection', (ws, req) => {
  manager.handleConnection(ws, req);
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  web_screen_share rodando em http://${shown}:${PORT}`);
  console.log(`  versao ${VERSION.label} (${VERSION.id})\n`);
});

function shutdown(signal) {
  console.log(`\n${signal} recebido, encerrando...`);
  manager.closeAll();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
