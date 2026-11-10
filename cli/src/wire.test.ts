import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeChunk, encodeReport, MAX_FRAME, type Decoded, type ServerFrame } from './wire.js';

const welcome = JSON.stringify({
  t: 'welcome',
  proto: 1,
  session: 'session-1',
  title: 'repo',
  state: 'idle',
  turn: 0,
});

function frames(decoded: Decoded): readonly ServerFrame[] {
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

test('a report is one OSC 7501 line terminated with ST', () => {
  assert.equal(encodeReport({ state: 'idle', app: 'dsh', title: 'repo' }), '\u001b]7501;state=idle:app=dsh:title=cmVwbw==\u001b\\');
});

test('report text is flattened to one control-free line before encoding', () => {
  const report = encodeReport({ state: 'error', msg: 'boom\u001b]7501;state=done\u001b\\\nsecond' });
  assert.equal(report.includes('\n'), false);
  assert.equal(report.split('\u001b\\').length, 2, 'exactly one terminator');
  assert.equal(report.split('\u001b]7501;').length, 2, 'exactly one report start');
});
