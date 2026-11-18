/**
 * The surface's decisions without a terminal: scroll arithmetic, the follow
 * marker, width fitting, the TUI chooser and the echo-line status parse.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CombinedAutocompleteProvider, Editor, TuiAltScreen, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { PROTO, renderMirror, type AskFrame } from 'dsh-supervision-protocol';
import { routeFrame } from './route.js';
import { PLAIN, createTheme } from './theme.js';
import {
  CTRL_C_WINDOW_MS,
  LOCAL_EXITS,
  NO_CATALOG,
  answerLine,
  autocompleteCatalog,
  catalogOf,
  ctrlCAction,
  escAction,
  fdBinary,
  isLocalExit,
  lineAction,
  providerFor,
  routeLine,
  surfaceKey,
  type Catalog,
  type KeyEffects,
  type KeyMemory,
} from './tui.js';
import {
  FOLLOWING,
  Shell,
  StatusLine,
  THEME,
  TranscriptView,
  editorTheme,
  oscStatus,
  renderEntry,
  clipStyled,
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
  welcomeStatus,
} from './tui.js';

const SINGLE_ASK: AskFrame = {
  t: 'ask',
  id: '3f9ac1',
  questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }],
};

test('an open single-question ask absorbs a bare answer line', () => {
  const open = new Map<string, AskFrame>([[SINGLE_ASK.id, SINGLE_ASK]]);
  assert.equal(answerLine('2', open), '/answer 3f9ac1 2');
  assert.equal(answerLine('-', open), '/answer 3f9ac1 -');
  assert.equal(answerLine('1,3', open), '/answer 3f9ac1 1,3');
  assert.equal(answerLine('  2  ', open), '/answer 3f9ac1 2');
});

test('an explicit /answer always passes verbatim', () => {
  const open = new Map<string, AskFrame>([[SINGLE_ASK.id, SINGLE_ASK]]);
  assert.equal(answerLine('/answer other 1', open), '/answer other 1');
  assert.equal(answerLine('  /answer 3f9ac1 db=2  ', open), '  /answer 3f9ac1 db=2  ');
});

test('an open question never swallows an ordinary steer', () => {
  const open = new Map<string, AskFrame>([[SINGLE_ASK.id, SINGLE_ASK]]);
  assert.equal(answerLine('hello', open), 'hello');
  assert.equal(answerLine('2.5', open), '2.5');
  assert.equal(answerLine('fix the retry', open), 'fix the retry');
  assert.equal(answerLine('2', new Map()), '2');
});

test('a bare answer is rewritten for one multi-question ask, but not for several open asks', () => {
  const multi: AskFrame = {
    t: 'ask',
    id: 'aaaaaa',
    questions: [{ id: 'a', question: 'A?' }, { id: 'b', question: 'B?' }],
  };
  const another: AskFrame = {
    t: 'ask',
    id: 'bbbbbb',
    questions: [{ id: 'c', question: 'C?' }],
  };
  assert.equal(answerLine('2', new Map([['aaaaaa', multi]])), '/answer aaaaaa 2');
  assert.equal(answerLine('-', new Map([['aaaaaa', multi]])), '/answer aaaaaa -');
  assert.equal(answerLine('2', new Map([['aaaaaa', multi], ['bbbbbb', another]])), '2');
});

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
  assert.deepEqual(keyAction('\x03', false), { kind: 'ctrl-c' });
  assert.deepEqual(keyAction('\x04', false), { kind: 'exit' });
  assert.deepEqual(keyAction('\x1b', false), { kind: 'escape' });
  assert.deepEqual(keyAction('\x1b', true), { kind: 'escape' });
  assert.deepEqual(keyAction('\x1b[5~', false), { kind: 'page', delta: -1 });
  assert.deepEqual(keyAction('\x1b[6~', false), { kind: 'page', delta: 1 });
  assert.deepEqual(keyAction('\x1b[A', true), { kind: 'line', delta: -1 });
  assert.deepEqual(keyAction('\x1b[B', true), { kind: 'line', delta: 1 });
  assert.deepEqual(keyAction('\x1b[H', true), { kind: 'top' });
  assert.deepEqual(keyAction('\x1b[F', true), { kind: 'bottom' });
  // Text in the editor owns the arrows, Home and End.
  assert.equal(keyAction('\x1b[A', false), undefined);

test('a key release never acts: no second scroll, no second /cancel, no exit', () => {
  // Kitty encodes the event type after the modifier: \x1b[<code>;<mods>:3u for
  // printable keys, \x1b[<num>;<mods>:3~ for functional keys. `:3` is release.
  const releases = {
    pageUp: '\x1b[5;1:3~',
    pageDown: '\x1b[6;1:3~',
    ctrlC: '\x1b[99;5:3u',
    ctrlD: '\x1b[100;5:3u',
    up: '\x1b[1;1:3A',
    down: '\x1b[1;1:3B',
    home: '\x1b[1;1:3H',
    end: '\x1b[1;1:3F',
  };
  for (const [name, data] of Object.entries(releases)) {
    assert.equal(keyAction(data, true), undefined, `${name} release must not act`);
    assert.equal(keyAction(data, false), undefined, `${name} release must not act with text in the editor`);
  }

  // The matching press sequences still do.
  assert.deepEqual(keyAction('\x1b[5;1~', true), { kind: 'page', delta: -1 });
  assert.deepEqual(keyAction('\x1b[6;1~', true), { kind: 'page', delta: 1 });
  assert.deepEqual(keyAction('\x03', true), { kind: 'ctrl-c' });
  assert.deepEqual(keyAction('\x04', true), { kind: 'exit' });
  assert.deepEqual(keyAction('\x1b[5~', true), { kind: 'page', delta: -1 });
  assert.deepEqual(keyAction('\x1b[6~', true), { kind: 'page', delta: 1 });
});
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
  const view = new TranscriptView({
    wrapEntry: (entry, width) => {
      calls.push(typeof entry === 'string' ? entry : 'item');
      return fitLines(typeof entry === 'string' ? entry : renderMirror(entry, width), width);
    },
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

/** The exit status and side effects one owned exit path produces. */
interface PathRun {
  stopped: number;
  readonly exited: number[];
  readonly killed: [number, string][];
  stderr: string;
}

/**
 * Delivers one owned exit event and records what the guard did.
 * `process.exit` and `process.kill` are stubbed to unwind, so the runner and the
 * host survive a path that really means to end the process.
 */
function runExitPath(event: (typeof GUARDED)[number]): PathRun {
  const saved = { exit: process.exit, kill: process.kill, stderr: process.stderr.write };
  const run: PathRun = { stopped: 0, exited: [], killed: [], stderr: '' };
  process.exit = ((code?: number) => {
    run.exited.push(code ?? 0);
    throw new Error('process.exit');
  }) as typeof process.exit;
  process.kill = ((pid: number, signal?: string | number) => {
    run.killed.push([pid, String(signal)]);
    return true;
  }) as typeof process.kill;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    run.stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    withGuard(() => {
      run.stopped += 1;
    }, () => {
      try {
        if (event === 'uncaughtException') {
          // `emit` would hand the error to the test runner's own uncaught
          // handler, so the registered listener is called the way Node would
          // call it for a real throw.
          const handler = listenersOf('uncaughtException').at(-1) as ((error: Error) => void) | undefined;
          assert.ok(handler !== undefined, 'uncaughtException is guarded');
          handler(new Error('boom'));
        } else {
          // A real signal runs the registered `once` wrapper, and so does `emit`.
          // The union of owned events is not one overload of `process.emit`.
          (process.emit as (name: string) => boolean)(event);
        }
      } catch (error) {
        // The stubbed process.exit unwinds through here; the record is the assertion.
        if (!(error instanceof Error) || error.message !== 'process.exit') throw error;
      }
    });
  } finally {
    process.exit = saved.exit;
    process.kill = saved.kill;
    process.stderr.write = saved.stderr;
  }
  return run;
}

test('an uncaught exception restores the screen, prints the cause and exits 1', () => {
  const run = runExitPath('uncaughtException');
  assert.equal(run.stopped, 1, 'the restore ran before the exit');
  assert.match(run.stderr, /boom/, 'the cause is reported on the restored screen');
  assert.deepEqual(run.exited, [1]);
});

test('an external SIGINT restores once, then re-raises the default signal', () => {
  const run = runExitPath('SIGINT');
  assert.equal(run.stopped, 1, 'the restore ran exactly once');
  assert.deepEqual(run.killed, [[process.pid, 'SIGINT']], 'the default signal is re-raised, so the status stays 130');
  assert.deepEqual(run.exited, [], 'no exit status is invented for a signal');
});

test('SIGTERM and SIGHUP restore and keep their signal statuses', () => {
  assert.deepEqual(runExitPath('SIGTERM').exited, [143]);
  assert.deepEqual(runExitPath('SIGHUP').exited, [129]);
});

test('the last-resort exit path restores without choosing a status', () => {
  const run = runExitPath('exit');
  assert.equal(run.stopped, 1, 'a plain exit still runs the restore');
  assert.deepEqual(run.exited, [], 'the exit status belongs to whoever called process.exit');
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
test('a narrow terminal never renders a line wider than its width', () => {
  const terminal = { columns: 20, rows: 24, write: () => {} } as unknown as Terminal;
  const tui = new TuiAltScreen(terminal);
  const transcript = new TranscriptView();
  for (let i = 0; i < 5; i++) transcript.push('alpha beta gamma delta epsilon zeta eta theta');
  transcript.push({ k: 'user', text: '中文内容 '.repeat(10) });
  const status = new StatusLine();
  status.set({ session: 'session-narrow', state: 'working', turn: 3 });
  const shell = new Shell(terminal, transcript, new Editor(tui, THEME), status, 80);
  for (const width of [1, 10, 19]) {
    const lines = shell.render(width);
    assert.ok(lines.length > 0, `width ${String(width)} rendered nothing`);
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= width,
        `width ${String(width)}: ${JSON.stringify(line)} is ${String(visibleWidth(line))} columns wide`,
      );
    }
  }
});

test('an OSC 7501 root record advances the status; a child record does not', () => {
  const status = new StatusLine();
  status.set({ session: 'session-1', state: 'idle', turn: 1 });

  const root = oscStatus('\x1b]7501;state=working:app=dsh\x1b\\');
  assert.deepEqual(root, { state: 'working' }, 'the root record carries the session state');
  if (root !== undefined) status.set(root);
  assert.match(status.render(80), /working/);
  assert.match(status.render(80), /session-1/);
  assert.match(status.render(80), /turn 1/, 'an OSC record never invents a turn');

  // A parked ask is a child record, so it must not overwrite the session state.
  assert.equal(oscStatus('\x1b]7501;state=blocked:id=ask-7:kind=permission\x1b\\'), undefined);
  assert.match(status.render(80), /working/);

  // Clears, other OSC families and unknown states are not session states.
  assert.equal(oscStatus('\x1b]7501;state=clear\x1b\\'), undefined);
  assert.equal(oscStatus('\x1b]0;a window title\x07'), undefined);
  assert.equal(oscStatus('\x1b]7501;state=frobnicating\x1b\\'), undefined);

  // The echo path still works beside it.
  const echoed = echoStatus('[turn 4] idle');
  if (echoed !== undefined) status.set(echoed);
  assert.match(status.render(80), /idle/);
  assert.match(status.render(80), /turn 4/);
});
test('a welcome with echo off seeds no turn, and OSC still moves the state', () => {
  const status = new StatusLine();
  status.set(welcomeStatus({ t: 'welcome', proto: PROTO, session: 'session-1', title: 'repo', state: 'idle', turn: 7, echo: false }));
  assert.match(status.render(80), /session-1/);
  assert.match(status.render(80), /idle/);
  assert.doesNotMatch(status.render(80), /turn/, 'nothing would advance a seed while echo is off');

  // OSC is the machine surface, so the state keeps moving without any echo line.
  const next = oscStatus('\x1b]7501;state=working\x1b\\');
  if (next !== undefined) status.set(next);
  assert.match(status.render(80), /working/);
  assert.doesNotMatch(status.render(80), /turn/);

  // Echo on, or an older plugin that sends no flag, keeps the seeded count.
  for (const echo of [true, undefined]) {
    const seeded = new StatusLine();
    seeded.set(welcomeStatus({ t: 'welcome', proto: PROTO, session: 'session-2', title: 'repo', state: 'idle', turn: 7, ...(echo === undefined ? {} : { echo }) }));
    assert.match(seeded.render(80), /turn 7/);
  }
});

test('user, assistant, tool and system entries are visually distinct', () => {
  const color = createTheme({ color: true });
  const user = renderEntry({ k: 'user', text: 'hello **there**' }, 40, color).join('\n');
  assert.match(user, /48;5;236/, 'the user block is tinted');
  assert.match(user, /❯/, 'the user block carries a gutter');
  assert.match(user, /38;5;252/, 'the user text keeps its own foreground');

  const assistant = renderEntry(
    {
      k: 'assistant',
      turn: 1,
      text: '# Title\n\n- item\n\n`inline`\n\n```ts\nconst x = 1;\n```',
    },
    40,
    color,
  ).join('\n');
  assert.match(assistant, /\x1b\[1m[^\n]*38;5;39|38;5;39[^\n]*\x1b\[1m/, 'the heading is bold accent');
  assert.match(assistant, /38;5;73/, 'inline code has its own colour');
  assert.match(assistant, /38;5;240/, 'the fence border is dim');
  assert.match(assistant, /\`\`\`ts/, 'the fenced block keeps its language marker');
  assert.match(assistant, /- item|38;5;39m- /, 'the list bullet is present and accented');

  const tool = renderEntry(
    { k: 'tool', callId: 'c1', name: 'bash', args: '{"command":"ls"}', state: 'ok', detail: 'src', ms: 12, turn: 1 },
    40,
    color,
  ).join('\n');
  assert.match(tool, /✔/);
  assert.match(tool, /38;5;40/, 'a successful tool call is green');
  assert.match(tool, /48;5;22/, 'a successful tool call has its own band');
  assert.match(tool, /└─ src/, 'the detail line keeps its gutter');

  const failure = renderEntry(
    { k: 'tool', callId: 'c2', name: 'bash', args: '{}', state: 'error', turn: 1 },
    40,
    color,
  ).join('\n');
  assert.match(failure, /✘/);
  assert.match(failure, /38;5;203/, 'a failed tool call is red');

  const system = renderEntry('[turn 1] working', 40, color).join('\n');
  assert.match(system, /\x1b\[2m/, 'system lines are dim');
});

test('the plain theme renders the whole surface without escape bytes', () => {
  const blocks = [
    renderEntry({ k: 'user', text: 'hello' }, 40, PLAIN),
    renderEntry({ k: 'assistant', turn: 1, reasoning: 'why', text: '# T\n\n- x', usage: { inputTokens: 1, outputTokens: 2 } }, 40, PLAIN),
    renderEntry({ k: 'tool', callId: 'c', name: 'bash', args: '{"command":"ls"}', state: 'start', turn: 1 }, 40, PLAIN),
    renderEntry('echo line', 40, PLAIN),
    new StatusLine(PLAIN).render(40),
    editorTheme(PLAIN).borderColor('────'),
  ];
  for (const block of blocks) {
    const lines = typeof block === 'string' ? [block] : block;
    for (const line of lines) assert.equal(line.includes('\x1b'), false, `plain output kept an escape: ${JSON.stringify(line)}`);
  }
});

test('the status bar owns its row and colour-codes the state', () => {
  const color = createTheme({ color: true });
  const bar = new StatusLine(color);
  bar.set({ session: 'session-pty', state: 'blocked', turn: 3 });
  const rendered = bar.render(40);
  assert.equal(visibleWidth(rendered), 40, 'the bar fills the width');
  assert.match(rendered, /\x1b\[7m/, 'the bar is reverse video');
  assert.match(rendered, /38;5;214/, 'blocked is the warning colour');
  assert.match(rendered, /session-pty/);
  assert.match(rendered, /turn 3/);
  for (const state of ['working', 'done', 'blocked', 'error', 'idle'] as const) {
    const line = new StatusLine(createTheme({ color: true }));
    line.set({ session: 's', state });
    assert.ok(line.render(20).includes('\x1b['), `${state} is colour-coded`);
  }
});

test('the editor frame is accent-coloured with colour and plain without', () => {
  assert.match(editorTheme(createTheme({ color: true })).borderColor('─'), /38;5;39/);
  assert.equal(editorTheme(PLAIN).borderColor('─'), '─');
});

test('every entry kind fits widths 40, 10 and 1', () => {
  const entries = [
    { k: 'user', text: 'hello there, this is a longer line of operator input' },
    { k: 'assistant', turn: 1, reasoning: 'thinking', text: '# Title\n\n- one\n- two\n\n`code`\n\n```ts\nconst x = 1;\n```', usage: { inputTokens: 1234, outputTokens: 56 } },
    { k: 'tool', callId: 'c', name: 'bash', args: '{"command":"ls -la"}', state: 'ok', detail: 'packages/protocol/src', ms: 12, turn: 1 },
    'echo line that is long enough to wrap at a narrow width',
  ] as const;
  for (const width of [40, 10, 1]) {
    for (const entry of entries) {
      for (const line of renderEntry(entry, width, PLAIN)) {
        assert.ok(visibleWidth(line) <= width, `width ${String(width)}: ${JSON.stringify(line)} overflows`);
      }
    }
  }
});

test('a user entry keeps its text down to one column', () => {
  for (const theme of [PLAIN, createTheme({ color: true })]) {
    for (const width of [1, 3, 10, 40]) {
      const lines = renderEntry({ k: 'user', text: 'hello' }, width, theme);
      const joined = lines.join('\n');
      const label = theme.color ? 'colour' : 'plain';
      assert.ok(joined.includes('h'), `${label} width ${String(width)} lost the text: ${JSON.stringify(lines)}`);
      assert.doesNotMatch(joined, /…/u, `${label} width ${String(width)} substituted an ellipsis`);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `${label} width ${String(width)}: ${JSON.stringify(line)} overflows`);
      }
    }
  }
});

test('a clipped row gains one reset only when the cut leaves a style open', () => {
  const plain = 'abcdefghij';
  // Nothing was open, so nothing may be closed: the plain row keeps no escape.
  assert.equal(clipStyled(plain, 4), 'abcd');
  // A styled row carries its open SGR through the cut, so exactly one reset closes it.
  assert.equal(clipStyled(`\x1b[2m${'x'.repeat(20)}`, 4), `\x1b[2mxxxx\x1b[0m`);
  // A row that already fits is returned byte for byte.
  assert.equal(clipStyled('ok', 4), 'ok');
  // The reset is bounded to the clipped line: one per line, never two.
  const clipped = clipStyled(`\x1b[48;5;236m${'y'.repeat(20)}`, 10);
  assert.equal(clipped.split('\x1b[0m').length - 1, 1);
  assert.ok(visibleWidth(clipped) <= 10);
});

test('the operator line renders as Markdown, the format the transcript uses', () => {
  const color = createTheme({ color: true });
  const rendered = renderEntry({ k: 'user', text: '# Plan\n\nuse **bold** text' }, 40, color).join('\n');
  // Accepted by decision (I-000025): owner text is Markdown on every surface, so
  // the heading marker is parsed rather than printed and inline bold is styled.
  assert.doesNotMatch(rendered, /#/);
  assert.doesNotMatch(rendered, /\*\*/);
  assert.match(rendered, /Plan/);
  assert.match(rendered, /\x1b\[1m/);
});

test('widths 1, 3, 10 and 40 keep every entry readable and inside the viewport', () => {
  const entries = [
    { k: 'user', text: 'operator input' },
    { k: 'assistant', turn: 1, text: 'Reply text with a long tail ' + 'x'.repeat(120), interrupted: true },
    { k: 'tool', callId: 'c', name: 'bash', args: '{"command":"ls"}', state: 'ok', detail: 'packages/cli/src', ms: 4, turn: 1 },
  ] as const;
  for (const theme of [PLAIN, createTheme({ color: true })]) {
    for (const width of [1, 3, 10, 40]) {
      for (const entry of entries) {
        const lines = renderEntry(entry, width, theme);
        const joined = lines.join('\n');
        for (const line of lines) {
          assert.ok(visibleWidth(line) <= width, `width ${String(width)}: ${JSON.stringify(line)} overflows`);
        }
        if (entry.k === 'user') assert.ok(joined.includes('o'), 'user text survives');
        if (entry.k === 'assistant') {
          assert.ok(joined.includes('R'), 'assistant text survives');
          // The marker is 13 columns, so only a row that wide can show it.
          if (width === 40) assert.ok(joined.includes('(interrupted)'), 'the marker survives');
        }
        if (entry.k === 'tool') assert.ok(joined.includes('✔'), 'the tool glyph survives');
      }
    }
  }
});

test('the plain path emits no ESC or OSC bytes for links and overlong lines', () => {
  const entries = [
    { k: 'user', text: '[docs](https://example.com/page) ' + 'x'.repeat(200) },
    { k: 'assistant', turn: 1, text: 'See [the docs](https://example.com/x) and ' + 'y'.repeat(200) },
    'echo ' + 'z'.repeat(200),
    { k: 'tool', callId: 'c', name: 'bash', args: '{"command":"' + 'w'.repeat(200) + '"}', state: 'ok', detail: 'd'.repeat(200), turn: 1 },
  ] as const;
  for (const width of [40, 10, 3, 1]) {
    for (const entry of entries) {
      for (const line of renderEntry(entry, width, PLAIN)) {
        assert.equal(line.includes('\x1b'), false, `plain width ${String(width)} kept an escape: ${JSON.stringify(line)}`);
        assert.ok(visibleWidth(line) <= width, `plain width ${String(width)}: ${JSON.stringify(line)} overflows`);
      }
    }
  }
});

test('an interrupted reply keeps both its body and the marker at full width', () => {
  const body = 'x'.repeat(40);
  for (const theme of [PLAIN, createTheme({ color: true })]) {
    const joined = renderEntry({ k: 'assistant', turn: 1, text: body, interrupted: true }, 40, theme).join('\n');
    assert.ok(joined.includes(body), 'the full-width body survives');
    assert.ok(joined.includes('(interrupted)'), 'the marker gets its own line');
  }
});

test('the follow marker stays byte-clean under the plain theme at any width', () => {
  for (const width of [1, 3, 6]) {
    const view = new TranscriptView({ width, theme: PLAIN });
    view.height = 2;
    for (let i = 0; i < 6; i++) view.push(`line ${String(i)}`);
    view.render(width);
    view.page(-1);
    view.push('line 6');
    view.push('line 7');
    const lines = view.render(width);
    assert.match(lines.join('\n'), /↓|\d/, 'the marker is still rendered');
    for (const line of lines) {
      assert.equal(line.includes('\x1b'), false, `plain width ${String(width)} kept an escape: ${JSON.stringify(line)}`);
      assert.ok(visibleWidth(line) <= width, `plain width ${String(width)}: ${JSON.stringify(line)} overflows`);
    }
  }
});

test('a wide grapheme at the cut boundary cannot widen a coloured row', () => {
  const color = createTheme({ color: true });
  const entries = [
    { k: 'tool', callId: 'c', name: 'bash', args: JSON.stringify({ command: '中文内容🙂'.repeat(6) }), state: 'ok', detail: '中文🙂'.repeat(10), ms: 4, turn: 1 },
    { k: 'user', text: '中文内容🙂'.repeat(6) },
    { k: 'assistant', turn: 1, text: '中文内容🙂'.repeat(6), interrupted: true },
  ] as const;
  for (const width of [10, 40]) {
    for (const entry of entries) {
      for (const line of renderEntry(entry, width, color)) {
        assert.ok(visibleWidth(line) <= width, `width ${String(width)}: ${JSON.stringify(line)} is ${String(visibleWidth(line))}`);
      }
    }
  }
});

test('block entries are separated; echo lines stay dense', () => {
  const view = new TranscriptView({ width: 20 });
  view.height = 12;
  view.push({ k: 'user', text: 'hello' });
  view.push({ k: 'assistant', turn: 1, text: 'reply' });
  view.push('echo one');
  view.push('echo two');
  const lines = view.render(20).map((line) => line.trimEnd());
  const userAt = lines.findIndex((line) => line.includes('❯'));
  const replyAt = lines.findIndex((line) => line === 'reply');
  const echoOneAt = lines.findIndex((line) => line === 'echo one');
  const echoTwoAt = lines.findIndex((line) => line === 'echo two');
  assert.ok(userAt >= 0 && replyAt > userAt && echoOneAt > replyAt && echoTwoAt === echoOneAt + 1);
  assert.equal(lines[replyAt - 1], '', 'a block entry is preceded by one blank row');
  assert.notEqual(lines[echoOneAt - 1], '', 'echo lines are not spread apart');
});
const SAMPLE: Catalog = {
  skills: [
    { name: 'use-dsh-sup', description: 'run the forwarder' },
    { name: 'use-dsh-supervision', description: 'supervised session guide' },
    { name: 'grill-me', description: 'stress-test a plan' },
  ],
  commands: [],
};

test('the catalog becomes one skill entry per skill plus the local exits', () => {
  const entries = autocompleteCatalog(SAMPLE);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['skill:use-dsh-sup', 'skill:use-dsh-supervision', 'skill:grill-me', ...LOCAL_EXITS],
  );
  assert.equal(entries[0]?.description, 'run the forwarder');
  // The forwarder's own exits close the menu, so a host with no vocabulary
  // still offers a way out that the operator can discover.
  const local = entries.slice(-LOCAL_EXITS.length);
  assert.deepEqual(local.map((entry) => entry.name), [...LOCAL_EXITS]);
  for (const entry of local) assert.equal(entry.description, 'leave dsh-sup (local)');
  const empty = autocompleteCatalog(NO_CATALOG);
  assert.deepEqual(empty.map((entry) => entry.name), [...LOCAL_EXITS], 'an empty catalog offers the local exits');
  assert.ok(
    empty.every((entry) => entry.getArgumentCompletions === undefined),
    'a local exit takes no argument',
  );
});


test('host command rows join the menu after skills and before the local exits', () => {
  const localVerbRows = ['cancel', 'status', 'new', 'attach', 'approve', 'reject', 'answer', 'skill', 'y', 'n'].map(
    (name) => ({ name, description: `a host row the local /${name} owns` }),
  );
  const catalog: Catalog = {
    skills: [{ name: 'use-dsh-sup', description: 'run the forwarder' }],
    commands: [
      { name: 'compact', description: 'shrink the context', argumentHint: 'focus' },
      { name: 'goal', description: 'set a goal' },
      { name: 'code_review', description: 'underscores are part of a command name' },
      ...localVerbRows,
      { name: 'q', description: 'a host row the local exit owns' },
      { name: '-lead', description: 'a leading dash is no command name' },
      { name: 'foo:bar', description: 'a colon is no command name' },
      { name: 'bad name', description: 'a space is no command name' },
      { name: 'evil\u001b]0;pwned\u0007', description: 'control bytes in the name' },
      { name: 'bad-hint', description: 'control bytes in the hint', argumentHint: 'x\u001b]52;c;aGk=\u0007' },
    ],
  };
  const entries = autocompleteCatalog(catalog);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['skill:use-dsh-sup', 'compact', 'goal', 'code_review', ...LOCAL_EXITS],
  );
  assert.equal(entries[1]?.description, 'shrink the context');
  assert.equal(entries[1]?.argumentHint, 'focus');
  assert.equal(entries[2]?.argumentHint, undefined);
  // Every local verb keeps its own meaning, exits included; its host row is gone.
  assert.equal(entries.at(-1)?.name, 'bye');
  assert.equal(entries.at(-1)?.description, 'leave dsh-sup (local)');
})

test('a skill name outside the plugin grammar never reaches the menu', () => {
  const catalog: Catalog = {
    skills: [
      { name: 'foo:bar', description: 'a colon inside the name' },
      { name: '-lead', description: 'a leading dash' },
      { name: 'ok-skill', description: 'the only admissible row' },
    ],
    commands: [],
  };
  // Both rejected rows would otherwise be advertised as a slash command that
  // parseLine answers with an unknown command.
  assert.deepEqual(autocompleteCatalog(catalog).map((entry) => entry.name), ['skill:ok-skill', ...LOCAL_EXITS]);
});

test('the skill argument completions filter by prefix', async () => {
  const entries = autocompleteCatalog(SAMPLE);
  const skill = entries.find((entry) => entry.name === 'skill:use-dsh-sup');
  const complete = skill?.getArgumentCompletions;
  assert.ok(complete !== undefined, 'a skill entry carries argument completions');
  const all = await complete('');
  // The completion fills the argument, so it carries the bare skill name.
  assert.deepEqual(all?.map((item) => item.value), ['use-dsh-sup', 'use-dsh-supervision', 'grill-me']);
  const narrowed = await complete('use-dsh-sup');
  assert.deepEqual(narrowed?.map((item) => item.label), ['use-dsh-sup', 'use-dsh-supervision']);
  assert.deepEqual(await complete('nope'), []);
});

test('the provider lists skills for / and narrows to skills for /skill:', async () => {
  const provider = new CombinedAutocompleteProvider(autocompleteCatalog(SAMPLE), process.cwd());
  const signal = new AbortController().signal;
  const root = await provider.getSuggestions(['/'], 0, 1, { signal });
  assert.deepEqual(root?.items.map((item) => item.value).sort(), [
    'bye',
    'exit',
    'q',
    'quit',
    'skill:grill-me',
    'skill:use-dsh-sup',
    'skill:use-dsh-supervision',
  ]);
  assert.equal(root?.prefix, '/');

  const skillsOnly = await provider.getSuggestions(['/skill:'], 0, '/skill:'.length, { signal });
  assert.deepEqual(skillsOnly?.items.map((item) => item.value), [
    'skill:use-dsh-sup',
    'skill:use-dsh-supervision',
    'skill:grill-me',
  ]);
  // The bare skill name also finds its entry, without requiring the prefix.
  const bare = await provider.getSuggestions(['/grill'], 0, '/grill'.length, { signal });
  assert.deepEqual(bare?.items.map((item) => item.value), ['skill:grill-me']);
});

test('accepting a suggestion inserts the slash command and a space', async () => {
  const provider = new CombinedAutocompleteProvider(autocompleteCatalog(SAMPLE), process.cwd());
  const suggestion = await provider.getSuggestions(['/skill:'], 0, '/skill:'.length, {
    signal: new AbortController().signal,
  });
  assert.ok(suggestion !== null && suggestion.items.length > 0, 'a skill suggestion exists');
  const applied = provider.applyCompletion(['/skill:'], 0, '/skill:'.length, suggestion.items[0]!, suggestion.prefix);
  assert.deepEqual(applied.lines, ['/skill:use-dsh-sup ']);
  assert.deepEqual([applied.cursorLine, applied.cursorCol], [0, '/skill:use-dsh-sup '.length]);
});

test('the provider completes @files under the session base path', async (t) => {
  if (fdBinary() === undefined) {
    t.skip('fd is not installed, so pi-tui has no file-completion backend');
    return;
  }
  const base = mkdtempSync(join(tmpdir(), 'dsup-cat-'));
  writeFileSync(join(base, 'notes.md'), 'x');
  try {
    const provider = providerFor(NO_CATALOG, base);
    const suggestion = await provider.getSuggestions(['@notes'], 0, '@notes'.length, {
      signal: new AbortController().signal,
    });
    assert.ok(
      suggestion?.items.some((item) => item.value.includes('notes.md')),
      `expected notes.md under the base path, got ${JSON.stringify(suggestion?.items)}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('catalogOf accepts only the catalog frame and passes its sections through', () => {
  assert.deepEqual(catalogOf({ t: 'catalog', skills: SAMPLE.skills, commands: SAMPLE.commands }), SAMPLE);
  assert.equal(catalogOf({ t: 'echo', text: 'x' }), undefined);
  assert.equal(catalogOf({ t: 'welcome' }), undefined);
  assert.deepEqual(catalogOf({ t: 'catalog', skills: [], commands: [] }), NO_CATALOG);
});

test('a catalog frame never reaches either sink', () => {
  const frame = { t: 'catalog', skills: SAMPLE.skills, commands: SAMPLE.commands } as const;
  assert.deepEqual(routeFrame(frame as never, true), {});
  assert.deepEqual(routeFrame(frame as never, false), {});
});
test('only the exact lowercase exit commands are forwarder-local', () => {
  for (const command of ['/q', '/quit', '/exit', '/bye']) {
    assert.equal(isLocalExit(command), true, command);
    assert.deepEqual(lineAction(command), { kind: 'exit' }, command);
  }
  // Accepting a menu entry leaves a trailing space, so that form must exit too.
  for (const command of ['/q ', '/quit  ', '/exit\t']) {
    assert.deepEqual(lineAction(command), { kind: 'exit' }, command);
  }
  for (const text of ['/q now', '/quiet', '/Q', '/EXIT', ' /q', '/bye all', '/quitter', 'hello']) {
    assert.equal(isLocalExit(text), false, text);
    assert.deepEqual(lineAction(text), { kind: 'send', text }, text);
  }
});

test('Ctrl+C clears typed text, hints when empty, and exits on a second press', () => {
  assert.equal(ctrlCAction({ editorEmpty: false, now: 1000, last: undefined }), 'clear');
  assert.equal(ctrlCAction({ editorEmpty: false, now: 1000, last: 999 }), 'clear', 'text always wins over the window');
  assert.equal(ctrlCAction({ editorEmpty: true, now: 1000, last: undefined }), 'hint');
  assert.equal(ctrlCAction({ editorEmpty: true, now: 1000, last: 1000 }), 'exit');
  assert.equal(ctrlCAction({ editorEmpty: true, now: 1000, last: 1000 - CTRL_C_WINDOW_MS }), 'exit');
  assert.equal(ctrlCAction({ editorEmpty: true, now: 1000, last: 1000 - CTRL_C_WINDOW_MS - 1 }), 'hint');
});

test('the status bar shows the transient hint only while it is set', () => {
  const bar = new StatusLine();
  bar.set({ session: 'session-1', state: 'idle', turn: 2 });
  assert.doesNotMatch(bar.render(80), /Ctrl\+C again/);
  bar.setHint('Ctrl+C again to exit');
  assert.match(bar.render(80), /Ctrl\+C again to exit/);
  assert.equal(bar.hasHint(), true);
  bar.setHint(undefined);
  assert.equal(bar.hasHint(), false);
  assert.doesNotMatch(bar.render(80), /Ctrl\+C again/);
});
test('catalog rows with control bytes never reach the menu', async () => {
  const hostile: Catalog = {
    skills: [
      { name: 'safe-skill', description: 'a plain skill' },
      { name: 'evil\u001b]0;pwned\u0007', description: 'has an OSC in the name' },
      { name: 'evil\nsplit', description: 'newline in the name' },
      { name: 'bad-desc', description: 'x\u001b]52;c;aGk=\u0007' },
    ],
    commands: [],
  };
  const entries = autocompleteCatalog(hostile);
  assert.deepEqual(entries.map((entry) => entry.name), ['skill:safe-skill', ...LOCAL_EXITS]);
  for (const entry of entries) {
    assert.equal(entry.name.includes('\u001b'), false);
    assert.equal((entry.description ?? '').includes('\u001b'), false);
  }

  const provider = providerFor(hostile, process.cwd());
  const suggestions = await provider.getSuggestions(['/'], 0, 1, { signal: new AbortController().signal });
  const rendered = JSON.stringify(suggestions);
  assert.equal(rendered.includes('\\u001b'), false, 'no escape sequence survives into the menu');
  assert.equal(rendered.includes('evil'), false, 'unsafe rows are dropped, not rewritten');
  assert.ok(suggestions?.items.some((item) => item.value === 'skill:safe-skill'));
});

test('Esc passes through to an open menu and only cancels when it is closed', () => {
  assert.equal(escAction({ menuOpen: true }), 'pass');
  assert.equal(escAction({ menuOpen: false }), 'cancel');
  assert.deepEqual(keyAction('\x1b', true), { kind: 'escape' });
});

test('the exit commands never reach the socket and exit exactly once', () => {
  for (const command of ['/q', '/quit', '/exit', '/bye']) {
    const sent: string[] = [];
    let exits = 0;
    routeLine(command, { send: (text) => sent.push(text), exit: () => { exits += 1; } });
    assert.deepEqual(sent, [], `${command} was forwarded`);
    assert.equal(exits, 1, `${command} did not exit`);
  }
  const sent: string[] = [];
  let exits = 0;
  routeLine('hello session', { send: (text) => sent.push(text), exit: () => { exits += 1; } });
  assert.deepEqual(sent, ['hello session']);
  assert.equal(exits, 0);
});

/** Records what the surface key handler did, for the conventions below. */
function keyHarness(): { effects: KeyEffects; log: string[]; scrolled: string[] } {
  const log: string[] = [];
  const scrolled: string[] = [];
  return {
    log,
    scrolled,
    effects: {
      sendLine: (text) => log.push(`send:${text}`),
      exit: () => log.push('exit'),
      clearEditor: () => log.push('clear'),
      clearHint: () => log.push('hint:off'),
      showHint: () => log.push('hint:on'),
      scroll: (action) => {
        scrolled.push(action.kind);
        return true;
      },
    },
  };
}

test('a second Ctrl+C inside the window exits exactly once', () => {
  const harness = keyHarness();
  let memory: KeyMemory = { lastCtrlC: undefined, exited: false };
  const press = (now: number): void => {
    const outcome = surfaceKey(
      { kind: 'ctrl-c' },
      memory,
      { editorEmpty: true, menuOpen: false, now },
      harness.effects,
    );
    assert.equal(outcome.consumed, true);
    memory = outcome.memory;
  };
  press(1000);
  assert.deepEqual(harness.log, ['hint:on'], 'the first press only hints');
  press(1900);
  assert.deepEqual(harness.log, ['hint:on', 'exit'], 'the second press exits');
  press(2000);
  press(2100);
  assert.equal(harness.log.filter((entry) => entry === 'exit').length, 1, 'no double exit');
});

test('Esc cancels once with the menu closed and never with it open', () => {
  const closed = keyHarness();
  const cancelled = surfaceKey(
    { kind: 'escape' },
    { lastCtrlC: undefined, exited: false },
    { editorEmpty: true, menuOpen: false, now: 0 },
    closed.effects,
  );
  assert.equal(cancelled.consumed, true);
  assert.deepEqual(closed.log, ['send:/cancel']);
  assert.equal(
    closed.log.filter((entry) => entry === 'send:/cancel').length,
    1,
    'exactly one /cancel',
  );

  const open = keyHarness();
  const passed = surfaceKey(
    { kind: 'escape' },
    { lastCtrlC: undefined, exited: false },
    { editorEmpty: true, menuOpen: true, now: 0 },
    open.effects,
  );
  assert.equal(passed.consumed, false, 'the Editor gets the key');
  assert.deepEqual(open.log, [], 'no turn interaction while the menu is open');
});

test('Esc disarms the Ctrl+C window: Ctrl+C, Esc, Ctrl+C neither keeps the first window nor exits', () => {
  const harness = keyHarness();
  let memory: KeyMemory = { lastCtrlC: undefined, exited: false };
  const press = (action: Parameters<typeof surfaceKey>[0], now: number): void => {
    memory = surfaceKey(
      action,
      memory,
      { editorEmpty: true, menuOpen: false, now },
      harness.effects,
    ).memory;
  };
  press({ kind: 'ctrl-c' }, 1000);
  assert.equal(memory.lastCtrlC, 1000, 'the first press arms the window');
  press({ kind: 'escape' }, 1200);
  assert.equal(memory.lastCtrlC, undefined, 'Esc disarms it');
  press({ kind: 'ctrl-c' }, 1400);
  assert.equal(harness.log.filter((entry) => entry === 'exit').length, 0, 'Esc cancelled the prompt, not the turn');
  assert.equal(memory.lastCtrlC, 1400, 'the second Ctrl+C starts a new window');
});

test('Ctrl+C clears typed text instead of touching the turn', () => {
  const harness = keyHarness();
  const outcome = surfaceKey(
    { kind: 'ctrl-c' },
    { lastCtrlC: undefined, exited: false },
    { editorEmpty: false, menuOpen: false, now: 500 },
    harness.effects,
  );
  assert.deepEqual(harness.log, ['clear', 'hint:off']);
  assert.equal(outcome.memory.lastCtrlC, undefined, 'clearing does not start the exit window');
});
