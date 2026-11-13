/**
 * Routing conformance: which sink each decoded frame reaches, and the exact
 * bytes it carries there.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTO, renderFrame, renderMirror, type MirrorItem, type OutFrame } from 'dsh-supervision-protocol';
import { routeFrame } from './route.js';

const ESC = '\x1b';
const ST = `${ESC}\\`;

/** Defines `columns` on stdout for one call; no test needs a real terminal. */
function withColumns<T>(width: number | undefined, run: () => T): T {
  const stdout = process.stdout as { columns?: number };
  const own = Object.getOwnPropertyDescriptor(stdout, 'columns');
  Object.defineProperty(stdout, 'columns', { value: width, configurable: true });
  try {
    return run();
  } finally {
    if (own === undefined) delete stdout.columns;
    else Object.defineProperty(stdout, 'columns', own);
  }
}

const LONG: MirrorItem = { k: 'user', text: 'alpha beta gamma delta epsilon zeta eta theta iota kappa' };

test('osc reaches the machine sink verbatim and never the human one', () => {
  const frame: OutFrame = { t: 'osc', data: `${ESC}]7501;state=working${ST}` };
  assert.deepEqual(routeFrame(frame, true), { tty: `${ESC}]7501;state=working${ST}` });
  assert.deepEqual(routeFrame(frame, false), { tty: `${ESC}]7501;state=working${ST}` });
});

test('echo reaches both sinks when the human one exists, with one newline each', () => {
  assert.deepEqual(routeFrame({ t: 'echo', text: 'sent' }, true), { tty: 'sent\n', out: 'sent\n' });
});

test('echo stays machine-only without a human sink', () => {
  assert.deepEqual(routeFrame({ t: 'echo', text: 'sent' }, false), { tty: 'sent\n' });
});

test('mirror reaches only the human sink, with the one newline the renderer omits', () => {
  const frame: OutFrame = { t: 'mirror', item: LONG };
  const routed = withColumns(undefined, () => routeFrame(frame, true));
  assert.deepEqual(routed, { out: `${renderMirror(LONG)}\n` });
});

test('mirror wraps to the stdout width when the terminal reports one', () => {
  const frame: OutFrame = { t: 'mirror', item: LONG };
  const routed = withColumns(20, () => routeFrame(frame, true));
  assert.deepEqual(routed, { out: `${renderMirror(LONG, 20)}\n` });
  assert.notEqual(routed.out, `${renderMirror(LONG)}\n`);
});

test('mirror is dropped when stdout is not a terminal', () => {
  assert.deepEqual(routeFrame({ t: 'mirror', item: LONG }, false), {});
});

const PASS_THROUGH: readonly OutFrame[] = [
  { t: 'welcome', proto: PROTO, session: 's1', title: 'demo', state: 'working', turn: 3 },
  { t: 'sessions', items: [{ id: 's1', cwd: '/tmp', live: true, bridged: false }] },
  { t: 'error', code: 'busy', message: 'already bridged' },
  { t: 'bye', reason: 'backend gone' },
];

for (const frame of PASS_THROUGH) {
  test(`${frame.t} keeps the machine bytes renderFrame already produced`, () => {
    assert.deepEqual(routeFrame(frame, true), { tty: renderFrame(frame) });
    assert.deepEqual(routeFrame(frame, false), { tty: renderFrame(frame) });
  });
}
