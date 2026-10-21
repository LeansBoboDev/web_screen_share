# web_screen_share

Compartilhamento de tela **sem senha e sem cadastro**: voce escolhe um nome, clica em
**Compartilhar minha tela** e quem estiver na sala passa a ver a sua imagem na hora.

A midia **passa pelo servidor**: o transmissor grava a tela com `MediaRecorder`, envia os
chunks para o servidor via WebSocket e o servidor retransmite, sem alterar, para todos os
espectadores da sala.

```
navegador (transmissor)  --MediaRecorder-->  chunks binarios  --WebSocket-->  servidor
                                                                              |
navegador (espectador)  <--MediaSource (MSE)--  chunks binarios  <--WebSocket--+
```

- **Sala padrao:** `principal`
- **Outras salas:** `http://localhost:8080/?room=minha-sala` (ou use o botao **Gerar sala**)
- **Sem autenticacao:** qualquer pessoa com o link entra e assiste.

---

## Como rodar

Requisitos: **Node.js 18+** e um navegador recente (Chrome, Edge ou Firefox).

```bash
npm install
npm start
```

O servidor sobe em `http://localhost:8080`.

Variaveis de ambiente opcionais:

| Variavel | Padrao   | Descricao                       |
| -------- | -------- | ------------------------------- |
| `PORT`   | `8080`   | Porta HTTP/WebSocket            |
| `HOST`   | `0.0.0.0`| Interface de escuta              |

```bash
PORT=3000 npm start
```

### Uso

1. Abra `http://localhost:8080`.
2. Digite um **nome** (obrigatorio).
3. Escolha a **sala** (padrao `principal`) e, se quiser, ative as opcoes de captura em
   *Opcoes de captura* (audio do sistema e microfone).
4. Clique em **Compartilhar minha tela** e escolha a aba/janela/tela no seletor do
   navegador. Clique em **Apenas assistir** para so acompanhar.
5. Clique em **Copiar link** e envie para quem quiser assistir. Quem abrir o link entra
   direto na sala e ve a transmissao.
6. Durante a transmissao voce pode ligar/desligar microfone e audio do sistema, trocar a
   fonte da tela, capturar uma imagem (PNG) ou colocar em tela cheia.

Quem esta na sala tambem tem **chat** ao lado do video e a lista de participantes.
Quem estava apenas assistindo pode assumir a transmissao a qualquer momento pelo botao
**Compartilhar minha tela** (painel *Visualizando*) — o transmissor anterior volta a ser
espectador.

---

## Como funciona

### Captura (navegador do transmissor)

- `getDisplayMedia()` abre o seletor de tela do proprio navegador.
- O audio do sistema e opcional e so existe quando se compartilha uma **aba ou janela**
  no Chrome/Edge (marque *Compartilhar audio da aba* no seletor).
- O microfone e capturado a parte, via `getUserMedia`, e pode ser ligado depois.
- As duas faixas de audio sao misturadas em um `AudioContext` e combinadas com o video
  num unico `MediaStream`.
- O `MediaRecorder` fatia o stream em chunks de 250 ms.

### Transporte e retransmissao

- **Controle** (JSON): `hello`, `start`, `restart`, `stop`, `chat`, `need-init`.
- **Midia** (binario opaco): os chunks sao repassados byte a byte, sem recodificar.
- Cada sala tem **um** transmissor por vez; se alguem novo compartilhar, o anterior e
  avisado e vira espectador.
- Cliente lento (buffer do socket > 8 MB) tem quadros descartados em vez de acumular
  memoria no servidor.
- Keepalive via `ping`/`pong` a cada 30 s: sockets mortos sao derrubados.

### Decodificao (navegador do espectador)

- Os chunks chegam em frames binarios e vao para um `MediaSource` (MSE) via
  `SourceBuffer`.
- A cada mudanca de transmissao o `MediaSource` e recriado (nova *epoch*), porque o
  navegador so decodifica um stream a partir do seu cabecalho (*init segment*).
- Quando alguem entra no meio da transmissao, o servidor avisa o transmissor com
  `need-init`; o transmissor reinicia o gravador e reenvia o cabecalho. Se o aviso se
  perder, o espectador pede `need-init` de novo periodicamente.

### Mensagens do protocolo

| Direcao | Mensagem            | Quando                                              |
| ------- | ------------------- | --------------------------------------------------- |
| -> servidor | `hello`         | entrada na sala (nome + sala)                       |
| -> servidor | `start`         | comeca a compartilhar                                 |
| -> servidor | `restart`       | nova epoch (troca de fonte / novo init segment)      |
| -> servidor | `stop`          | para de compartilhar                                 |
| -> servidor | `chat`          | mensagem no chat                                     |
| -> servidor | `need-init`      | pede o cabecalho do stream                           |
| servidor -> | `welcome`      | confirmacao de entrada (id, peers, epoch)            |
| servidor -> | `peer-joined` | alguem entrou na sala                                |
| servidor -> | `peer-left`   | alguem saiu da sala                                  |
| servidor -> | `stream-started` | transmissao iniciada/renovada (epoch + mimeType)     |
| servidor -> | `stream-stopped`| transmissao encerrada (ou substituida)        |
| servidor -> | `need-init`   | pedido de cabecalho (vai para o transmissor)         |
| servidor -> | `chat`        | mensagem de chat                                     |
| servidor -> | `error`       | erro de protocolo                                    |

---

## Testes

O servidor precisa estar rodando (`npm start`) em outra aba.

```bash
npm run selftest   # protocolo do relay: handshake, peers, epoch, midia binaria, chat, takeover
npm run e2e        # navegador real (Chrome/Edge headless via CDP): captura -> MSE -> <video>
npm test           # os dois em sequencia
```

O `selftest` sobe tres clientes WebSocket e valida o protocolo do servidor (entrada e
saida de peers, *epochs*, retransmissao binaria intacta, chat e troca de transmissor).

O `e2e` abre tres abas na mesma sala (um transmissor com captura falsa gerada por
`canvas`, um espectador e um espectador que entra no meio da transmissao), verifica que o
video decodifica, que o chat funciona, que a troca de transmissor funciona e que nao ha
excecao de JavaScript.

> O Chrome so decodifica com a aba visivel, entao o teste traz cada aba para o primeiro
> plano antes de conferir a imagem.

---

## Limitacoes conhecidas

- **Contexto seguro obrigatorio.** `getDisplayMedia` so funciona em `localhost` ou em
  `https://`. Para acessar de outra maquina, use um proxy com TLS ou um tunel.
- **Audio do sistema.** Depende do navegador e de como a tela foi compartilhada: no
  Chrome/Edge, compartilhe uma **aba** ou **janela** e marque *Compartilhar audio da aba*.
  Tela inteira e Firefox podem nao expor audio.
- **O servidor e um gargalo proposital.** Como a midia e retransmitida pelo servidor, o
  consumo de banda dele cresce com o numero de espectadores (aprox. 2,6 Mbps por
  espectador no video). Para muitos espectadores, um servidor de SFU/UDP seria melhor.
- **Latencia.** Sao ~250 ms de chunk mais o caminho de ida e volta pelo servidor.
- **Um transmissor por sala.** Uma segunda pessoa que compartilhar assume a transmissao e
  o transmissor anterior volta a ser espectador.
- **Sem gravacao.** Nada e gravado no servidor; o chat tambem so existe enquanto a sala
  estiver aberta.
- **Safari** nao suporta bem `MediaSource` com `video/webm` gerado por `MediaRecorder`;
  use Chrome ou Edge para assistir.
- **Aba em segundo plano.** O Chrome adia a abertura do `MediaSource` enquanto a aba
  esta oculta: o video em si continua tocando, mas se a transmissao reiniciar (nova
  *epoch*) com a aba escondida, a imagem so volta ao voltar para a aba. Os chunks que
  chegam nesse periodo ficam em uma fila limitada, para nao acumular memoria.

---

## Estrutura do projeto

```
server/
  index.js          Express (site estatico) + WebSocketServer em /ws
  rooms.js          salas, epochs, retransmissao de midia, chat, keepalive
public/
  index.html        tela de entrada + sala
  css/styles.css    tema escuro, layout responsivo
  js/app.js         glue de UI/estado
  js/net.js         WebSocket com reconexao exponencial e fila de saida
  js/streamer.js    captura, mixagem de audio, gravacao (MediaRecorder)
  js/player.js      decodificacao via MediaSource (MSE)
scripts/
  selftest.mjs      teste do protocolo do servidor
  e2e.mjs           teste ponta a ponta em navegador (CDP)
  lib/cdp.mjs       cliente CDP reutilizavel
```

## Licenca

MIT
