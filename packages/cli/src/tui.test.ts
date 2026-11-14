/**
 * The surface's decisions without a terminal: scroll arithmetic, the follow
 * marker, width fitting, the TUI chooser and the echo-line status parse.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderMirror } from 'dsh-supervision-protocol';
import {
  FOLLOWING,
  TranscriptView,
  afterAppend,
  chooseSurface,
  echoStatus,
  fitLines,
  keyAction,
  maxTop,
  restoreOnExit,
  newMarker,
  scrollBy,
  scrollToBottom,
  scrollToTop,
} from './tui.js';

test('maxTop pins the viewport to the last full page', () => {
  assert.equal(maxTop(100, 10), 90);
  assert.equal(maxTop(5, 10), 0);
  assert.equal(maxTop(0, 10), 0);
});

test('scrolling up leaves follow mode, scrolling back down resumes it', () => {
  const up = scrollBy(FOLLOWING, -3, 100, 10);
  assert.deepEqual(up, { top: 87, follow: false, unseen: 0 });
  const down = scrollBy(up, 3, 100, 10);
  assert.deepEqual(down, { top: 90, follow: true, unseen: 0 });
});

test('scroll clamps at both ends', () => {
  assert.deepEqual(scrollBy(FOLLOWING, -1000, 100, 10), { top: 0, follow: false, unseen: 0 });
  assert.deepEqual(scrollBy(FOLLOWING, 1000, 100, 10), { top: 90, follow: true, unseen: 0 });
  // A transcript shorter than the viewport cannot scroll at all.
  assert.deepEqual(scrollBy(FOLLOWING, -5, 4, 10), { top: 0, follow: true, unseen: 0 });
});

test('Home and End jump the viewport', () => {
  assert.equal(scrollToTop(FOLLOWING, 100, 10).top, 0);
  assert.equal(scrollToTop(FOLLOWING, 100, 10).follow, false);
  assert.deepEqual(scrollToBottom(scrollToTop(FOLLOWING, 100, 10), 100, 10), {
    top: 90,
    follow: true,
    unseen: 0,
  });
});

test('following keeps the bottom; scrolled up counts what arrived', () => {
  assert.deepEqual(afterAppend(FOLLOWING, 1, 105, 10), { top: 95, follow: true, unseen: 0 });
  const reading = scrollBy(FOLLOWING, -5, 100, 10);
  const one = afterAppend(reading, 1, 101, 10);
  const two = afterAppend(one, 1, 102, 10);
  assert.deepEqual(two, { top: 85, follow: false, unseen: 2 });
});

test('the marker names unseen entries and disappears at the bottom', () => {
  assert.equal(newMarker(FOLLOWING), undefined);
  assert.equal(newMarker({ top: 10, follow: false, unseen: 12 }), '↓ 12 new');
  assert.equal(newMarker(scrollToBottom({ top: 0, follow: false, unseen: 12 }, 100, 10)), undefined);
});

test('fitLines keeps every line inside the viewport width, CJK included', () => {
  for (const block of ['alpha beta gamma delta', '中文'.repeat(30), 'x'.repeat(200), '']) {
    for (const line of fitLines(block, 10)) {
      assert.ok(visibleWidth(line) <= 10, `line ${JSON.stringify(line)} is wider than 10`);
    }
  }
  assert.equal(fitLines('a\nb', 10).length, 2);
});

test('the TUI is chosen only for a double terminal without --no-tui', () => {
  const base = { stdinTTY: true, stdoutTTY: true, noTui: false };
  assert.equal(chooseSurface(base), 'tui');
  assert.equal(chooseSurface({ ...base, stdinTTY: false }), 'line');
  assert.equal(chooseSurface({ ...base, stdoutTTY: false }), 'line');
  assert.equal(chooseSurface({ ...base, noTui: true }), 'line');
});

test('an echo status line updates state and turn; prose does not', () => {
  assert.deepEqual(echoStatus('[turn 3] working'), { state: 'working', turn: 3 });
  assert.deepEqual(echoStatus('[turn 0] idle'), { state: 'idle', turn: 0 });
  assert.equal(echoStatus('session=session-1 state=idle turn=0 asks=-'), undefined);
  assert.equal(echoStatus('[turn x] working'), undefined);
  assert.equal(echoStatus('[turn 3] frobnicating'), undefined);
});
test('keys map to surface actions, arrows only with an empty editor', () => {
  assert.deepEqual(keyAction('\x03', false), { kind: 'cancel' });
  assert.deepEqual(keyAction('\x04', false), { kind: 'exit' });
  assert.deepEqual(keyAction('\x1b[5~', false), { kind: 'page', delta: -1 });
  assert.deepEqual(keyAction('\x1b[6~', false), { kind: 'page', delta: 1 });
  assert.deepEqual(keyAction('\x1b[A', true), { kind: 'line', delta: -1 });
  assert.deepEqual(keyAction('\x1b[B', true), { kind: 'line', delta: 1 });
  assert.deepEqual(keyAction('\x1b[H', true), { kind: 'top' });
  assert.deepEqual(keyAction('\x1b[F', true), { kind: 'bottom' });
  // Text in the editor owns the arrows, Home and End.
  assert.equal(keyAction('\x1b[A', false), undefined);
  assert.equal(keyAction('\x1b[H', false), undefined);
  assert.equal(keyAction('x', true), undefined);
});

test('a short transcript sits right above the editor', () => {
  const view = new TranscriptView();
  view.height = 4;
  view.push('only line');
  assert.deepEqual(view.render(40), ['', '', '', 'only line']);
});

test('the viewport shows the newest lines and pages back through history', () => {
  const view = new TranscriptView();
  view.height = 4;
  for (let i = 0; i < 10; i++) view.push(`line ${String(i)}`);
  assert.deepEqual(view.render(40), ['line 6', 'line 7', 'line 8', 'line 9']);
  assert.equal(view.page(-1), true);
  assert.deepEqual(view.render(40), ['line 3', 'line 4', 'line 5', 'line 6']);
});

test('entries arriving while scrolled up show the trailing marker', () => {
  const view = new TranscriptView();
  view.height = 4;
  for (let i = 0; i < 10; i++) view.push(`line ${String(i)}`);
  view.render(40);
  view.page(-1);
  view.render(40);
  view.push('line 10');
  view.push('line 11');
  assert.deepEqual(view.render(40), ['line 3', 'line 4', 'line 5', '↓ 2 new']);
  assert.equal(view.toBottom(), true);
  assert.deepEqual(view.render(40), ['line 8', 'line 9', 'line 10', 'line 11']);
});

test('a rendered mirror item never exceeds the viewport width', () => {
  const view = new TranscriptView();
  view.height = 6;
  view.push({ k: 'user', text: '中文内容 '.repeat(40) });
  for (const line of view.render(20)) {
    assert.ok(visibleWidth(line) <= 20, `${JSON.stringify(line)} is wider than 20`);
  }
});
test('an append wraps only the new entry; a width change rebuilds all', () => {
  const calls: string[] = [];
  const view = new TranscriptView((entry, width) => {
    calls.push(typeof entry === 'string' ? entry : 'item');
    return fitLines(typeof entry === 'string' ? entry : renderMirror(entry, width), width);
  });
  view.height = 4;
  view.push('alpha');
  view.push('beta');
  // Nothing rendered yet, so both entries took the constructor's default width.
  assert.deepEqual(calls, ['alpha', 'beta']);
  view.render(20);
  assert.deepEqual(calls, ['alpha', 'beta', 'alpha', 'beta'], 'the first real width rewraps everything');
  calls.length = 0;
  view.push('gamma');
  assert.deepEqual(calls, ['gamma'], 'only the appended entry is wrapped');
  view.render(20);
  assert.deepEqual(calls, ['gamma'], 'rendering reuses the cached lines');
  view.render(30);
  assert.deepEqual(calls, ['gamma', 'alpha', 'beta', 'gamma'], 'a width change rebuilds every entry');
});

test('a resize that brings the bottom back in view clears the marker', () => {
  const view = new TranscriptView();
  view.height = 4;
  for (let i = 0; i < 10; i++) view.push(`line ${String(i)}`);
  view.render(40);
  view.page(-1);
  view.render(40);
  view.push('line 10');
  assert.match(view.render(40).join('\n'), /\u2193 1 new/);
  view.height = 12;
  assert.doesNotMatch(view.render(40).join('\n'), /\u2193/);
});

/** Every exit-path event the guard owns. */
const GUARDED = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException'] as const;

/** One event name at a time: `process.listeners` is overloaded per event. */
function listenersOf(event: string): ((...args: unknown[]) => void)[] {
  return process.listeners(event as 'exit') as ((...args: unknown[]) => void)[];
}

/** Runs `body` with the guard installed, then removes only the listeners it added. */
function withGuard(stop: () => void, body: () => void): void {
  const before = new Map(GUARDED.map((event) => [event, listenersOf(event)]));
  restoreOnExit(stop);
  try {
    body();
  } finally {
    for (const event of GUARDED) {
      for (const listener of listenersOf(event)) {
        if (!(before.get(event) ?? []).includes(listener)) process.removeListener(event, listener);
      }
    }
  }
}

test('restoreOnExit wires every exit path, SIGINT included', () => {
  withGuard(() => {}, () => {
    for (const event of GUARDED) {
      assert.ok(listenersOf(event).length > 0, `${event} is guarded`);
    }
  });
});

test('an external SIGINT restores once, then re-raises the default signal', () => {
  const savedKill = process.kill;
  const killed: [number, string][] = [];
  let stopped = 0;
  // The re-raise is recorded rather than delivered, so the runner survives it.
  process.kill = ((pid: number, signal?: string | number) => {
    killed.push([pid, String(signal)]);
    return true;
  }) as typeof process.kill;
  try {
    withGuard(() => {
      stopped += 1;
    }, () => {
      assert.ok(listenersOf('SIGINT').length > 0, 'SIGINT is guarded');
      // `emit` runs the registered `once` wrapper, exactly as the signal would,
      // so the self-removal before the re-raise is part of what is observed.
      process.emit('SIGINT');
      assert.equal(listenersOf('SIGINT').length, 0, 'the handler removes itself before re-raising');
    });
  } finally {
    process.kill = savedKill;
  }
  assert.equal(stopped, 1, 'the restore ran exactly once');
  assert.deepEqual(killed, [[process.pid, 'SIGINT']], 'the default signal is re-raised, so the status stays 130');
});

test('SIGTERM restores the surface before the process exits', () => {
  const savedExit = process.exit;
  const exited: number[] = [];
  let stopped = 0;
  // The stub records the status and unwinds instead of killing the runner.
  process.exit = ((code?: number) => {
    exited.push(code ?? 0);
    throw new Error('process.exit');
  }) as typeof process.exit;
  try {
    withGuard(() => {
      stopped += 1;
    }, () => {
      const handler = listenersOf('SIGTERM').at(-1) as (() => void) | undefined;
      assert.ok(handler !== undefined, 'SIGTERM is guarded');
      assert.throws(() => { handler(); }, /process\.exit/);
    });
  } finally {
    process.exit = savedExit;
  }
  assert.equal(stopped, 1, 'the restore ran before the exit');
  assert.deepEqual(exited, [143], 'a killed attach keeps its signal status');
});
