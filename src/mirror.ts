/**
 * Session events as transcript items: the pure mapping from the host's event
 * union to the one human-facing frame, plus the bounded call table whose
 * timing a tool result needs. No socket, clock, or process state here.
 */

import {
  MAX_FRAME,
  MAX_ITEM_ARGS,
  MAX_ITEM_CALL_ID,
  MAX_ITEM_DETAIL,
  MAX_ITEM_NAME,
  MAX_ITEM_REASONING,
  MAX_ITEM_TEXT,
} from 'dsh-supervision-protocol'
import type { MirrorItem } from 'dsh-supervision-protocol'

/** One model-visible content block, reduced to the shapes the mirror reads. */
interface ContentBlock {
  readonly type: string
  readonly text?: string
}

/** Token counts as the host reports them on one finished assistant step. */
interface EventUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
}

/**
 * The slice of one `session/event` payload this plugin consumes. The plugin
 * declares it structurally — the host loads the plugin, never the reverse — so
 * every field is optional and the event `type` is the only discriminator.
 */
export interface SessionEvent {
  readonly type: string
  /** Unix epoch milliseconds; the host stamps every event it appends. */
  readonly time?: number
  readonly data?: {
    readonly turn?: number
    readonly reason?: { readonly kind?: string }
    readonly title?: string
    /** `user/message`: the model-visible blocks, `source.kind` telling a human from plumbing. */
    readonly content?: readonly ContentBlock[]
    readonly source?: { readonly kind?: string }
    /** `assistant/message` and `tool/result`: the persisted message. */
    readonly message?: {
      readonly content?: readonly ContentBlock[]
      readonly isError?: boolean
      /** Which call a tool result answers. */
      readonly toolCallId?: string
    }
    readonly usage?: EventUsage
    readonly interrupted?: boolean
    /** `tool/call`: the pairing id, tool name, and raw arguments JSON. */
    readonly callId?: string
    readonly name?: string
    readonly arguments?: string
    /** `tool/result`: the failure identity and its user-facing reason. */
    readonly error?: { readonly name?: string; readonly code?: string; readonly reason?: string }
  }
}

/**
 * What one started call leaves behind for its result. The host's result event
 * carries neither name nor arguments, so the result prints what its call said.
 */
export interface CallRecord {
  readonly name: string
  readonly args: string
  /** The call's own stamp, absent when the host stamped no time on it. */
  readonly time?: number
}

/**
 * How many started calls a bridge remembers. A result that never arrives must
 * not grow the table, and a step cannot ask for more than this many at once.
 */
export const MAX_CALLS = 64

/**
 * One event as a transcript item.
 * @param event - any event the host delivers on `session/event`.
 * @param calls - the per-bridge call table; a `tool/call` records into it and
 *   its `tool/result` takes the entry back out.
 * @returns the item to mirror, or undefined when nothing human-facing happened.
 */
export function mirrorOf(event: SessionEvent, calls: Map<string, CallRecord>): MirrorItem | undefined {
  const data = event.data
  if (data === undefined) return undefined
  switch (event.type) {
    case 'user/message': {
      // Synthetic injections (system-reminder, time-context, mstar-engine, …)
      // are prompt plumbing, not conversation.
      if (data.source?.kind !== 'user') return undefined
      const text = head(blockText(data.content, 'text'), MAX_ITEM_TEXT)
      return text === '' ? undefined : { k: 'user', text }
    }
    case 'assistant/message': {
      const { turn } = data
      // A step with no usable turn cannot be placed in the transcript; inventing
      // one would report a turn the event never claimed.
      if (!isCount(turn)) return undefined
      // Tool-call blocks are ignored: their own `tool/call` carries them.
      const text = head(blockText(data.message?.content, 'text'), MAX_ITEM_TEXT)
      const reasoning = head(blockText(data.message?.content, 'reasoning').split('\n')[0]?.trim() ?? '', MAX_ITEM_REASONING)
      const usage = usageOf(data.usage)
      const interrupted = data.interrupted === true
      // A step that carried only tool calls prints nothing; its tool items do.
      if (text === '' && reasoning === '' && usage === undefined && !interrupted) return undefined
      return {
        k: 'assistant',
        turn,
        ...(text === '' ? {} : { text }),
        ...(reasoning === '' ? {} : { reasoning }),
        ...(usage === undefined ? {} : { usage }),
        ...(interrupted ? { interrupted } : {}),
      }
    }
    case 'tool/call': {
      const { callId, name, turn } = data
      if (!isCount(turn)) return undefined
      if (callId === undefined || callId === '' || name === undefined || name === '') return undefined
      // An identifier over its cap is dropped rather than cut: the result side
      // looks its call up by this exact string, so a truncated id would print a
      // tool header that could never pair with its own result.
      if (!fits(callId, MAX_ITEM_CALL_ID) || !fits(name, MAX_ITEM_NAME)) return undefined
      const args = head(data.arguments ?? '', MAX_ITEM_ARGS)
      remember(calls, callId, { time: event.time, name, args })
      return { k: 'tool', callId, name, args, state: 'start', turn }
    }
    case 'tool/result': {
      const { turn } = data
      const callId = data.message?.toolCallId
      if (!isCount(turn)) return undefined
      if (callId === undefined || callId === '' || !fits(callId, MAX_ITEM_CALL_ID)) return undefined
      const record = calls.get(callId)
      calls.delete(callId)
      // The call's name and arguments exist only in its own event, so a result
      // whose call this bridge never saw (older than the bound, or before the
      // attach) has nothing honest to print.
      if (record === undefined) return undefined
      const blocks = data.message?.content ?? []
      const last = blocks.filter(block => block.type === 'text' && (block.text ?? '').trim() !== '').at(-1)?.text
      // A result can carry its failure in `error` without the message flag, so
      // one flag drives both the detail fallback and the printed state.
      const failed = data.message?.isError === true || data.error !== undefined
      const detail = tail(last ?? data.error?.reason ?? '', MAX_ITEM_DETAIL)
      // Both stamps come from the host: a missing one leaves the duration
      // unknown, never a wall-clock guess.
      const ms = isCount(event.time) && isCount(record.time) ? Math.max(0, event.time - record.time) : undefined
      return {
        k: 'tool',
        callId,
        name: record.name,
        args: record.args,
        state: failed ? 'error' : 'ok',
        ...(detail === '' ? {} : { detail }),
        ...(ms === undefined ? {} : { ms }),
        turn,
      }
    }
    default:
      return undefined
  }
}

/**
 * The frame to send for one item, or `undefined` when the encoded frame would
 * not fit the wire. `encodeFrame` refuses an oversized frame by closing the
 * socket, and a transcript line must never cost the supervisor its attach, so
 * the drop happens here instead. The per-field caps already keep every real
 * item well inside the limit; this is the guarantee that does not depend on them.
 */
export function mirrorFrame(item: MirrorItem): { readonly t: 'mirror'; readonly item: MirrorItem } | undefined {
  const frame = { t: 'mirror', item } as const
  return Buffer.byteLength(JSON.stringify(frame), 'utf8') < MAX_FRAME ? frame : undefined
}

/** Record one started call, dropping the oldest entry when the table is full. */
function remember(calls: Map<string, CallRecord>, callId: string, record: CallRecord): void {
  calls.delete(callId)
  if (calls.size >= MAX_CALLS) {
    const oldest = calls.keys().next()
    if (!oldest.done) calls.delete(oldest.value)
  }
  calls.set(callId, record)
}

/** The blocks of one kind, joined in order. */
function blockText(blocks: readonly ContentBlock[] | undefined, kind: 'text' | 'reasoning'): string {
  const parts: string[] = []
  for (const block of blocks ?? []) {
    if (block.type === kind && block.text !== undefined) parts.push(block.text)
  }
  return parts.join('\n')
}

/** The counts the protocol accepts, or undefined when the host reported none. */
function usageOf(usage: EventUsage | undefined): NonNullable<Extract<MirrorItem, { k: 'assistant' }>['usage']> | undefined {
  const inputTokens = usage?.inputTokens
  const outputTokens = usage?.outputTokens
  // The forwarder stops the stream on a number it rejects, and the host payload
  // is untrusted, so only counts the wire accepts are ever emitted.
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined
  const cacheReadTokens = usage?.cacheReadTokens
  return isCount(cacheReadTokens) ? { inputTokens, outputTokens, cacheReadTokens } : { inputTokens, outputTokens }
}

/** True when `text` already fits a wire cap, so an identifier needs no cut. */
function fits(text: string, limit: number): boolean {
  let bytes = 0
  for (const char of text) {
    bytes += wireWidth(char)
    if (bytes > limit) return false
  }
  return true
}

/**
 * The bytes one code point costs inside a JSON string literal. JSON escapes a
 * quote, a backslash, every C0 control and a lone surrogate, so a raw UTF-8
 * count understates the wire — which is exactly how a `.length` cap let a
 * control flood encode to ~98 KB.
 */
function wireWidth(char: string): number {
  const code = char.charCodeAt(0)
  if (code >= 0x20 && code !== 0x22 && code !== 0x5c) {
    // A lone surrogate is escaped as `\udXXX`; a paired one is one code point,
    // and its UTF-8 width is what the wire carries.
    const lone = char.length === 1 && code >= 0xd800 && code <= 0xdfff
    return lone ? 6 : Buffer.byteLength(char, 'utf8')
  }
  const short = code === 0x22 || code === 0x5c || (code >= 0x08 && code <= 0x0d && code !== 0x0b)
  return short ? 2 : 6
}

/** Proves a host number is one the protocol's `isCount` will accept back. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Truncate to `limit` wire bytes, keeping the head; a cap is a cap, never a marker. */
function head(text: string, limit: number): string {
  return fit(text, limit, 'head')
}

/** Truncate to `limit` wire bytes, keeping the tail: an error's reason is at the end. */
function tail(text: string, limit: number): string {
  return fit(text, limit, 'tail')
}

/**
 * The part of `text` within `limit` wire bytes, from its head or its tail. The
 * wire is what counts — JSON escaping and multibyte text both grow there — so a
 * control flood is cut far sooner than its `.length` suggests. A surrogate pair
 * is never split, so no half character is ever emitted.
 */
function fit(text: string, limit: number, from: 'head' | 'tail'): string {
  if (from === 'head') {
    let bytes = 0
    let end = 0
    for (const char of text) {
      bytes += wireWidth(char)
      if (bytes > limit) return text.slice(0, end)
      end += char.length
    }
    return text
  }
  let bytes = 0
  let start = text.length
  while (start > 0) {
    // Step over a whole pair, never half of one.
    const low = text.charCodeAt(start - 1)
    const high = start > 1 ? text.charCodeAt(start - 2) : 0
    const size = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? 2 : 1
    bytes += wireWidth(text.slice(start - size, start))
    if (bytes > limit) return text.slice(start)
    start -= size
  }
  return text
}
