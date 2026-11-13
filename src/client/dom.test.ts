import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bridgedIds, guardFor, rowSessionId } from './dom.js'

test('a sidebar row key yields its session id', () => {
  assert.equal(rowSessionId('session:session-abc'), 'session-abc')
  assert.equal(rowSessionId('workspace:b002f50e'), undefined, 'a workspace row is not a session')
  assert.equal(rowSessionId('session:'), undefined, 'an empty id is no target')
  assert.equal(rowSessionId(null), undefined)
})

test('bridged ids come straight from the state payload', () => {
  assert.deepEqual([...bridgedIds(undefined)], [])
  assert.deepEqual(
    [...bridgedIds({
      proto: 1,
      sessions: {
        'session-a': { bridged: true, terminal: 't1', pid: 1, since: 2, asks: [] },
        'session-b': { bridged: true, terminal: 't1', pid: 1, since: 2, asks: [] },
      },
    })],
    ['session-a', 'session-b'],
  )
})

test('the guard covers exactly a bridged selected session', () => {
  const ids = new Set(['session-a'])
  assert.equal(guardFor(ids, 'session-a'), true)
  assert.equal(guardFor(ids, 'session-b'), false)
  assert.equal(guardFor(ids, undefined), false, 'no selection means no composer to cover')
})
