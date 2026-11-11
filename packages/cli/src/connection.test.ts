import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKEND_OFFLINE, connect, type Connection } from './connection.js';
import type { HelloFrame } from 'dsh-supervision-protocol';

interface Harness {
  readonly socketPath: string;
  /** Resolves with the first accepted peer; no polling, no sleeps. */
  readonly peer: Promise<Socket>;
  readonly close: () => void;
}

/** Unix socket paths cap near 103 bytes, so the directory stays shallow. */
function listen(): Harness {
  const dir = mkdtempSync('/tmp/dsh-sup-');
  const socketPath = join(dir, 's.sock');
  const peers: Socket[] = [];
  let accept: (socket: Socket) => void = () => {};
  const peer = new Promise<Socket>((resolve) => {
    accept = resolve;
  });
  const server: Server = createServer((socket) => {
    peers.push(socket);
    accept(socket);
  });
  server.listen(socketPath);
  return {
    socketPath,
    peer,
    close: () => {
      for (const socket of peers) socket.destroy();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Resolves with the first line the client wrote, which is always its hello. */
function readHello(socket: Socket): Promise<HelloFrame> {
  return new Promise((resolve) => {
    socket.setEncoding('utf8');
    socket.once('data', (chunk: string) => resolve(JSON.parse(chunk) as HelloFrame));
  });
}

test('hello reaches the plugin and welcome reaches the client', async () => {
  const harness = listen();
  let connection: Connection | undefined;

  const client = new Promise<string>((resolve) => {
    connection = connect(harness.socketPath, { t: 'hello', proto: 1, pid: 7, new: { cwd: '/repo' } }, {
      onFrame: (frame) => {
        if (frame.t === 'welcome') resolve(frame.session);
      },
      onLost: resolve,
      onRefused: (detail) => assert.fail(`unexpected refusal: ${detail}`),
    });
  });

  const socket = await harness.peer;
  assert.deepEqual(await readHello(socket), { t: 'hello', proto: 1, pid: 7, new: { cwd: '/repo' } });

  socket.write(
    `${JSON.stringify({ t: 'welcome', proto: 1, session: 'session-1', title: 'repo', state: 'idle', turn: 0 })}\n`,
  );
  assert.equal(await client, 'session-1');

  connection?.close();
  harness.close();
});

test('a socket that closes without welcome reports a lost backend once', async () => {
  const harness = listen();
  const reasons: string[] = [];
  const lost = new Promise<void>((resolve) => {
    connect(harness.socketPath, { t: 'hello', proto: 1, pid: 7 }, {
      onFrame: () => {},
      onLost: (msg) => {
        reasons.push(msg);
        resolve();
      },
      onRefused: (detail) => assert.fail(`unexpected refusal: ${detail}`),
    });
  });

  (await harness.peer).end();
  await lost;

  assert.deepEqual(reasons, [BACKEND_OFFLINE]);
  harness.close();
});

test('an oversized frame ends the connection and names the cap', async () => {
  const harness = listen();
  const lost = new Promise<string>((resolve) => {
    connect(harness.socketPath, { t: 'hello', proto: 1, pid: 7 }, {
      onFrame: () => {},
      onLost: (msg, detail) => resolve(`${msg}: ${detail}`),
      onRefused: (detail) => assert.fail(`unexpected refusal: ${detail}`),
    });
  });

  (await harness.peer).write('x'.repeat(65 * 1024));
  assert.match(await lost, /backend offline: frame exceeds 65536 bytes/);
  harness.close();
});

test('a frame split across writes is assembled before dispatch', async () => {
  const harness = listen();
  let connection: Connection | undefined;
  const echoes: string[] = [];

  const received = new Promise<void>((resolve) => {
    connection = connect(harness.socketPath, { t: 'hello', proto: 1, pid: 7 }, {
      onFrame: (frame) => {
        if (frame.t === 'echo') {
          echoes.push(frame.text);
          resolve();
        }
      },
      onLost: (msg) => assert.fail(`unexpected loss: ${msg}`),
      onRefused: (detail) => assert.fail(`unexpected refusal: ${detail}`),
    });
  });

  const socket = await harness.peer;
  await readHello(socket);
  const line = `${JSON.stringify({ t: 'echo', text: 'turn 1 done' })}\n`;
  socket.write(line.slice(0, 10));
  socket.write(line.slice(10));
  await received;

  assert.deepEqual(echoes, ['turn 1 done']);
  connection?.close();
  harness.close();
});

test('an oversized line is refused locally: nothing is written and no backend is lost', async () => {
  const harness = listen();
  const refusals: string[] = [];
  const losses: string[] = [];
  let connection: Connection | undefined;

  connection = connect(harness.socketPath, { t: 'hello', proto: 1, pid: 7 }, {
    onFrame: () => {},
    onLost: (msg) => losses.push(msg),
    onRefused: (detail) => refusals.push(detail),
  });

  const socket = await harness.peer;
  await readHello(socket);
  const written: string[] = [];
  socket.on('data', (chunk: string) => written.push(chunk));

  connection.send({ t: 'line', text: 'x'.repeat(65 * 1024) });
  // Give a stray write every chance to arrive before asserting it never happened.
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(refusals[0] ?? '', /frame exceeds 65536 bytes/);
  assert.deepEqual(losses, []);
  assert.deepEqual(written, []);

  connection.close();
  harness.close();
});

test('a refused line leaves the bridge usable for the next line', async () => {
  const harness = listen();
  const received: string[] = [];
  let arrived: () => void = () => {};
  const smallArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });

  const connection = connect(harness.socketPath, { t: 'hello', proto: 1, pid: 7 }, {
    onFrame: () => {},
    onLost: (msg) => assert.fail(`unexpected loss: ${msg}`),
    onRefused: () => {},
  });

  const socket = await harness.peer;
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line === '') continue;
      received.push(line);
      if (line.includes('"small"')) arrived();
    }
  });

  connection.send({ t: 'line', text: 'x'.repeat(65 * 1024) });
  connection.send({ t: 'line', text: 'small' });
  await smallArrived;

  // The oversized text never crossed the socket; the bridge is still up.
  assert.deepEqual(
    received.filter((line) => !line.includes('"hello"')).map((line) => JSON.parse(line) as unknown),
    [{ t: 'line', text: 'small' }],
  );
  connection.close();
  harness.close();
});
