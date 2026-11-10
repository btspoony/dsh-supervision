/**
 * Encoder conformance: herdr-core caps, terminator, and the rule that an
 * illegal report is dropped whole rather than truncated.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { clean, clearProgramStatus, programStatus } from './osc.js'

const ESC = '\x1b'
const ST = `${ESC}\\`
const PREFIX = `${ESC}]7501;`

/** The report's fields, split back out of its sequence. */
function fields(sequence: string): string[] {
  assert.ok(sequence.startsWith(PREFIX), 'sequence must open with ESC ] 7501 ;')
  assert.ok(sequence.endsWith(ST), 'sequence must terminate with ST')
  return sequence.slice(PREFIX.length, -ST.length).split(':')
}

function value(sequence: string, key: string): string {
  const field = fields(sequence).find(item => item.startsWith(`${key}=`))
  assert.ok(field !== undefined, `${key} must be present`)
  return field.slice(key.length + 1)
}

test('a minimal working report is state plus ST', () => {
  assert.equal(programStatus({ state: 'working' }), `${ESC}]7501;state=working${ST}`)
})

test('free text is base64 and round-trips', () => {
  const text = 'Apply the patch to /repo/api? (yes/no)'
  const sequence = programStatus({ state: 'blocked', kind: 'permission', msg: text, title: 'Run tests' })
  assert.equal(Buffer.from(value(sequence, 'msg'), 'base64').toString('utf8'), text)
  assert.equal(Buffer.from(value(sequence, 'title'), 'base64').toString('utf8'), 'Run tests')
})

test('control characters, DEL, C1 and bidi marks never reach the wire', () => {
  const sequence = programStatus({ state: 'working', msg: `a\u0000b\u001bc\u007fd\u009be\u202af` })
  const decoded = Buffer.from(value(sequence, 'msg'), 'base64').toString('utf8')
  assert.equal(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/.test(decoded), false)
})

test('whitespace collapses to one line', () => {
  assert.equal(clean(' a\n\n\t b  '), 'a b')
  const sequence = programStatus({ state: 'idle', msg: 'a\n\n\t b  ' })
  assert.equal(Buffer.from(value(sequence, 'msg'), 'base64').toString('utf8'), 'a b')
})

test('an over-cap msg is dropped whole, not truncated', () => {
  const msg = 'x'.repeat(2049)
  assert.equal(programStatus({ state: 'working', msg }), '')
})

test('an over-cap title is dropped whole', () => {
  assert.equal(programStatus({ state: 'idle', title: 'x'.repeat(193) }), '')
})

test('a msg exactly at the cap is legal', () => {
  assert.notEqual(programStatus({ state: 'working', msg: 'x'.repeat(2048) }), '')
})

test('kind is legal only on blocked', () => {
  assert.equal(programStatus({ state: 'working', kind: 'permission' }), '')
  assert.equal(programStatus({ state: 'done', kind: 'question' }), '')
  assert.notEqual(programStatus({ state: 'blocked', kind: 'auth' }), '')
})

test('an unknown kind is refused', () => {
  assert.equal(programStatus({ state: 'blocked', kind: 'other' as never }), '')
})

test('progress is legal only on working or blocked and stays 0..100', () => {
  assert.equal(programStatus({ state: 'idle', progress: 10 }), '')
  assert.equal(programStatus({ state: 'working', progress: 101 }), '')
  assert.equal(programStatus({ state: 'working', progress: -1 }), '')
  assert.equal(programStatus({ state: 'working', progress: 1.5 }), '')
  assert.equal(value(programStatus({ state: 'blocked', progress: 100 }), 'progress'), '100')
})

test('app accepts the word charset only and stays within 32 bytes', () => {
  assert.equal(programStatus({ state: 'idle', app: 'dsh web' }), '')
  assert.equal(programStatus({ state: 'idle', app: 'a'.repeat(33) }), '')
  assert.equal(value(programStatus({ state: 'idle', app: 'dsh' }), 'app'), 'dsh')
})

test('an id allows at most 8 segments of at most 32 bytes of the word charset', () => {
  assert.equal(programStatus({ state: 'idle', id: 'a/b/c/d/e/f/g/h/i' }), '')
  assert.equal(programStatus({ state: 'idle', id: 'a'.repeat(33) }), '')
  assert.equal(programStatus({ state: 'idle', id: 'sub/bad id' }), '')
  assert.notEqual(programStatus({ state: 'idle', id: 'sub/session-9f3c' }), '')
})

test('the whole sequence stays below 4096 bytes', () => {
  const sequence = programStatus({
    state: 'blocked',
    kind: 'permission',
    id: `${'a'.repeat(32)}/${'b'.repeat(32)}/${'c'.repeat(32)}/${'d'.repeat(12)}`,
    app: 'dsh',
    title: 'x'.repeat(192),
    msg: 'y'.repeat(2048),
  })
  assert.ok(sequence !== '')
  assert.ok(Buffer.byteLength(sequence, 'utf8') < 4096)
})

test('an unknown state is refused', () => {
  assert.equal(programStatus({ state: 'busy' as never }), '')
})

test('clear addresses the root and, given an id, one child subtree', () => {
  assert.equal(clearProgramStatus(), `${ESC}]7501;state=clear${ST}`)
  assert.equal(clearProgramStatus('sub/session-1'), `${ESC}]7501;state=clear:id=sub/session-1${ST}`)
  assert.equal(clearProgramStatus('bad id'), '')
})
