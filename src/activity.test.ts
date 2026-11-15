/**
 * Activity aggregation as a pure table: lineage, origin, ownership and status
 * decide what the root has to report, and the summary says it in one line.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { ACTIVITY_STALE_MS, activityOf, activitySummary, staleActivity } from './activity.js'
import type { AgentActivityView, JobActivityView } from './activity.js'

/** A running subagent descendant of `parent`. */
function subagent(sessionId: string, parent: string, status: AgentActivityView['status'] = 'running'): AgentActivityView {
  return { sessionId, parentSession: parent, origin: 'subagent', status }
}

/** A job owned by `owner` in `status`. */
function job(id: string, owner: string, status: string, label?: string): JobActivityView {
  return label === undefined ? { id, owner, status } : { id, owner, status, label }
}

test('a running descendant chain is active two levels deep, in input order', () => {
  const input = {
    agents: [
      { sessionId: 'root', status: 'running' } as AgentActivityView,
      subagent('child', 'root'),
      subagent('grandchild', 'child'),
      subagent('idle-child', 'root', 'idle'),
    ],
    jobs: [],
  }
  assert.deepEqual(activityOf('root', input), {
    subagents: [{ id: 'child' }, { id: 'grandchild' }],
    jobs: [],
  })
})

test('a fork inherits the parent but is not work for this root', () => {
  const input = {
    agents: [
      { sessionId: 'forked', parentSession: 'root', status: 'running' } as AgentActivityView,
      { sessionId: 'explicit', parentSession: 'root', origin: 'fork', status: 'running' } as AgentActivityView,
      subagent('real', 'root'),
    ],
    jobs: [],
  }
  assert.deepEqual(activityOf('root', input).subagents, [{ id: 'real' }])
})

test('an orphan or a looping lineage terminates and never counts', () => {
  const orphan: AgentActivityView = { sessionId: 'orphan', parentSession: 'gone', origin: 'subagent', status: 'running' }
  const loopA: AgentActivityView = { sessionId: 'a', parentSession: 'b', origin: 'subagent', status: 'running' }
  const loopB: AgentActivityView = { sessionId: 'b', parentSession: 'a', origin: 'subagent', status: 'running' }
  const selfLoop: AgentActivityView = { sessionId: 'self', parentSession: 'self', origin: 'subagent', status: 'running' }
  assert.deepEqual(activityOf('root', { agents: [orphan, loopA, loopB, selfLoop], jobs: [] }).subagents, [])
})

test('only the root-owned running or stopping jobs are active, in input order', () => {
  const input = {
    agents: [],
    jobs: [
      job('running', 'root', 'running', 'nightly build'),
      job('stopping', 'root', 'stopping'),
      job('done', 'root', 'done'),
      job('foreign', 'other', 'running'),
      { id: 'ownerless', status: 'running' } as JobActivityView,
    ],
  }
  assert.deepEqual(activityOf('root', input).jobs, [
    { id: 'running', label: 'nightly build' },
    { id: 'stopping' },
  ])
})

test('the summary joins the active families, pluralises and stays empty when idle', () => {
  assert.deepEqual(activitySummary({ subagents: [], jobs: [] }), { working: false, msg: '' })
  assert.deepEqual(activitySummary({ subagents: [{ id: 'a' }], jobs: [] }), { working: true, msg: '1 subagent' })
  assert.deepEqual(activitySummary({ subagents: [{ id: 'a' }, { id: 'b' }], jobs: [] }), {
    working: true,
    msg: '2 subagents',
  })
  assert.deepEqual(activitySummary({ subagents: [], jobs: [{ id: 'j' }] }), { working: true, msg: '1 job' })
  assert.deepEqual(activitySummary({ subagents: [], jobs: [{ id: 'j' }, { id: 'k' }] }), {
    working: true,
    msg: '2 jobs',
  })
  assert.deepEqual(activitySummary({ subagents: [{ id: 'a' }, { id: 'b' }], jobs: [{ id: 'j' }] }), {
    working: true,
    msg: '2 subagents · 1 job',
  })
})

test('stale is strict: the window itself is fresh, one millisecond past it is not', () => {
  const now = 10 * ACTIVITY_STALE_MS
  assert.equal(staleActivity(now, now), false)
  assert.equal(staleActivity(now - ACTIVITY_STALE_MS, now), false)
  assert.equal(staleActivity(now - ACTIVITY_STALE_MS - 1, now), true)
  assert.equal(staleActivity(now + ACTIVITY_STALE_MS, now), false, 'a future stamp is never stale')
})
