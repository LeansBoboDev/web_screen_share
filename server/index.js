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

const app = express();
app.disable('x-powered-by');

// Site estatico (public/)
app.use(
  express.static(path.join(ROOT, 'public'), {
    extensions: ['html'],
    maxAge: '0h',
  })
);

// Endpoint simples de health-check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), rooms: manager.stats() });
});

const server = http.createServer(app);

// WebSocket: canal de sinalizacao + retransmissao da midia
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 * 1024 });

const manager = new RoomManager();

wss.on('connection', (ws, req) => {
  manager.handleConnection(ws, req);
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  web_screen_share rodando em http://${shown}:${PORT}\n`);
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
