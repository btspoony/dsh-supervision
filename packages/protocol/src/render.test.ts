/**
 * Renderer conformance: one row per `OutFrame` arm, pinned to the bytes the
 * forwarder used to write inline.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { OutFrame } from './frames.js'
import { renderFrame } from './render.js'

const ESC = '\x1b'
const ST = `${ESC}\\`

/** The report sequence plus the newline every tty record carries. */
function report(fields: string): string {
  return `${ESC}]7501;${fields}${ST}\n`
}

const CASES: readonly { readonly name: string; readonly frame: OutFrame; readonly bytes: string | undefined }[] = [
  {
    name: 'welcome renders the root idle record carrying only the title',
    frame: { t: 'welcome', proto: 1, session: 's1', title: 'demo', state: 'working', turn: 3 },
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
