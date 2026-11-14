/**
 * The surface's decisions without a terminal: scroll arithmetic, the follow
 * marker, width fitting, the TUI chooser and the echo-line status parse.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth } from '@mariozechner/pi-tui';
import {
  FOLLOWING,
  TranscriptView,
  afterAppend,
  chooseSurface,
  echoStatus,
  fitLines,
  keyAction,
  maxTop,
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
