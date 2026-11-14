/**
 * The control protocol both halves speak: NDJSON frames over a Unix socket, and
 * the frame codec that proves every field before it reaches a handler. The
 * plugin decodes inbound frames and encodes outbound ones; `dsh-sup` does the
 * reverse through {@link decodeChunk}. Keeping both directions here is what
 * makes one frame mean one thing.
 */

import { isProgramState, stripControls } from './osc.js'
import type { ProgramState } from './osc.js'

/** One frame, newline included, never larger than this. */
export const MAX_FRAME = 64 * 1024
/** The only protocol version either side speaks. */
export const PROTO = 2

// Caps a mirror frame's strings so one assistant block still encodes. Each is a
// UTF-8 byte budget, not a character count: JSON escaping and multibyte text
// both grow on the wire, so `.length` would not bound the frame. The codec never
// truncates — only a whole frame over `MAX_FRAME` throws — so staying under these
// is the caller's duty, and `MAX_FRAME` is the hard limit on the wire.
export const MAX_ITEM_TEXT = 16 * 1024
export const MAX_ITEM_REASONING = 1024
export const MAX_ITEM_ARGS = 512
export const MAX_ITEM_DETAIL = 2048
export const MAX_ITEM_NAME = 64
export const MAX_ITEM_CALL_ID = 96

export type ErrorCode =
  | 'busy'
  | 'unknown-session'
  | 'create-failed'
  | 'locked'
  | 'protocol'
  | 'internal'

const ERROR_CODES: readonly string[] = ['busy', 'unknown-session', 'create-failed', 'locked', 'protocol', 'internal']

export interface SessionItem {
  readonly id: string
  readonly cwd: string
  readonly live: boolean
  readonly bridged: boolean
}

export type HelloFrame =
  | { readonly t: 'hello'; readonly proto: number; readonly pid: number; readonly attach: string }
  | { readonly t: 'hello'; readonly proto: number; readonly pid: number; readonly new: { readonly cwd: string } }
  | { readonly t: 'hello'; readonly proto: number; readonly pid: number }

/** Everything the forwarder may write: the client half of the protocol. */
export type InFrame =
  | HelloFrame
  | { readonly t: 'line'; readonly text: string }
  | { readonly t: 'list'; readonly cwd?: string }
  | { readonly t: 'bye' }

export type Welcome = {
  readonly t: 'welcome'
  readonly proto: number
  readonly session: string
  readonly title: string
  readonly state: ProgramState
  readonly turn: number
}

/** Token counts as the host reports them on one finished assistant step. */
type MirrorUsage = { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens?: number }

/** One human-facing transcript item; the machine surface never reads it. */
export type MirrorItem =
  | { readonly k: 'user'; readonly text: string }
  | {
      readonly k: 'assistant'
      readonly text?: string
      readonly reasoning?: string
      readonly usage?: MirrorUsage
      readonly interrupted?: boolean
      readonly turn: number
    }
  | {
      readonly k: 'tool'
      readonly callId: string
      readonly name: string
      readonly args: string
      readonly state: 'start' | 'ok' | 'error'
      readonly detail?: string
      readonly ms?: number
      readonly turn: number
    }

/** Everything the plugin may write: the server half of the protocol. */
export type OutFrame =
  | Welcome
  | { readonly t: 'osc'; readonly data: string }
  | { readonly t: 'echo'; readonly text: string }
  | { readonly t: 'mirror'; readonly item: MirrorItem }
  | { readonly t: 'sessions'; readonly items: readonly SessionItem[] }
  | { readonly t: 'error'; readonly code: ErrorCode; readonly message: string }
  | { readonly t: 'bye'; readonly reason: string }

/** One validated stream slice, or the reason the stream desynchronised. */
export type Decoded =
  | { readonly ok: true; readonly frames: readonly OutFrame[]; readonly rest: string }
  | { readonly ok: false; readonly reason: string }

/** A frame was rejected before it could reach a peer. */
export class ProtocolError extends Error {
  readonly code: ErrorCode
  /** @param code - the protocol error the forwarder maps to an exit code. */
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
  }
}

/**
 * JSON object guard. `JSON.parse` output, a registry file and a frame payload
 * are all `unknown` until this narrows them.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.includes(value)
}

/**
 * Encode one frame for the wire, in either direction.
 * @param frame - the frame to send.
 * @returns the frame plus its newline.
 * @throws ProtocolError `protocol` when the frame exceeds {@link MAX_FRAME}.
 */
export function encodeFrame(frame: InFrame | OutFrame): string {
  const line = `${JSON.stringify(frame)}\n`
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) {
    throw new ProtocolError('protocol', `frame exceeds ${String(MAX_FRAME)} bytes`)
  }
  return line
}

/**
 * Decode one inbound line. Every field is proven here, so handlers never have
 * to re-check a shape that arrived over the socket. The version is deliberately
 * not proven: the transport names the offending `proto` in its refusal.
 * @param line - one line without its newline.
 * @returns the frame, or `undefined` when any field is missing or mistyped.
 */
export function decodeFrame(line: string): InFrame | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  switch (parsed['t']) {
    case 'hello': {
      const { proto, pid, attach, new: created } = parsed
      if (typeof proto !== 'number' || typeof pid !== 'number' || !Number.isSafeInteger(pid)) return undefined
      const head = { t: 'hello', proto, pid } as const
      // `attach` and `new` are exclusive; both at once is a malformed frame, not
      // a precedence puzzle. An empty session id or cwd is not a target either.
      if (attach !== undefined && created !== undefined) return undefined
      if (attach !== undefined) {
        return typeof attach === 'string' && attach !== '' ? { ...head, attach } : undefined
      }
      if (created === undefined) return head
      if (!isRecord(created)) return undefined
      const cwd = created['cwd']
      return typeof cwd === 'string' && cwd !== '' ? { ...head, new: { cwd } } : undefined
    }
    case 'line': {
      const text = parsed['text']
      return typeof text === 'string' ? { t: 'line', text } : undefined
    }
    case 'list': {
      const cwd = parsed['cwd']
      if (cwd === undefined) return { t: 'list' }
      return typeof cwd === 'string' ? { t: 'list', cwd } : undefined
    }
    case 'bye':
      return { t: 'bye' }
    default:
      return undefined
  }
}

/**
 * Split `chunk` onto the partial frame in `rest` and validate every complete
 * line. An unterminated frame over the cap or an invalid frame is a hard stop,
 * so a desynchronised stream never reaches the writer.
 * @param rest - the unterminated tail of the previous chunk.
 * @param chunk - the bytes just read.
 * @returns the frames that completed, the leftover tail, or the first fault.
 */
export function decodeChunk(rest: string, chunk: string): Decoded {
  const frames: OutFrame[] = []
  let buffer = rest + chunk
  for (;;) {
    const end = buffer.indexOf('\n')
    if (end === -1) break
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (line.length === 0) continue
    const frame = parseOutFrame(line)
    if (frame === undefined) {
      const shown = line.length > 60 ? `${line.slice(0, 60)}…` : line
      // The excerpt is peer bytes on their way to the operator's stderr, so it
      // is stripped like any other rendered text first.
      return { ok: false, reason: `invalid frame: ${stripControls(shown)}` }
    }
    frames.push(frame)
  }
  if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME) {
    return { ok: false, reason: `frame exceeds ${String(MAX_FRAME)} bytes` }
  }
  return { ok: true, frames, rest: buffer }
}

function parseOutFrame(line: string): OutFrame | undefined {
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  switch (parsed['t']) {
    case 'welcome': {
      const { proto, session, title, state, turn } = parsed
      if (proto !== PROTO) return undefined
      if (typeof session !== 'string' || session === '' || typeof title !== 'string') return undefined
      if (!isProgramState(state) || typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) return undefined
      return { t: 'welcome', proto, session, title, state, turn }
    }
    case 'osc': {
      const data = parsed['data']
      return typeof data === 'string' ? { t: 'osc', data } : undefined
    }
    case 'echo': {
      const text = parsed['text']
      return typeof text === 'string' ? { t: 'echo', text } : undefined
    }
    case 'sessions':
      return parseSessions(parsed['items'])
    case 'mirror':
      return parseMirror(parsed['item'])
    case 'error': {
      const code = parsed['code']
      const message = parsed['message']
      if (!isErrorCode(code) || typeof message !== 'string') return undefined
      return { t: 'error', code, message }
    }
    case 'bye': {
      const reason = parsed['reason']
      return typeof reason === 'string' ? { t: 'bye', reason } : undefined
    }
    default:
      return undefined
  }
}

/** A string field is either absent or a string; `undefined` means malformed. */
function optString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseUsage(value: unknown): MirrorUsage | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const { inputTokens, outputTokens, cacheReadTokens } = value
  if (!isCount(inputTokens) || !isCount(outputTokens)) return null
  if (cacheReadTokens === undefined) return { inputTokens, outputTokens }
  return isCount(cacheReadTokens) ? { inputTokens, outputTokens, cacheReadTokens } : null
}

function parseMirror(value: unknown): OutFrame | undefined {
  if (!isRecord(value)) return undefined
  const turn = value['turn']
  switch (value['k']) {
    case 'user': {
      const text = value['text']
      return typeof text === 'string' ? { t: 'mirror', item: { k: 'user', text } } : undefined
    }
    case 'assistant': {
      if (!isCount(turn)) return undefined
      const text = optString(value['text'])
      const reasoning = optString(value['reasoning'])
      const usage = parseUsage(value['usage'])
      const interrupted = value['interrupted']
      if (text === null || reasoning === null || usage === null) return undefined
      if (interrupted !== undefined && typeof interrupted !== 'boolean') return undefined
      const item: MirrorItem = {
        k: 'assistant',
        turn,
        ...(text === undefined ? {} : { text }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(usage === undefined ? {} : { usage }),
        ...(interrupted === undefined ? {} : { interrupted }),
      }
      return { t: 'mirror', item }
    }
    case 'tool': {
      const { callId, name, args, state } = value
      if (typeof callId !== 'string' || callId === '' || typeof name !== 'string' || name === '') return undefined
      if (typeof args !== 'string' || !isCount(turn)) return undefined
      if (state !== 'start' && state !== 'ok' && state !== 'error') return undefined
      const detail = optString(value['detail'])
      const ms = value['ms']
      if (detail === null) return undefined
      if (ms !== undefined && !isCount(ms)) return undefined
      const item: MirrorItem = {
        k: 'tool',
        callId,
        name,
        args,
        state,
        turn,
        ...(detail === undefined ? {} : { detail }),
        ...(ms === undefined ? {} : { ms }),
      }
      return { t: 'mirror', item }
    }
    default:
      return undefined
  }
}

function parseSessions(items: unknown): OutFrame | undefined {
  if (!Array.isArray(items)) return undefined
  const parsed: SessionItem[] = []
  for (const item of items) {
    if (!isRecord(item)) return undefined
    const { id, cwd, live, bridged } = item
    if (typeof id !== 'string' || id === '' || typeof cwd !== 'string') return undefined
    if (typeof live !== 'boolean' || typeof bridged !== 'boolean') return undefined
    parsed.push({ id, cwd, live, bridged })
  }
  return { t: 'sessions', items: parsed }
}
