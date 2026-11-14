/**
 * The human sink's failure path: a terminal that vanishes mid-attach raises
 * `error` on stdout, and the forwarder must settle instead of dying on an
 * unhandled stream error. The child runs the real `main.js` with a preloaded
 * stdout that is a TTY and fails every write, because no test can close a pty.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROTO } from 'dsh-supervision-protocol';
import { EXIT } from './exit.js';

const MAIN = fileURLToPath(new URL('./main.js', import.meta.url));

/** A stdout that claims a terminal, then fails each write asynchronously. */
const STUB = `
import { EventEmitter } from 'node:events';
class FailingStdout extends EventEmitter {
  isTTY = true;
  columns = 80;
  write() {
    process.nextTick(() => this.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
    return true;
  }
}
Object.defineProperty(process, 'stdout', { value: new FailingStdout(), configurable: true });
`;

/** A backend that greets one attach, then sends a mirror frame to stdout. */
function backend(socket: string): Server {
  const server = createServer((peer: Socket) => {
    peer.setEncoding('utf8');
    peer.once('data', () => {
      peer.write(`${JSON.stringify({ t: 'welcome', proto: PROTO, session: 'session-1', title: 'demo', state: 'working', turn: 0 })}\n`);
      peer.write(`${JSON.stringify({ t: 'mirror', item: { k: 'user', text: 'on the human sink' } })}\n`);
    });
  });
  server.listen(socket);
  return server;
}

test('a stdout write failure settles the bridge instead of crashing the forwarder', async (t) => {
  const dir = mkdtempSync('/tmp/dsh-stdout-');
  const socket = join(dir, 'a.sock');
  const server = backend(socket);
  const stub = join(dir, 'stdout.mjs');
  writeFileSync(stub, STUB);
  const home = join(dir, 'home');
  mkdirSync(join(home, 'supervision'), { recursive: true });
  writeFileSync(
    join(home, 'supervision', `${String(process.pid)}-00000001.json`),
    JSON.stringify({ proto: PROTO, pid: process.pid, socket, startedAt: 1, dshVersion: 'x' }),
  );
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const child = spawn(process.execPath, ['--import', stub, MAIN, 'attach', 'session-1'], {
    env: { ...process.env, DSH_HOME: home },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const [code] = (await once(child, 'close')) as [number | null];

  // Without the guard this is an uncaught `write EPIPE` and a non-zero crash.
  assert.equal(code, EXIT.backendLost);
  assert.doesNotMatch(stderr, /Unhandled 'error' event|EPIPE/);
});
