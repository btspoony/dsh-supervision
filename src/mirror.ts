/**
 * Session events as transcript items: the pure mapping from the host's event
 * union to the one human-facing frame, plus the bounded call table whose
 * timing a tool result needs. No socket, clock, or process state here.
 */

import { MAX_ITEM_ARGS, MAX_ITEM_DETAIL, MAX_ITEM_REASONING, MAX_ITEM_TEXT } from 'dsh-supervision-protocol'
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
      // A step with no turn cannot be placed in the transcript; inventing one
      // would report a turn the event never claimed.
      if (turn === undefined) return undefined
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
      if (turn === undefined) return undefined
      if (callId === undefined || callId === '' || name === undefined || name === '') return undefined
      const args = head(data.arguments ?? '', MAX_ITEM_ARGS)
      remember(calls, callId, { time: event.time, name, args })
      return { k: 'tool', callId, name, args, state: 'start', turn }
    }
    case 'tool/result': {
      const { turn } = data
      const callId = data.message?.toolCallId
      if (turn === undefined) return undefined
      if (callId === undefined || callId === '') return undefined
      const record = calls.get(callId)
      calls.delete(callId)
      // The call's name and arguments exist only in its own event, so a result
      // whose call this bridge never saw (older than the bound, or before the
      // attach) has nothing honest to print.
      if (record === undefined) return undefined
      const blocks = data.message?.content ?? []
      const last = blocks.filter(block => block.type === 'text' && (block.text ?? '').trim() !== '').at(-1)?.text
      const detail = tail(last ?? data.error?.reason ?? '', MAX_ITEM_DETAIL)
      // Both stamps come from the host: a missing one leaves the duration
      // unknown, never a wall-clock guess.
      const ms = event.time === undefined || record.time === undefined ? undefined : Math.max(0, event.time - record.time)
      return {
        k: 'tool',
        callId,
        name: record.name,
        args: record.args,
        state: data.message?.isError === true ? 'error' : 'ok',
        ...(detail === '' ? {} : { detail }),
        ...(ms === undefined ? {} : { ms }),
        turn,
      }
    }
    default:
      return undefined
  }
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
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined
  const cacheReadTokens = usage?.cacheReadTokens
  return typeof cacheReadTokens === 'number'
    ? { inputTokens, outputTokens, cacheReadTokens }
    : { inputTokens, outputTokens }
}

/** Truncate to `limit`, keeping the head; a cap is a cap, never a marker. */
function head(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text
}

/** Truncate to `limit`, keeping the tail: an error's reason is at the end. */
function tail(text: string, limit: number): string {
  return text.length > limit ? text.slice(-limit) : text
}
