import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBridgePayload } from './banner.js'

const entry = { bridged: true, terminal: 'dsh-sup', pid: 81773, since: 2, asks: [] }

test('a proto-1 payload with readable entries is accepted', () => {
  assert.equal(isBridgePayload({ proto: 1, sessions: {} }), true)
  assert.equal(isBridgePayload({ proto: 1, sessions: { 'session-a': entry } }), true)
})

test('anything this client cannot read is not a payload', () => {
  const rejected: readonly unknown[] = [
    undefined,
    null,
    'json',
    [],
    {},
    { proto: 2, sessions: {} },
    { proto: '1', sessions: {} },
    { proto: 1 },
    { proto: 1, sessions: [] },
    { proto: 1, sessions: { 'session-a': { ...entry, bridged: false } } },
    { proto: 1, sessions: { 'session-a': { ...entry, terminal: 1 } } },
    { proto: 1, sessions: { 'session-a': { ...entry, pid: '51234' } } },
    { proto: 1, sessions: { 'session-a': { ...entry, since: null } } },
    { proto: 1, sessions: { 'session-a': { ...entry, asks: [1] } } },
    { proto: 1, sessions: { 'session-a': { ...entry, asks: 'a1b2c3' } } },
  ]
  for (const value of rejected) assert.equal(isBridgePayload(value), false, JSON.stringify(value))
})
