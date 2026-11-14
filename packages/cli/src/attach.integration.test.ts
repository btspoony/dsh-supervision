/**
 * End-to-end attach: the built forwarder under a real pseudo-TTY, wired to a
 * fake backend through the same Unix socket and registry the plugin uses. This
 * is the plan's §4 TUI smoke as a repeatable test: a typed line must reach the
 * socket, the alternate screen must be entered and left once, and the terminal
 * must be restored before a clean exit.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROTO, decodeFrame, encodeFrame, type InFrame, type OutFrame } from 'dsh-supervision-protocol';

const SESSION = 'session-pty';
const TYPED = 'hello from the pty';
/** How long one handshake, keystroke round trip or exit may take. */
const PATIENCE_MS = 10_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` holds; a timeout names what never happened. */
async function waitFor(what: string, check: () => boolean, timeoutMs: number = PATIENCE_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

/** Bounds a promise, so a child that never exits fails instead of hanging the runner. */
async function within<T>(what: string, promise: Promise<T>, timeoutMs: number = PATIENCE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`timed out waiting for ${what}`)); }, timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** A backend that speaks the plugin's half of the protocol and records what it hears. */
interface FakeBackend {
  readonly received: InFrame[];
  close(): Promise<void>;
}

function startBackend(socketPath: string): Promise<FakeBackend> {
  const received: InFrame[] = [];
  const peers = new Set<Socket>();
  const send = (socket: Socket, frame: OutFrame): void => {
    socket.write(encodeFrame(frame));
  };
  const server: Server = createServer((socket: Socket) => {
    peers.add(socket);
    socket.setEncoding('utf8');
    let rest = '';
    socket.on('data', (chunk: string) => {
      rest += chunk;
      for (;;) {
        const end = rest.indexOf('\n');
        if (end === -1) break;
        const line = rest.slice(0, end);
        rest = rest.slice(end + 1);
        if (line === '') continue;
        const frame = decodeFrame(line);
        if (frame === undefined) continue;
        received.push(frame);
        // Welcome is what starts the surface, so the mirror frame right after it
        // is the replay the viewport must show.
        if (frame.t === 'hello') {
          send(socket, { t: 'welcome', proto: PROTO, session: SESSION, title: 'fake session', state: 'idle', turn: 0 });
          // The catalog feeds the slash menu; the test types '/' and expects a row.
          send(socket, {
            t: 'catalog',
            skills: [{ name: 'demo-skill', description: 'a demo skill from the catalog' }],
            commands: [{ name: 'status', description: 'show session state' }],
          });
          send(socket, { t: 'mirror', item: { k: 'user', text: 'replayed line' } });
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { peers.delete(socket); });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      resolve({
        received,
        close: () =>
          new Promise<void>((done) => {
            for (const peer of peers) peer.destroy();
            server.close(() => { done(); });
          }),
      });
    });
  });
}

/** Single-quotes one word for the POSIX shell that wires the pipeline. */
function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `script` invocation that wraps `command` in a pseudo-TTY. `script` reads
 * its stdin as the pty's keys, so the test feeds it through a shell pipeline: a
 * Node-created pipe is a socketpair on macOS, which `script` refuses.
 */
function scriptCommand(script: string, command: readonly string[]): string {
  const run = command.map(shellQuote).join(' ');
  return process.platform === 'linux'
    ? `${shellQuote(script)} -q -c ${shellQuote(run)} /dev/null`
    : `${shellQuote(script)} -q /dev/null ${run}`;
}

test('an attach through a pty submits a typed line and restores the screen', async (t) => {
  const script = ['/usr/bin/script', '/bin/script'].find((path) => existsSync(path));
  if (script === undefined) {
    t.skip('script(1) is not available, so no pseudo-TTY can be opened');
    return;
  }

  const home = mkdtempSync(join(tmpdir(), 'dsup-pty-'));
  const supervision = join(home, 'supervision');
  mkdirSync(supervision, { recursive: true, mode: 0o700 });
  const socketPath = join(supervision, 'fake.sock');
  const backend = await startBackend(socketPath);
  // The entry names this process as the backend: only a live pid plus an
  // existing socket is selectable.
  writeFileSync(
    join(supervision, `${String(process.pid)}-a1b2c3d4.json`),
    `${JSON.stringify({ proto: PROTO, pid: process.pid, socket: socketPath, startedAt: Date.now(), dshVersion: 'test' })}\n`,
  );

  const main = new URL('./main.js', import.meta.url).pathname;
  // Two files gate the keystrokes: one says the surface is up, the other that
  // the backend saw the line. Neither side has to guess a delay.
  const ready = join(home, 'ready');
  const menu = join(home, 'menu');
  const go = join(home, 'go');
  const keys = [
    `while [ ! -f ${shellQuote(ready)} ]; do sleep 0.05; done`,
    // '/' opens the catalog menu; Esc must close it without cancelling the turn.
    `printf '/'`,
    `while [ ! -f ${shellQuote(menu)} ]; do sleep 0.05; done`,
    `printf '\\033'`,
    // Esc closes the menu but keeps the typed '/', so clear that line first.
    // A pause lets the terminal parser settle the lone ESC before the next byte,
    // otherwise ESC+Ctrl+U would read as one Alt sequence.
    `sleep 0.4`,
    `printf '\\025'`,
    `sleep 0.2`,
    `printf '%s\\r' ${shellQuote(TYPED)}`,
    `while [ ! -f ${shellQuote(go)} ]; do sleep 0.05; done`,
    `printf '\\004'`,
  ].join('\n');
  const pipeline = `(\n${keys}\n) | ${scriptCommand(script, [process.execPath, main, 'attach', SESSION])}`;
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn('/bin/sh', ['-c', pipeline], {
    env: { ...process.env, DSH_HOME: home, TERM: 'xterm-256color' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so a failed assertion can kill the pty's children
    // too instead of leaving an orphan that keeps the test runner alive.
    detached: true,
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { err += chunk; });
  const exited = new Promise<number | null>((resolve) => { child.on('exit', (code) => resolve(code)); });

  try {
    try {
      await waitFor('the alternate screen to be entered', () => out.includes('\x1b[?1049h'));
    } catch (error) {
      throw new Error(
        `${(error as Error).message}; exit=${String(child.exitCode)} out=${JSON.stringify(out.slice(-400))} err=${JSON.stringify(err.slice(-400))}`,
      );
    }
    writeFileSync(ready, '');
    await waitFor('the catalog menu to list the skill', () => out.includes('demo-skill'));
    writeFileSync(menu, '');
    await waitFor(`the backend to receive line ${JSON.stringify(TYPED)}`, () =>
      backend.received.some((frame) => frame.t === 'line' && frame.text === TYPED));
    assert.deepEqual(
      backend.received.filter((frame) => frame.t === 'line'),
      [{ t: 'line', text: TYPED }],
      `the pty line reached the socket exactly once; stderr: ${err}`,
    );
    // Esc closed the menu instead of cancelling the turn.
    assert.deepEqual(
      backend.received.filter((frame) => frame.t === 'line' && frame.text === '/cancel'),
      [],
      'Esc with the menu open must not send /cancel',
    );

    writeFileSync(go, '');
    const code = await within('the attach to exit after Ctrl+D', exited);

    const enter = out.split('\x1b[?1049h').length - 1;
    const leave = out.split('\x1b[?1049l').length - 1;
    // macOS `script` returns the child's status itself; util-linux reports its
    // own unless it accepts `-e`, so there the restore assertions below are the
    // evidence and the recorded status is reported rather than asserted.
    if (process.platform === 'linux') {
      t.diagnostic(`script reported ${String(code)}; its status is script's own on Linux, restore is asserted below`);
    } else {
      assert.equal(code, 0, `plain exit after Ctrl+D; stderr: ${err}`);
    }
    assert.equal(enter, 1, `one alternate-screen entry; stderr: ${err}`);
    assert.equal(leave, 1, `one alternate-screen leave; stderr: ${err}`);
    assert.ok(out.includes('replayed line'), 'the replayed mirror frame reached the viewport');
    // The package disables bracketed paste in `terminal.stop()` and leaves the
    // alternate screen right after, so paste-off precedes the leave; both are
    // one-shot restore markers, and the cursor comes back last.
    assert.equal(out.split('\x1b[?2004l').length - 1, 1, `bracketed paste is turned off once; stderr: ${err}`);
    assert.ok(
      out.lastIndexOf('\x1b[?25h') > out.indexOf('\x1b[?1049l'),
      `the cursor is shown after leaving the alternate screen; stderr: ${err}`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    }
    await backend.close();
    rmSync(home, { recursive: true, force: true });
  }
});
