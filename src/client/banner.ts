/**
 * The supervision state payload's pure half: wire validation only. The
 * browser decoration reads ids out of it; the guard's copy is localized in
 * `locale.ts`. No fetch, no React, no clock.
 */

/** One bridged session as the state route reports it. */
export interface BridgeEntry {
  readonly bridged: true
  readonly terminal: string
  readonly pid: number
  readonly since: number
  readonly asks: readonly string[]
}

/** The `/dsh-supervision/state` payload. */
export interface SupervisionState {
  readonly proto: number
  readonly sessions: Readonly<Record<string, BridgeEntry>>
}

/** @returns whether `value` is one readable session entry. */
function isEntry(value: unknown): value is BridgeEntry {
  if (typeof value !== 'object' || value === null) return false
  const bridged: unknown = Reflect.get(value, 'bridged')
  const terminal: unknown = Reflect.get(value, 'terminal')
  const pid: unknown = Reflect.get(value, 'pid')
  const since: unknown = Reflect.get(value, 'since')
  const asks: unknown = Reflect.get(value, 'asks')
  return bridged === true
    && typeof terminal === 'string'
    && typeof pid === 'number'
    && typeof since === 'number'
    && Array.isArray(asks)
    && asks.every(ask => typeof ask === 'string')
}

/**
 * Validate a state response at the wire. A differing `proto` is a payload this
 * client cannot read, so it is not a bridge payload: the decoration stays off.
 * @param value - `JSON.parse` output.
 * @returns whether the value is a payload this client understands.
 */
export function isBridgePayload(value: unknown): value is SupervisionState {
  if (typeof value !== 'object' || value === null) return false
  if (Reflect.get(value, 'proto') !== 1) return false
  const sessions: unknown = Reflect.get(value, 'sessions')
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return false
  return Object.values(sessions).every(isEntry)
}
