/**
 * Encoder conformance: herdr-core caps, terminator, and the rule that an
 * illegal report is dropped whole rather than truncated.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { clean, clearProgramStatus, encodeReport, programStatus } from './osc.js'

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

test('encodeReport flattens state and app, not just title and msg', () => {
  // A separator or terminator in either field would split the one record.
  const hostile = encodeReport({
    state: `error:app=fake${ST}`,
    app: `dsh:state=done${ST}`,
    title: 'repo',
  })
  assert.equal(hostile.split(ST).length, 2, 'exactly one terminator')
  assert.equal(hostile.split(PREFIX).length, 2, 'exactly one report start')
  assert.deepEqual(fields(hostile), ['state=error app fake', 'app=dsh state done', 'title=cmVwbw=='])
})

test('encodeReport caps state and app like a word field', () => {
  const sequence = encodeReport({ state: 'working', app: 'a'.repeat(64) })
  assert.equal(value(sequence, 'app'), 'a'.repeat(32))
})

test('encodeReport never returns an empty field', () => {
  // The contract is a report every time; an empty value must still be a word.
  assert.equal(encodeReport({ state: '', app: ':::' }), `${ESC}]7501;state=error${ST}`)
  assert.equal(encodeReport({ state: 'idle', app: '' }), `${ESC}]7501;state=idle${ST}`)
})

test('encodeReport caps title and msg in bytes, so multibyte text still fits', () => {
  // Both fields are byte budgets: these values are under their caps in
  // characters but far over them in UTF-8, which is what herdr-core counts.
  const sequence = encodeReport({ state: 'working', title: '字'.repeat(400), msg: 'é'.repeat(4000) })
  const decode = (key: string): string => Buffer.from(value(sequence, key), 'base64').toString('utf8')
  const title = decode('title')
  const msg = decode('msg')
  assert.ok(Buffer.byteLength(title, 'utf8') <= 192, 'title is a 192-byte budget')
  assert.ok(Buffer.byteLength(msg, 'utf8') <= 2048, 'msg is a 2048-byte budget')
  assert.ok(value(sequence, 'title').length <= 256, 'base64 title stays under its cap')
  assert.ok(value(sequence, 'msg').length <= 2732, 'base64 msg stays under its cap')
  assert.ok(Buffer.byteLength(sequence, 'utf8') < 4096)
  assert.equal(title, '字'.repeat(64), 'no code point is split')
})

test('encodeReport keeps ASCII output byte-identical', () => {
  assert.equal(
    encodeReport({ state: 'idle', app: 'dsh', title: 'repo', msg: 'ready' }),
    `${ESC}]7501;state=idle:app=dsh:title=cmVwbw==:msg=cmVhZHk=${ST}`,
  )
})

test('a report with both fields at their caps still lands under the frame limit', () => {
  // The byte caps are what make the whole-sequence check a backstop rather than
  // a dropping rule: 256 + 2732 base64 characters plus the words never reach
  // herdr-core's 4096-byte frame.
  const sequence = encodeReport({ state: 'working', app: 'a'.repeat(64), title: 'x'.repeat(192), msg: 'y'.repeat(2048) })
  assert.ok(Buffer.byteLength(sequence, 'utf8') < 4096)
  assert.equal(value(sequence, 'title'), Buffer.from('x'.repeat(192), 'utf8').toString('base64'))
  assert.equal(value(sequence, 'msg'), Buffer.from('y'.repeat(2048), 'utf8').toString('base64'))
})

test('clear addresses the root and, given an id, one child subtree', () => {
  assert.equal(clearProgramStatus(), `${ESC}]7501;state=clear${ST}`)
  assert.equal(clearProgramStatus('sub/session-1'), `${ESC}]7501;state=clear:id=sub/session-1${ST}`)
  assert.equal(clearProgramStatus('bad id'), '')
})
