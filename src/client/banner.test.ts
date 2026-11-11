/**
 * The banner's pure half: what counts as a readable payload, which session gets
 * a banner, and the sentence it shows.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bannerText, isBridgePayload, supervisedEntry } from './banner.js'
import type { BridgeEntry } from './banner.js'

/** One well-formed entry, as the state route writes it. */
const entry: BridgeEntry = { bridged: true, terminal: 'w1', pid: 51234, since: 1762, asks: ['a1b2c3'] }

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

test('only the bridged current session gets an entry', () => {
  const state = { proto: 1, sessions: { 'session-a': entry } }
  assert.deepEqual(supervisedEntry(state, 'session-a'), entry)
  assert.equal(supervisedEntry(state, 'session-b'), undefined)
  assert.equal(supervisedEntry(undefined, 'session-a'), undefined)
})

test('a session name that collides with an object member is not a bridge', () => {
  assert.equal(supervisedEntry({ proto: 1, sessions: {} }, 'toString'), undefined)
})

test('the sentence names the terminal, the pid and where approvals are answered', () => {
  assert.equal(
    bannerText(entry),
    'Supervised from w1 (pid 51234) · approvals are answered there',
  )
})
