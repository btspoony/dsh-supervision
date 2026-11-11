/**
 * The parked-ask queue on its own: ids, the outcome promise, and the audit a
 * decision reports. No host, socket or clock is involved, so these tests pin
 * the queue's contract rather than the plugin's wiring.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApprovalQueue } from './approval.js'
import type { AskDecision } from './approval.js'

test('a parked ask is listed, named by six hex chars, and resolves once settled', async () => {
  const decisions: AskDecision[] = []
  const queue = new ApprovalQueue(decision => { decisions.push(decision) })

  const id = queue.park({ toolName: 'bash', reason: 'write outside the workspace' }, 'session-1')
  assert.match(id, /^[0-9a-f]{6}$/)
  const parked = { id, toolName: 'bash', reason: 'write outside the workspace', session: 'session-1' }
  assert.deepEqual(queue.list(), [parked])
  assert.deepEqual(queue.ids(), [id])

  const outcome = queue.outcome(id)
  assert.equal(queue.settle(id, 'allowed-once', 'supervisor'), true)
  assert.equal(await outcome, 'allowed-once')
  assert.deepEqual(decisions, [{ ask: parked, outcome: 'allowed-once', source: 'supervisor' }])
  assert.deepEqual(queue.ids(), [], 'a settled ask is no longer parked')
  assert.equal(queue.outcome(id), undefined)
})

test('an unknown or already settled id cannot be settled a second time', () => {
  const audited: AskDecision[] = []
  const queue = new ApprovalQueue(decision => { audited.push(decision) })
  const id = queue.park({ toolName: 'probe' }, 'session-1')

  assert.equal(queue.settle('ask-0', 'rejected', 'supervisor'), false)
  assert.equal(queue.settle(id, 'rejected', 'supervisor'), true)
  assert.equal(queue.settle(id, 'allowed-once', 'supervisor'), false)
  assert.equal(audited.length, 1)
  assert.deepEqual(queue.list(), [])
})

test('clearAll resolves every parked ask cancelled and audits nothing', async () => {
  const audited: AskDecision[] = []
  const queue = new ApprovalQueue(decision => { audited.push(decision) })
  const first = queue.park({ toolName: 'probe', reason: '' }, 'session-1')
  const second = queue.park({ toolName: 'write' }, 'session-2')
  assert.deepEqual(queue.list().map(ask => ask.reason), ['', ''])

  const outcomes = [queue.outcome(first), queue.outcome(second)]
  queue.clearAll('cancelled')
  assert.deepEqual(await Promise.all(outcomes), ['cancelled', 'cancelled'])
  assert.deepEqual(queue.list(), [])
  assert.deepEqual(audited, [], 'teardown is not a decision, so nothing is echoed')
})

test('concurrent asks keep distinct ids and their own session', () => {
  const queue = new ApprovalQueue(() => {})
  const ids = [
    queue.park({ toolName: 'bash' }, 'session-1'),
    queue.park({ toolName: 'edit' }, 'session-1'),
    queue.park({ toolName: 'bash' }, 'session-2'),
  ]
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(queue.list().map(ask => ask.session), ['session-1', 'session-1', 'session-2'])
})
