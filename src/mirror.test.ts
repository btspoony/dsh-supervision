/**
 * Event → transcript-item mapping: which events are conversation, how each
 * shape is reduced, and the caps every string respects. Pure, so no host.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_ITEM_ARGS, MAX_ITEM_DETAIL, MAX_ITEM_REASONING, MAX_ITEM_TEXT } from 'dsh-supervision-protocol'
import { MAX_CALLS, mirrorOf } from './mirror.js'
import type { CallRecord, SessionEvent } from './mirror.js'

/** A fresh call table, the state one bridge would hold. */
function table(): Map<string, CallRecord> {
  return new Map()
}

/** A user message carrying `text` from the given source kind. */
function user(text: string, kind = 'user'): SessionEvent {
  return { type: 'user/message', time: 1, data: { turn: 3, content: [{ type: 'text', text }], source: { kind } } }
}

test('a human user message maps to its text', () => {
  assert.deepEqual(mirrorOf(user('implement the mirror'), table()), { k: 'user', text: 'implement the mirror' })
})

test('a synthetic user message maps to nothing', () => {
  for (const kind of ['system-reminder', 'time-context', 'mstar-engine', 'goal-continuation']) {
    assert.equal(mirrorOf(user('injected context', kind), table()), undefined, kind)
  }
})

test('text blocks join in order and the text cap holds', () => {
  const event: SessionEvent = {
    type: 'user/message',
    data: { turn: 1, content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], source: { kind: 'user' } },
  }
  assert.deepEqual(mirrorOf(event, table()), { k: 'user', text: 'one\ntwo' })
  const capped = mirrorOf(user('x'.repeat(MAX_ITEM_TEXT * 2)), table())
  assert.ok(capped !== undefined && capped.k === 'user')
  assert.equal(capped.text.length, MAX_ITEM_TEXT)
})

test('an assistant step carries text, its first reasoning line, usage and interruption', () => {
  const event: SessionEvent = {
    type: 'assistant/message',
    data: {
      turn: 4,
      message: {
        content: [
          { type: 'reasoning', text: 'Tool-call blocks come one per step.\nA second line.' },
          { type: 'text', text: 'The host emits one assistant/message per step.' },
          { type: 'tool-call', text: undefined },
          { type: 'text', text: 'So the mirror prints finished blocks.' },
        ],
      },
      usage: { inputTokens: 12_300, outputTokens: 840, cacheReadTokens: 5 },
      interrupted: true,
    },
  }
  assert.deepEqual(mirrorOf(event, table()), {
    k: 'assistant',
    text: 'The host emits one assistant/message per step.\nSo the mirror prints finished blocks.',
    reasoning: 'Tool-call blocks come one per step.',
    usage: { inputTokens: 12_300, outputTokens: 840, cacheReadTokens: 5 },
    interrupted: true,
    turn: 4,
  })
})

test('an assistant step with no usage or interruption carries neither field', () => {
  const event: SessionEvent = {
    type: 'assistant/message',
    data: { turn: 2, message: { content: [{ type: 'text', text: 'done' }] } },
  }
  assert.deepEqual(mirrorOf(event, table()), { k: 'assistant', text: 'done', turn: 2 })
})

test('an assistant step whose only content is tool calls maps to nothing', () => {
  const event: SessionEvent = {
    type: 'assistant/message',
    data: { turn: 2, message: { content: [{ type: 'tool-call' }] } },
  }
  assert.equal(mirrorOf(event, table()), undefined)
})

test('the reasoning cap holds and keeps one line', () => {
  const event: SessionEvent = {
    type: 'assistant/message',
    data: { turn: 2, message: { content: [{ type: 'reasoning', text: `${'y'.repeat(MAX_ITEM_REASONING * 2)}\nnext` }] } },
  }
  const item = mirrorOf(event, table())
  assert.ok(item !== undefined && item.k === 'assistant')
  assert.equal(item.reasoning?.length, MAX_ITEM_REASONING)
})

test('a tool call starts, remembers its time, and its result reports ms and detail', () => {
  const calls = table()
  assert.deepEqual(
    mirrorOf({ type: 'tool/call', time: 1_000, data: { turn: 5, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } }, calls),
    { k: 'tool', callId: 'c1', name: 'bash', args: '{"command":"ls"}', state: 'start', turn: 5 },
  )
  assert.deepEqual([...calls.keys()], ['c1'])

  const result: SessionEvent = {
    type: 'tool/result',
    time: 1_012,
    data: { turn: 5, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] } },
  }
  assert.deepEqual(mirrorOf(result, calls), {
    k: 'tool',
    callId: 'c1',
    name: 'bash',
    args: '{"command":"ls"}',
    state: 'ok',
    detail: 'a.txt',
    ms: 12,
    turn: 5,
  })
  assert.equal(calls.size, 0, 'a result takes its entry back out')
})

test('a failed tool result reads error, and its detail is the last non-empty block tail', () => {
  const calls = table()
  mirrorOf({ type: 'tool/call', time: 0, data: { turn: 1, callId: 'c2', name: 'grep', arguments: '{}' } }, calls)
  const text = `${'z'.repeat(MAX_ITEM_DETAIL * 2)}tail`
  const item = mirrorOf(
    {
      type: 'tool/result',
      time: 3,
      data: {
        turn: 1,
        message: { toolCallId: 'c2', isError: true, content: [{ type: 'text', text }, { type: 'text', text: '  ' }] },
        error: { name: 'GrepError', code: 'ENOENT' },
      },
    },
    calls,
  )
  assert.ok(item !== undefined && item.k === 'tool')
  assert.equal(item.state, 'error')
  assert.equal(item.detail?.length, MAX_ITEM_DETAIL)
  assert.ok(item.detail?.endsWith('tail') === true)
  assert.equal(item.ms, 3)
})

test('a tool result with no text block falls back to the error reason', () => {
  const calls = table()
  mirrorOf({ type: 'tool/call', time: 0, data: { turn: 1, callId: 'c3', name: 'read', arguments: '{}' } }, calls)
  const item = mirrorOf(
    {
      type: 'tool/result',
      time: 1,
      data: { turn: 1, message: { toolCallId: 'c3', isError: true, content: [] }, error: { name: 'X', code: 'Y', reason: 'no such file' } },
    },
    calls,
  )
  assert.ok(item !== undefined && item.k === 'tool')
  assert.equal(item.detail, 'no such file')
})

test('a tool result for a call this bridge never saw maps to nothing', () => {
  const result: SessionEvent = { type: 'tool/result', time: 5, data: { turn: 1, message: { toolCallId: 'gone', content: [] } } }
  assert.equal(mirrorOf(result, table()), undefined)
})

test('an item whose event carries no turn maps to nothing', () => {
  const calls = table()
  assert.equal(
    mirrorOf({ type: 'assistant/message', time: 1, data: { message: { content: [{ type: 'text', text: 'hi' }] } } }, calls),
    undefined,
  )
  assert.equal(mirrorOf({ type: 'tool/call', time: 1, data: { callId: 'c0', name: 'bash', arguments: '{}' } }, calls), undefined)
  mirrorOf({ type: 'tool/call', time: 1, data: { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' } }, calls)
  const result: SessionEvent = { type: 'tool/result', time: 2, data: { message: { toolCallId: 'c1', content: [] } } }
  assert.equal(mirrorOf(result, calls), undefined)
})

test('a tool pair whose events carry no time reports no ms', () => {
  const calls = table()
  mirrorOf({ type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'bash', arguments: '{}' } }, calls)
  const item = mirrorOf({ type: 'tool/result', time: 2, data: { turn: 1, message: { toolCallId: 'c1', content: [] } } }, calls)
  assert.ok(item !== undefined && item.k === 'tool')
  assert.equal(item.ms, undefined, 'an unstamped call has no duration to report')
})

test('the call table is bounded and drops the oldest entry', () => {
  const calls = table()
  for (let index = 0; index < MAX_CALLS + 4; index += 1) {
    mirrorOf({ type: 'tool/call', time: index, data: { turn: 1, callId: `c${String(index)}`, name: 'bash', arguments: '{}' } }, calls)
  }
  assert.equal(calls.size, MAX_CALLS)
  assert.equal(calls.has('c0'), false, 'the oldest calls are gone')
  assert.equal(calls.has(`c${String(MAX_CALLS + 3)}`), true, 'the newest call is kept')
})

test('the args cap holds on a tool call and on its result', () => {
  const calls = table()
  const args = 'a'.repeat(MAX_ITEM_ARGS * 2)
  const item = mirrorOf({ type: 'tool/call', time: 0, data: { turn: 1, callId: 'c9', name: 'bash', arguments: args } }, calls)
  assert.ok(item !== undefined && item.k === 'tool')
  assert.equal(item.args.length, MAX_ITEM_ARGS)

  const result = mirrorOf({ type: 'tool/result', time: 1, data: { turn: 1, message: { toolCallId: 'c9', content: [] } } }, calls)
  assert.ok(result !== undefined && result.k === 'tool')
  assert.equal(result.args, item.args, 'the result echoes the call it remembers')
})

test('every other event type maps to nothing', () => {
  for (const type of ['turn/start', 'turn/end', 'step/start', 'session/title', 'system/message', 'assistant/attempt']) {
    assert.equal(mirrorOf({ type, data: { turn: 1 } }, table()), undefined, type)
  }
  assert.equal(mirrorOf({ type: 'user/message' }, table()), undefined)
})
