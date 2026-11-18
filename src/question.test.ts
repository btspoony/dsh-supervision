/**
 * The parked-question queue on its own: ids, the outcome promise, and the audit
 * a decision reports. No host, socket or clock is involved, so these tests pin
 * the queue's contract rather than the plugin's wiring.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AskQuestion } from 'dsh-supervision-protocol'
import { skipAnswers } from './answers.js'
import type { QuestionAnswers } from './answers.js'
import { QuestionQueue } from './question.js'
import type { QuestionDecision } from './question.js'

const DB: AskQuestion = { id: 'db', question: 'Which database?', options: [{ label: 'SQLite' }] }
const WHY: AskQuestion = { id: 'why', question: 'Why?' }

test('a parked ask is listed, named by six hex chars, and resolves once settled', async () => {
  const decisions: QuestionDecision[] = []
  const queue = new QuestionQueue(decision => { decisions.push(decision) })

  const id = queue.park({ questions: [DB], session: 'session-1' })
  assert.match(id, /^[0-9a-f]{6}$/)
  const parked = { id, questions: [DB], session: 'session-1' }
  assert.deepEqual(queue.list(), [parked])
  assert.deepEqual(queue.ids(), [id])

  const answers: QuestionAnswers = { answers: [{ id: 'db', selected: ['SQLite'] }] }
  const outcome = queue.outcome(id)
  assert.equal(queue.settle(id, answers, 'supervisor'), true)
  assert.deepEqual(await outcome, answers)
  assert.deepEqual(decisions, [{ ask: parked, answers, source: 'supervisor' }])
  assert.deepEqual(queue.ids(), [], 'a settled ask is no longer parked')
  assert.equal(queue.outcome(id), undefined)
})

test('an unknown or already settled id cannot be settled a second time', () => {
  const audited: QuestionDecision[] = []
  const queue = new QuestionQueue(decision => { audited.push(decision) })
  const id = queue.park({ questions: [DB], session: 'session-1' })
  const answers = skipAnswers([DB])

  assert.equal(queue.settle('ask-0', answers, 'supervisor'), false)
  assert.equal(queue.settle(id, answers, 'supervisor'), true)
  assert.equal(queue.settle(id, answers, 'attached'), false)
  assert.equal(audited.length, 1)
  assert.deepEqual(queue.list(), [])
})

test('clearAll answers every parked ask from its own questions and audits nothing', async () => {
  const audited: QuestionDecision[] = []
  const queue = new QuestionQueue(decision => { audited.push(decision) })
  const first = queue.park({ questions: [DB, WHY], session: 'session-1' })
  const second = queue.park({ questions: [DB], session: 'session-2' })

  const outcomes = [queue.outcome(first), queue.outcome(second)]
  queue.clearAll(ask => skipAnswers(ask.questions))
  assert.deepEqual(await Promise.all(outcomes), [
    { answers: [{ id: 'db', selected: [] }, { id: 'why', selected: [] }] },
    { answers: [{ id: 'db', selected: [] }] },
  ])
  assert.deepEqual(queue.list(), [])
  assert.deepEqual(audited, [], 'teardown is not a decision, so nothing is echoed')
})

test('concurrent asks keep distinct ids and their own session', () => {
  const queue = new QuestionQueue(() => {})
  const ids = [
    queue.park({ questions: [DB], session: 'session-1' }),
    queue.park({ questions: [WHY], session: 'session-1' }),
    queue.park({ questions: [DB], session: 'session-2' }),
  ]
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(queue.list().map(ask => ask.session), ['session-1', 'session-1', 'session-2'])
})
