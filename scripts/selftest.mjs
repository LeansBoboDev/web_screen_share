/**
 * Teste automatico do relay do servidor.
 * Sobe um cliente "transmissor" e dois "espectadores" e valida:
 *  - handshake (hello/welcome)
 *  - entrada/saida de peers
 *  - retransmissao de midia binaria
 *  - chat
 *  - inicio/fim de transmissao
 *
 * Uso: npm run selftest  (o servidor precisa estar rodando)
 */
import { WebSocket } from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const URL_WS = `ws://127.0.0.1:${PORT}/ws`;
const ROOM = `teste-${Date.now().toString(36)}`;

let failures = 0;

function check(label, condition, extra = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}${extra ? ` -> ${extra}` : ''}`);
}

function connect(name) {
  const ws = new WebSocket(URL_WS);
  const client = {
    name,
    ws,
    messages: [],
    binary: [],
    waiters: [],
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      client.binary.push(data);
      client.waiters.splice(0).forEach((fn) => fn());
      return;
    }
    const msg = JSON.parse(data.toString());
    client.messages.push(msg);
    client.waiters.splice(0).forEach((fn) => fn());
  });
  client.send = (payload) => ws.send(JSON.stringify(payload));
  client.waitFor = (type, timeout = 4000, predicate = () => true) =>
    new Promise((resolve, reject) => {
      const find = () => client.messages.find((m) => m.type === type && predicate(m));
      const found = find();
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`timeout esperando "${type}" (${client.name})`)), timeout);
      const checkLoop = () => {
        const msg = find();
        if (msg) {
          clearTimeout(timer);
          resolve(msg);
          return;
        }
        client.waiters.push(checkLoop);
      };
      checkLoop();
    });
  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const broadcaster = connect('Transmissor');
const viewerA = connect('Espectador A');
const viewerB = connect('Espectador B');

await Promise.all([
  new Promise((r) => broadcaster.ws.on('open', r)),
  new Promise((r) => viewerA.ws.on('open', r)),
  new Promise((r) => viewerB.ws.on('open', r)),
]);

broadcaster.send({ type: 'hello', name: 'Transmissor', room: ROOM });
const welcomeB = await broadcaster.waitFor('welcome');
check('welcome recebido pelo transmissor', welcomeB.room === ROOM, `room=${welcomeB.room}`);
check('bem-vindo traz o proprio id', Boolean(welcomeB.id));

viewerA.send({ type: 'hello', name: 'Espectador A', room: ROOM });
await viewerA.waitFor('welcome');
viewerB.send({ type: 'hello', name: 'Espectador B', room: ROOM });
await viewerB.waitFor('welcome');

const joined = await broadcaster.waitFor('peer-joined');
check('peer-joined propagado aos outros', joined.peer?.name === 'Espectador A');

broadcaster.send({ type: 'start', mimeType: 'video/webm;codecs=vp8,opus' });
const started = await viewerA.waitFor('stream-started');
check('stream-started entregue aos viewers', started.mimeType === 'video/webm;codecs=vp8,opus');
check('epoch inicia em 1', started.epoch === 1, `epoch=${started.epoch}`);

// viewer que entra durante a transmissao recebe ready:false + need-init no broadcaster
const late = connect('Espectador C');
await new Promise((r) => late.ws.on('open', r));
late.send({ type: 'hello', name: 'Espectador C', room: ROOM });
await late.waitFor('welcome');
const lateStart = await late.waitFor('stream-started');
check('viewer tardio recebe stream-started com ready=false', lateStart.ready === false);
const needInit = await broadcaster.waitFor('need-init');
check('broadcaster recebe need-init quando alguem entra atras', needInit.peer?.name === 'Espectador C');
broadcaster.send({ type: 'restart', mimeType: 'video/webm;codecs=vp8,opus' });
const restarted = await late.waitFor('stream-started', 4000, (m) => m.ready === true);
check('viewer tardio recebe epoch nova (ready=true)', restarted.ready === true && restarted.epoch === 2);

// midia binaria: o transmissor envia e os dois viewers recebem
const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
await sleep(150);
const beforeA = viewerA.binary.length;
const beforeB = viewerB.binary.length;
broadcaster.ws.send(payload);
await sleep(250);
check('midia retransmitida para o viewer A', viewerA.binary.length > beforeA);
check('midia retransmitida para o viewer B', viewerB.binary.length > beforeB);
const received = Buffer.from(viewerA.binary.at(-1));
check('payload binario integro', received.equals(payload), `${received.toString('hex')}`);

// chat
viewerA.send({ type: 'chat', text: 'ola mundo' });
const chat = await viewerB.waitFor('chat');
check('chat retransmitido', chat.text === 'ola mundo' && chat.name === 'Espectador A');

// encerramento da transmissao
broadcaster.send({ type: 'stop' });
const stopped = await viewerA.waitFor('stream-stopped');
check('stream-stopped propagado', stopped.reason === 'stopped');

// saida de peer
viewerB.ws.close();
const left = await broadcaster.waitFor('peer-left');
check('peer-left propagado', left.peer?.name === 'Espectador B');

// takeover: um novo transmissor assume a sala
viewerA.send({ type: 'start', mimeType: 'video/webm;codecs=vp8,opus' });
const took = await late.waitFor('stream-started', 4000, (m) => m.broadcaster?.name === 'Espectador A');
check('novo transmissor assume a sala', took.broadcaster?.name === 'Espectador A');
check('epoch continua crescendo', took.epoch === 3, `epoch=${took.epoch}`);

late.send({ type: 'start', mimeType: 'video/webm;codecs=vp8,opus' });
const takenOver = await viewerA.waitFor('stream-stopped', 4000, (m) => m.reason === 'takeover');
check('broadcaster anterior e avisado do takeover', takenOver.reason === 'takeover');
const tookAgain = await viewerA.waitFor('stream-started', 4000, (m) => m.broadcaster?.name === 'Espectador C');
check('stream-started aponta o novo transmissor', tookAgain.broadcaster?.name === 'Espectador C');

// depois do takeover, so o novo transmissor retransmite midia
const beforeStale = late.binary.length;
viewerA.ws.send(Buffer.from([9, 9, 9, 9]));
await sleep(250);
check('midia do transmissor anterior e descartada', late.binary.length === beforeStale);

const beforeFresh = viewerA.binary.length;
late.ws.send(Buffer.from([7, 7, 7, 7]));
await sleep(250);
check('midia do novo transmissor chega aos viewers', viewerA.binary.length > beforeFresh);

late.ws.close();
broadcaster.ws.close();
viewerA.ws.close();

console.log(failures === 0 ? '\nTodos os testes passaram.\n' : `\n${failures} teste(s) falharam.\n`);
process.exit(failures === 0 ? 0 : 1);
