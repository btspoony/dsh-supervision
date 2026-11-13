/**
 * Renderer conformance: one row per `OutFrame` arm, pinned to the bytes the
 * forwarder used to write inline.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PROTO, type MirrorItem, type OutFrame } from './frames.js'
import { renderFrame, renderMirror } from './render.js'

const ESC = '\x1b'
const ST = `${ESC}\\`

/** The report sequence plus the newline every tty record carries. */
function report(fields: string): string {
  return `${ESC}]7501;${fields}${ST}\n`
}

const CASES: readonly { readonly name: string; readonly frame: OutFrame; readonly bytes: string | undefined }[] = [
  {
    name: 'welcome renders the root idle record carrying only the title',
    frame: { t: 'welcome', proto: PROTO, session: 's1', title: 'demo', state: 'working', turn: 3 },
    bytes: report('state=idle:app=dsh:title=ZGVtbw=='),
  },
  {
    name: 'osc is written verbatim, with no trailing newline added',
    frame: { t: 'osc', data: `${ESC}]7501;state=working${ST}` },
    bytes: `${ESC}]7501;state=working${ST}`,
  },
  {
    name: 'echo appends exactly one newline',
    frame: { t: 'echo', text: 'sent' },
    bytes: 'sent\n',
  },
  {
    name: 'sessions has no tty rendering',
    frame: { t: 'sessions', items: [{ id: 's1', cwd: '/tmp', live: true, bridged: false }] },
    bytes: undefined,
  },
  {
    name: 'error renders the root error record naming the code',
    frame: { t: 'error', code: 'busy', message: 'already bridged' },
    bytes: report('state=error:app=dsh:msg=YnVzeTogYWxyZWFkeSBicmlkZ2Vk'),
  },
  {
    name: 'bye clears the root record',
    frame: { t: 'bye', reason: 'backend gone' },
    bytes: report('state=clear:app=dsh'),
  },
]

for (const item of CASES) {
  test(item.name, () => {
    assert.equal(renderFrame(item.frame), item.bytes)
  })
}

/** One mirror item plus the exact block it prints at `width`. */
const MIRROR: readonly { readonly name: string; readonly item: MirrorItem; readonly width: number; readonly lines: string }[] = [
  {
    name: 'a user turn takes the gutter, and its own newlines keep the indent',
    item: { k: 'user', text: 'implement the mirror\nsecond line' },
    width: 20,
    lines: '❯ implement the\n  mirror\n  second line',
  },
  {
    name: 'a user turn wraps to the width it is given',
    item: { k: 'user', text: 'one two three four five' },
    width: 12,
    lines: '❯ one two\n  three four\n  five',
  },
  {
    name: 'an assistant block carries its thought line, suffix and usage',
    item: {
      k: 'assistant',
      reasoning: 'Tool-call blocks come one per step.\nno deltas to stream.',
      text: 'The host emits one assistant/message per step, so the mirror prints finished blocks.',
      usage: { inputTokens: 1234, outputTokens: 340, cacheReadTokens: 900 },
      interrupted: true,
      turn: 4,
    },
    width: 100,
    lines:
      '· Tool-call blocks come one per step.\n' +
      'The host emits one assistant/message per step, so the mirror prints finished blocks. (interrupted)\n' +
      '⟦↑1,234 ↓340 R900⟧',
  },
  {
    name: 'usage groups thousands and omits a cache read it was not given',
    item: { k: 'assistant', text: 'done', usage: { inputTokens: 1234567, outputTokens: 0 }, turn: 9 },
    width: 100,
    lines: 'done\n⟦↑1,234,567 ↓0⟧',
  },
  {
    name: 'a tool start shows the pending glyph and no duration',
    item: {
      k: 'tool',
      callId: 'c1',
      name: 'bash',
      args: '{"command":"ls -la","description":"List the protocol package"}',
      state: 'start',
      turn: 2,
    },
    width: 100,
    lines: '⏳ bash: List the protocol package',
  },
  {
    name: 'a finished tool call carries its duration',
    item: {
      k: 'tool',
      callId: 'c1',
      name: 'bash',
      args: '{"command":"ls -la","description":"List the protocol package"}',
      state: 'ok',
      ms: 12,
      turn: 2,
    },
    width: 100,
    lines: '✔ bash: List the protocol package ⟦12ms⟧',
  },
  {
    name: 'a failed tool call shows its first detail line under the header',
    item: {
      k: 'tool',
      callId: 'c2',
      name: 'grep',
      args: '{"pattern":"find session/event emitters"}',
      state: 'error',
      detail: 'rg: no matches in packages/\nsecond line',
      ms: 3,
      turn: 3,
    },
    width: 100,
    lines: '✘ grep: find session/event emitters ⟦3ms⟧\n  └─ rg: no matches in packages/',
  },
  {
    name: 'arguments that are not JSON fall back to their own head',
    item: { k: 'tool', callId: 'c3', name: 'mystery', args: 'raw {not json', state: 'ok', turn: 1 },
    width: 100,
    lines: '✔ mystery: raw {not json',
  },
  {
    name: 'arguments with no readable key fall back to their head too',
    item: { k: 'tool', callId: 'c4', name: 'mystery', args: '{"other":"value"}', state: 'start', turn: 1 },
    width: 100,
    lines: '⏳ mystery: {"other":"value"}',
  },
]

for (const mirror of MIRROR) {
  test(mirror.name, () => {
    assert.equal(renderMirror(mirror.item, mirror.width), mirror.lines)
  })
}

test('a mirror frame renders exactly the item it carries, plus one newline', () => {
  const item: MirrorItem = { k: 'user', text: 'both halves show this' }
  const block = renderMirror(item, 100)
  assert.equal(block.endsWith('\n'), false, 'the formatter itself adds no terminator')
  assert.equal(renderFrame({ t: 'mirror', item }), `${block}\n`)
})
