/**
 * The stdin grammar, tested as a pure table: one line in, one command out. The
 * cases mirror the brief's grammar table verbatim, framing included.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLine, splitLines } from './stdin.js'

test('a blank or whitespace-only line is not a command', () => {
  assert.equal(parseLine(''), undefined)
  assert.equal(parseLine('\r\n'), undefined)
  assert.equal(parseLine('   \t '), undefined)
})

test('plain text steers verbatim, trailing CR/LF only', () => {
  assert.deepEqual(parseLine('run the tests'), { kind: 'steer', text: 'run the tests' })
  assert.deepEqual(parseLine('  two  spaces  '), { kind: 'steer', text: '  two  spaces  ' })
  assert.deepEqual(parseLine('line\r\n'), { kind: 'steer', text: 'line' })
  assert.deepEqual(parseLine('line\r'), { kind: 'steer', text: 'line' })
})

test('the verbs map to their commands', () => {
  assert.deepEqual(parseLine('/cancel'), { kind: 'cancel' })
  assert.deepEqual(parseLine('/status'), { kind: 'status' })
  assert.deepEqual(parseLine('/y'), { kind: 'yes' })
  assert.deepEqual(parseLine('/n'), { kind: 'no' })
  assert.deepEqual(parseLine('/approve a1b2'), { kind: 'approve', ask: 'a1b2' })
  assert.deepEqual(parseLine('/reject a1b2'), { kind: 'reject', ask: 'a1b2' })
})

test('/new carries an optional cwd', () => {
  assert.deepEqual(parseLine('/new'), { kind: 'new', cwd: undefined })
  assert.deepEqual(parseLine('/new /abs/path'), { kind: 'new', cwd: '/abs/path' })
  assert.deepEqual(parseLine('/new a b'), { kind: 'unknown', verb: 'new' })
})

test('/attach needs a session id', () => {
  assert.deepEqual(parseLine('/attach session-abc'), { kind: 'attach', session: 'session-abc' })
  assert.deepEqual(parseLine('/attach'), { kind: 'unknown', verb: 'attach' })
  assert.deepEqual(parseLine('/attach other-abc'), { kind: 'unknown', verb: 'attach' })
  assert.deepEqual(parseLine('/attach session-a session-b'), { kind: 'unknown', verb: 'attach' })
})

test('a malformed local verb is unknown, named by its first word', () => {
  assert.deepEqual(parseLine('/approve'), { kind: 'unknown', verb: 'approve' })
  assert.deepEqual(parseLine('/cancel now'), { kind: 'unknown', verb: 'cancel' })
  assert.deepEqual(parseLine('/'), { kind: 'unknown', verb: '' })
})

test('any other slash verb is a host command candidate, carrying its whole line', () => {
  assert.deepEqual(parseLine('/help'), { kind: 'command', name: 'help', text: '/help' })
  assert.deepEqual(parseLine('/compact focus the retry'), {
    kind: 'command',
    name: 'compact',
    text: '/compact focus the retry',
  })
  // Only the wire framing goes: the command receives the line as typed.
  assert.deepEqual(parseLine('/goal  two  spaces\r\n'), { kind: 'command', name: 'goal', text: '/goal  two  spaces' })
})


test('/skill and /skill: name one skill, and anything else is malformed', () => {
  assert.deepEqual(parseLine('/skill:use-dsh-sup'), { kind: 'skill', name: 'use-dsh-sup', args: [] })
  assert.deepEqual(parseLine('/skill use-dsh-sup'), { kind: 'skill', name: 'use-dsh-sup', args: [] })
  assert.deepEqual(parseLine('/skill:a1'), { kind: 'skill', name: 'a1', args: [] })
  assert.deepEqual(parseLine('/skill:'), { kind: 'unknown', verb: 'skill' })
  assert.deepEqual(parseLine('/skill'), { kind: 'unknown', verb: 'skill' })
  assert.deepEqual(parseLine('/skill:Two'), { kind: 'unknown', verb: 'skill' })
  assert.deepEqual(parseLine('/skill:-lead'), { kind: 'unknown', verb: 'skill' })
  assert.deepEqual(parseLine('/skill:foo:bar'), { kind: 'unknown', verb: 'skill' })
})

test('whatever follows the skill name is the operator\'s own text, not a refusal', () => {
  assert.deepEqual(parseLine('/skill:use-dsh-sup extra words'), {
    kind: 'skill',
    name: 'use-dsh-sup',
    args: ['extra', 'words'],
  })
  assert.deepEqual(parseLine('/skill use-dsh-sup extra words'), {
    kind: 'skill',
    name: 'use-dsh-sup',
    args: ['extra', 'words'],
  })
  // A malformed name stays malformed however much text follows it.
  assert.deepEqual(parseLine('/skill:Two extra'), { kind: 'unknown', verb: 'skill' })
})
test('a bracketed-paste wrapper is stripped', () => {
  assert.deepEqual(parseLine('\u001b[200~/status\u001b[201~'), { kind: 'status' })
  assert.deepEqual(parseLine('\u001b[200~hello\u001b[201~'), { kind: 'steer', text: 'hello' })
})

test('framing splits on LF, CRLF and a lone CR', () => {
  assert.deepEqual(splitLines('', 'a\nb\r\nc\rd'), { lines: ['a', 'b', 'c'], rest: 'd' })
  assert.deepEqual(splitLines('par', 'tial\n'), { lines: ['partial'], rest: '' })
  assert.deepEqual(splitLines('', 'no terminator'), { lines: [], rest: 'no terminator' })
})
