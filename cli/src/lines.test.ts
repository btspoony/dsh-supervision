import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitLines } from './lines.js';

test('a bare CR submits, matching hc paste plus Enter', () => {
  assert.deepEqual(splitLines('', 'run the tests\r'), { lines: ['run the tests'], rest: '' });
});

test('a bare LF submits as well', () => {
  assert.deepEqual(splitLines('', 'run the tests\n'), { lines: ['run the tests'], rest: '' });
});

test('CRLF is one terminator, so no blank line is forwarded', () => {
  assert.deepEqual(splitLines('', 'one\r\ntwo\r\n'), { lines: ['one', 'two'], rest: '' });
});

test('a partial line is withheld until its terminator arrives', () => {
  const first = splitLines('', 'half');
  assert.deepEqual(first, { lines: [], rest: 'half' });
  assert.deepEqual(splitLines(first.rest, ' done\n'), { lines: ['half done'], rest: '' });
});

test('several lines in one chunk keep their order', () => {
  assert.deepEqual(splitLines('', 'a\nb\rc\n'), { lines: ['a', 'b', 'c'], rest: '' });
});
