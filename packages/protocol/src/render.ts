/**
 * The tty half of the wire: how a forwarder turns one `OutFrame` into bytes.
 * `sessions` returns `undefined` because the tty transport has no listing
 * command, and `error` is tty-only — a forwarder keeps its stderr and exit.
 */

import type { OutFrame } from './frames.js'
import { APP_NAME, encodeReport } from './osc.js'

/**
 * Renders one frame for a terminal, newline included.
 * @param frame - any frame the plugin may write.
 * @returns bytes to write, or `undefined` when this transport has nothing to say.
 */
export function renderFrame(frame: OutFrame): string | undefined {
  switch (frame.t) {
    case 'welcome':
      // `state` and `turn` are not written: hc replaces the record whole, so the
      // forwarder's own readiness record is the one it already knows.
      return `${encodeReport({ state: 'idle', app: APP_NAME, title: frame.title })}\n`
    case 'osc':
      // `osc.data` is opaque: written verbatim, never inspected or re-encoded.
      return frame.data
    case 'echo':
      return `${frame.text}\n`
    case 'sessions':
      return undefined
    case 'error':
      return `${encodeReport({ state: 'error', app: APP_NAME, msg: `${frame.code}: ${frame.message}` })}\n`
    case 'bye':
      return `${encodeReport({ state: 'clear', app: APP_NAME })}\n`
  }
}
