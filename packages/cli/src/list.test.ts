import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { SessionItem } from 'dsh-supervision-protocol';
import { EXIT } from './exit.js';

const MAIN = fileURLToPath(new URL('./main.js', import.meta.url));

interface Backend {
  readonly socket: string;
  readonly close: () => void;
}

function listen(socket: string, onPeer: (socket: Socket) => void): Backend {
  const server: Server = createServer(onPeer);
  server.listen(socket);
  return { socket, close: () => server.close() };
}

/** A backend that answers `list` with `items`. */
function healthy(dir: string, name: string, items: readonly SessionItem[]): Backend {
  return listen(join(dir, `${name}.sock`), (socket) => {
    socket.setEncoding('utf8');
    socket.once('data', () => {
      socket.write(`${JSON.stringify({ t: 'sessions', items })}\n`);
    });
  });
}

/** A backend that accepted the socket and then died, as a crashing plugin does. */
function dying(dir: string, name: string): Backend {
  return listen(join(dir, `${name}.sock`), (socket) => socket.destroy());
}

/** A backend that answers `list` with one arbitrary frame, as `bye`/`error` do. */
function answering(dir: string, name: string, frame: object): Backend {
  return listen(join(dir, `${name}.sock`), (socket) => {
    socket.setEncoding('utf8');
    socket.once('data', () => {
      socket.write(`${JSON.stringify(frame)}\n`);
    });
  });
}

const items: readonly SessionItem[] = [
  { id: 'session-1', cwd: '/repo', live: true, bridged: false },
  { id: 'session-2', cwd: '/other', live: false, bridged: true },
];

const HEADER = 'SESSION\tCWD\tLIVE\tBRIDGED';
const ROWS = ['session-1\t/repo\tyes\t-', 'session-2\t/other\tno\tyes'];

/**
 * Runs `dsh-sup list` against a temporary supervision registry. The listing
 * writes its table to stdout, so a real process is the faithful assertion.
 */
function list(
  backends: readonly Backend[],
  extra: readonly string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const home = mkdtempSync('/tmp/dsh-list-home-');
  const registry = join(home, 'supervision');
  mkdirSync(registry, { recursive: true });
  backends.forEach((backend, index) => {
    writeFileSync(
      join(registry, `${String(process.pid)}-0000000${String(index)}.json`),
      JSON.stringify({ proto: 1, pid: process.pid, socket: backend.socket, startedAt: 1, dshVersion: 'x' }),
    );
  });

  const child = spawn(process.execPath, [MAIN, 'list', ...extra], { env: { ...process.env, DSH_HOME: home } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  return new Promise((resolve) => {
    child.on('close', (code) => {
      rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

/** The table is order-independent: registry reading order does not matter. */
const rows = (stdout: string): string[] => stdout.split('\n').filter((line) => line !== '').sort();
const expected = [HEADER, ...ROWS].sort();

test('a live backend that cannot answer fails the listing but keeps the healthy rows', async (t) => {
  const dir = mkdtempSync('/tmp/dsh-list-');
  const good = healthy(dir, 'a', items);
  const bad = dying(dir, 'b');
  t.after(() => {
    good.close();
    bad.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await list([good, bad]);

  assert.equal(result.code, EXIT.backendLost);
  assert.deepEqual(rows(result.stdout), expected);
  assert.notEqual(result.stderr.trim(), '', 'the failed backend still explains itself on stderr');
});

test('every live backend answering lists them all and exits 0', async (t) => {
  const dir = mkdtempSync('/tmp/dsh-list-');
  const first = healthy(dir, 'a', items.slice(0, 1));
  const second = healthy(dir, 'b', items.slice(1));
  t.after(() => {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await list([first, second]);

  assert.equal(result.code, EXIT.ok);
  assert.equal(result.stderr, '');
  assert.deepEqual(rows(result.stdout), expected);
});

test('a backend answering a protocol error exits 6, its own ADR code', async (t) => {
  const dir = mkdtempSync('/tmp/dsh-list-');
  const good = healthy(dir, 'a', items);
  const refused = answering(dir, 'b', { t: 'error', code: 'protocol', message: 'frame exceeds 65536 bytes' });
  t.after(() => {
    good.close();
    refused.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await list([good, refused]);

  // Nothing was lost: the backend is alive and answered, so the exit must not
  // claim a lost backend and send a supervisor off restarting a healthy one.
  assert.equal(result.code, EXIT.protocol);
  assert.deepEqual(rows(result.stdout), expected);
  assert.match(result.stderr, /protocol: frame exceeds/);
});

test('a frame refused locally exits 6, never 1', async (t) => {
  const dir = mkdtempSync('/tmp/dsh-list-');
  const good = healthy(dir, 'a', items);
  // The request itself is past MAX_FRAME, so `encodeFrame` refuses it here and
  // no byte ever reaches the socket: this is a local refusal, not a loss.
  const result = await list([good], ['--cwd', `/${'a'.repeat(70_000)}`]);
  t.after(() => {
    good.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(result.code, EXIT.protocol);
  assert.match(result.stderr, /frame exceeds/);
});

test('a backend answering bye explains itself on stderr and exits 1', async (t) => {
  const dir = mkdtempSync('/tmp/dsh-list-');
  const good = healthy(dir, 'a', items);
  const leaving = answering(dir, 'b', { t: 'bye', reason: 'plugin-disposed' });
  t.after(() => {
    good.close();
    leaving.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await list([good, leaving]);

  // A disposing backend is a lost backend for this listing, but the operator
  // must be able to tell it from a vanished one.
  assert.equal(result.code, EXIT.backendLost);
  assert.match(result.stderr, /plugin-disposed/);
  assert.deepEqual(rows(result.stdout), expected);
});
