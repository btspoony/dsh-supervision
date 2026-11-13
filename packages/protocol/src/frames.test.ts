/**
 * Frame codec conformance from the forwarder's side: the server frames it must
 * accept, the framing rule that keeps a desynchronised stream out of the
 * writer, and the root report encoder it sends to the terminal.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_FRAME,
  MAX_ITEM_ARGS,
  MAX_ITEM_DETAIL,
  MAX_ITEM_REASONING,
  MAX_ITEM_TEXT,
  PROTO,
  decodeChunk,
  encodeFrame,
} from './frames.js';
import type { Decoded, MirrorItem, OutFrame } from './frames.js';
import { encodeReport } from './osc.js';

const welcome = JSON.stringify({
  t: 'welcome',
  proto: PROTO,
  session: 'session-1',
  title: 'repo',
  state: 'idle',
  turn: 0,
});

function frames(decoded: Decoded): readonly OutFrame[] {
  assert.equal(decoded.ok, true, decoded.ok ? '' : decoded.reason);
  return decoded.ok ? decoded.frames : [];
}

test('a frame split across chunks is decoded once the newline arrives', () => {
  const half = welcome.slice(0, 20);
  const first = decodeChunk('', half);
  assert.deepEqual(frames(first), []);
  assert.equal(first.ok && first.rest, half);

  const second = decodeChunk(first.ok ? first.rest : '', `${welcome.slice(20)}\n`);
  assert.deepEqual(frames(second).map((frame) => frame.t), ['welcome']);
});

test('several frames in one chunk are all decoded, in order', () => {
  const chunk = `${welcome}\n{"t":"echo","text":"hi"}\n{"t":"bye","reason":"reclaimed"}\n`;
  assert.deepEqual(frames(decodeChunk('', chunk)).map((frame) => frame.t), ['welcome', 'echo', 'bye']);
});

test('an unterminated frame over the cap is rejected, not buffered forever', () => {
  const decoded = decodeChunk('', 'x'.repeat(MAX_FRAME + 1));
  assert.equal(decoded.ok, false);
  assert.match(decoded.ok ? '' : decoded.reason, /exceeds/);
});

test('a terminated frame over the cap is rejected too', () => {
  const decoded = decodeChunk('', `${'x'.repeat(MAX_FRAME + 1)}\n`);
  assert.equal(decoded.ok, false);
});

test('invalid JSON and unknown frame types stop the stream', () => {
  assert.equal(decodeChunk('', 'not json\n').ok, false);
  assert.equal(decodeChunk('', '{"t":"nope"}\n').ok, false);
  assert.equal(decodeChunk('', '{"t":"welcome","proto":2}\n').ok, false);
});

test('a welcome must name a known state and a whole turn count', () => {
  const good = { t: 'welcome', proto: PROTO, session: 'session-1', title: 'repo', state: 'working', turn: 3 };
  assert.deepEqual(frames(decodeChunk('', `${JSON.stringify(good)}\n`)), [good]);
  assert.equal(PROTO, 2, 'the mirror frame is a breaking cut');
  assert.equal(decodeChunk('', `${JSON.stringify({ ...good, proto: 1 })}\n`).ok, false, 'proto 1 is stale');
  assert.equal(decodeChunk('', `${JSON.stringify({ ...good, state: 'busy' })}\n`).ok, false);
  assert.equal(decodeChunk('', `${JSON.stringify({ ...good, turn: 1.5 })}\n`).ok, false);
  assert.equal(decodeChunk('', `${JSON.stringify({ ...good, session: '' })}\n`).ok, false);
});

test('an error frame carries one of the protocol codes', () => {
  assert.deepEqual(frames(decodeChunk('', '{"t":"error","code":"busy","message":"held"}\n')), [
    { t: 'error', code: 'busy', message: 'held' },
  ]);
  assert.equal(decodeChunk('', '{"t":"error","code":"nope","message":"held"}\n').ok, false);
});

test('osc payloads stay opaque and unparsed', () => {
  const payload = '\\u001b]7501;state=working\\u001b\\\\';
  const [frame] = frames(decodeChunk('', `${JSON.stringify({ t: 'osc', data: payload })}\n`));
  assert.deepEqual(frame, { t: 'osc', data: payload });
});

test('sessions frames validate every item or reject the frame', () => {
  const good = '{"t":"sessions","items":[{"id":"session-1","cwd":"/repo","live":true,"bridged":false}]}';
  assert.deepEqual(frames(decodeChunk('', `${good}\n`)), [
    { t: 'sessions', items: [{ id: 'session-1', cwd: '/repo', live: true, bridged: false }] },
  ]);

  const bad = '{"t":"sessions","items":[{"id":"session-1","cwd":"/repo","live":"yes","bridged":false}]}';
  assert.equal(decodeChunk('', `${bad}\n`).ok, false);
  assert.equal(decodeChunk('', '{"t":"sessions","items":{}}\n').ok, false);
});

test('the mirror caps are the ones the plugin must respect', () => {
  assert.deepEqual([MAX_ITEM_TEXT, MAX_ITEM_REASONING, MAX_ITEM_ARGS, MAX_ITEM_DETAIL], [16 * 1024, 1024, 512, 2048]);
});

test('every mirror item kind survives the wire', () => {
  const items: readonly MirrorItem[] = [
    { k: 'user', text: 'implement the mirror' },
    {
      k: 'assistant',
      text: 'one block per step',
      reasoning: 'no deltas to stream',
      usage: { inputTokens: 1234, outputTokens: 340, cacheReadTokens: 900 },
      interrupted: true,
      turn: 4,
    },
    { k: 'tool', callId: 'c1', name: 'bash', args: '{"command":"ls"}', state: 'ok', detail: 'a\nb', ms: 12, turn: 4 },
    { k: 'assistant', turn: 0 },
    { k: 'tool', callId: 'c2', name: 'grep', args: '', state: 'start', turn: 4 },
  ];
  for (const item of items) {
    const decoded = decodeChunk('', encodeFrame({ t: 'mirror', item }));
    assert.deepEqual(frames(decoded), [{ t: 'mirror', item }]);
  }
});

test('a mirror frame rejects an unknown kind, state or turn', () => {
  const mirror = (item: unknown): string => `${JSON.stringify({ t: 'mirror', item })}\n`;
  const tool = { k: 'tool', callId: 'c1', name: 'bash', args: '{}', state: 'ok', turn: 1 };
  const assistant = { k: 'assistant', turn: 1 };
  assert.equal(decodeChunk('', mirror({ ...tool, k: 'nope' })).ok, false);
  assert.equal(decodeChunk('', mirror({ ...tool, state: 'maybe' })).ok, false);
  assert.equal(decodeChunk('', mirror({ ...tool, turn: -1 })).ok, false);
  assert.equal(decodeChunk('', mirror({ ...assistant, turn: 1.5 })).ok, false);
  assert.equal(decodeChunk('', mirror({ ...assistant, usage: { inputTokens: 1.5, outputTokens: 1 } })).ok, false);
  assert.equal(decodeChunk('', mirror({ ...assistant, usage: { inputTokens: -1, outputTokens: 1 } })).ok, false);
  assert.equal(decodeChunk('', mirror({ ...assistant, usage: { outputTokens: 1 } })).ok, false);
  assert.equal(decodeChunk('', mirror({ ...tool, callId: 1 })).ok, false);
  assert.equal(decodeChunk('', mirror({ ...assistant, reasoning: 1 })).ok, false);
  assert.equal(decodeChunk('', mirror(undefined)).ok, false);
  assert.equal(decodeChunk('', mirror([])).ok, false);
  assert.equal(decodeChunk('', '{"t":"mirror"}\n').ok, false);
});

test('a report is one OSC 7501 line terminated with ST', () => {
  assert.equal(encodeReport({ state: 'idle', app: 'dsh', title: 'repo' }), '\u001b]7501;state=idle:app=dsh:title=cmVwbw==\u001b\\');
});

test('report text is flattened to one control-free line before encoding', () => {
  const report = encodeReport({ state: 'error', msg: 'boom\u001b]7501;state=done\u001b\\\nsecond' });
  assert.equal(report.includes('\n'), false);
  assert.equal(report.split('\u001b\\').length, 2, 'exactly one terminator');
  assert.equal(report.split('\u001b]7501;').length, 2, 'exactly one report start');
});
