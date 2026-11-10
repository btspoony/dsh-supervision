/**
 * Root-report derivation: precedence, the resume latch, turn accounting, and
 * dedup. Every case is a pure fold, so no socket and no clock are involved.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRootState, reduceRootState, rootWord } from './state.js'
import type { RootState, StateEvent } from './state.js'

/** A root bound to the given title, before any fact arrives. */
function root(title = 'repo'): RootState {
  return createRootState('dsh', title)
}

/** Fold several facts in one pass. */
function fold(state: RootState, events: readonly StateEvent[]): RootState {
  return events.reduce(reduceRootState, state)
}

test('a fresh root reports idle at turn 0', () => {
  const state = root()
  assert.deepEqual(state.current, { state: 'idle', app: 'dsh', title: 'repo' })
  assert.equal(state.turn, 0)
})

test('a live turn reports working', () => {
  assert.equal(fold(root(), [{ type: 'turn/start', turn: 1 }]).current.state, 'working')
})

test('turn/end maps each reason kind to its word', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['completed', 'done'],
    ['error', 'error'],
    ['max-tokens', 'error'],
    ['blocked', 'blocked'],
    ['aborted', 'idle'],
    ['interrupted', 'idle'],
    ['forked', 'idle'],
    ['something-new', 'idle'],
  ]
  for (const [reason, word] of cases) {
    const state = fold(root(), [
      { type: 'turn/start', turn: 1 },
      { type: 'turn/end', turn: 1, reason },
    ])
    assert.equal(state.current.state, word, `${reason} must report ${word}`)
  }
})

test('a resumed session replays its tail without emitting done', () => {
  // A resume publishes no replayed turn, only the closer for a turn that was
  // still open at the crash; that closer must not read as a finished turn.
  const replayed = fold(root(), [
    { type: 'turn/end', turn: 3, reason: 'completed' },
    { type: 'agent/status', status: 'idle' },
  ])
  assert.equal(replayed.current.state, 'idle')
  assert.equal(replayed.turn, 0)
})

test('after the latch opens, each live turn counts once', () => {
  const state = fold(root(), [
    { type: 'turn/start', turn: 1 },
    { type: 'turn/end', turn: 1, reason: 'completed' },
    { type: 'turn/start', turn: 2 },
    { type: 'turn/end', turn: 2, reason: 'completed' },
  ])
  assert.equal(state.current.state, 'done')
  assert.equal(state.turn, 2)
})

test('a running agent reports working even between turns', () => {
  assert.equal(fold(root(), [{ type: 'agent/status', status: 'running' }]).current.state, 'working')
})

test('blocked outranks working', () => {
  const state = fold(root(), [
    { type: 'turn/start', turn: 1 },
    { type: 'turn/end', turn: 1, reason: 'blocked' },
    { type: 'agent/status', status: 'running' },
  ])
  assert.equal(state.current.state, 'blocked')
})

test('working outranks a remembered error', () => {
  const state = fold(root(), [
    { type: 'turn/start', turn: 1 },
    { type: 'turn/end', turn: 1, reason: 'error' },
    { type: 'turn/start', turn: 2 },
  ])
  assert.equal(state.current.state, 'working')
})

test('rootWord is the precedence table, highest first', () => {
  assert.equal(rootWord({ working: true, terminal: 'blocked' }), 'blocked')
  assert.equal(rootWord({ working: true, terminal: 'error' }), 'working')
  assert.equal(rootWord({ working: false, terminal: 'error' }), 'error')
  assert.equal(rootWord({ working: false, terminal: 'done' }), 'done')
  assert.equal(rootWord({ working: false, terminal: 'idle' }), 'idle')
})

test('the turn advances only when the root leaves working', () => {
  const working = fold(root(), [{ type: 'turn/start', turn: 1 }])
  assert.equal(working.turn, 0)
  const done = reduceRootState(working, { type: 'turn/end', turn: 1, reason: 'completed' })
  assert.equal(done.turn, 1)
  // A repeated word is not a turn.
  assert.equal(reduceRootState(done, { type: 'agent/status', status: 'idle' }).turn, 1)
})

test('an identical consecutive report keeps its identity', () => {
  const working = fold(root(), [{ type: 'turn/start', turn: 1 }])
  const again = reduceRootState(working, { type: 'agent/status', status: 'running' })
  assert.equal(again.current, working.current)
})

test('a changed report is a new record restating app and title', () => {
  const before = root()
  const renamed = reduceRootState(before, { type: 'title', title: 'api' })
  assert.notEqual(renamed.current, before.current)
  assert.deepEqual(renamed.current, { state: 'idle', app: 'dsh', title: 'api' })
})

test('a title change keeps the current word', () => {
  const state = fold(root(), [
    { type: 'turn/start', turn: 1 },
    { type: 'title', title: 'api' },
  ])
  assert.equal(state.current.state, 'working')
  assert.equal(state.current.title, 'api')
})

test('a no-op fold returns the very same state', () => {
  const state = root()
  assert.equal(reduceRootState(state, { type: 'turn/end', turn: 9, reason: 'completed' }), state)
})
