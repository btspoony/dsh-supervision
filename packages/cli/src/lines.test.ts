import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineForwarder, splitLines } from './lines.js';

test('a bare CR submits, matching hc paste plus Enter', () => {
  assert.deepEqual(splitLines('', 'run the tests\r'), { lines: ['run the tests'], rest: '', pendingCr: true });
});

test('a bare LF submits as well', () => {
  assert.deepEqual(splitLines('', 'run the tests\n'), { lines: ['run the tests'], rest: '', pendingCr: false });
});

test('CRLF is one terminator, so no blank line is forwarded', () => {
  assert.deepEqual(splitLines('', 'one\r\ntwo\r\n'), { lines: ['one', 'two'], rest: '', pendingCr: false });
});

test('a CRLF straddling two chunks is still one terminator', () => {
  const first = splitLines('', 'a\r');
  assert.deepEqual(first, { lines: ['a'], rest: '', pendingCr: true });
  assert.deepEqual(splitLines(first.rest, '\nb', first.pendingCr), { lines: [], rest: 'b', pendingCr: false });
});

test('a bare CR followed by a new chunk that is not an LF still terminates once', () => {
  const first = splitLines('', 'a\r');
  assert.deepEqual(splitLines(first.rest, 'b', first.pendingCr), { lines: [], rest: 'b', pendingCr: false });
});

test('a blank line split as CR then LF is one blank line', () => {
  const first = splitLines('', '\r');
  assert.deepEqual(first, { lines: [''], rest: '', pendingCr: true });
  assert.deepEqual(splitLines(first.rest, '\n', first.pendingCr), { lines: [], rest: '', pendingCr: false });
});

test('a partial line is withheld until its terminator arrives', () => {
  const first = splitLines('', 'half');
  assert.deepEqual(first, { lines: [], rest: 'half', pendingCr: false });
  assert.deepEqual(splitLines(first.rest, ' done\n', first.pendingCr), { lines: ['half done'], rest: '', pendingCr: false });
});

test('several lines in one chunk keep their order', () => {
  assert.deepEqual(splitLines('', 'a\nb\rc\n'), { lines: ['a', 'b', 'c'], rest: '', pendingCr: false });
});

test('a blank line reaches the forward callback exactly once', () => {
  const forwarded: string[] = [];
  const feed = lineForwarder((line) => forwarded.push(line));
  feed('one\r\n');
  feed('\r');
  feed('\n');
  assert.deepEqual(forwarded, ['one', '']);
});
