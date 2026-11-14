/**
 * The supervision decoration's strings, inlined into the client bundle. `en`
 * doubles as the fallback when the host has no locale service; `zh` ships
 * beside it and both are registered under the `supervision` namespace.
 */

/** The English strings; also the no-locale-service fallback rendering. */
export const en = {
  /** The one-line caption in the guard's bottom band. */
  caption: 'This chat is supervised from elsewhere — the input box is locked.',
  /** The corner badge fused into the overlay's bottom-left. */
  badge: 'Bridged',
  /** The single reclaim control. */
  unlock: 'Unlock',
} as const

/** The Chinese translations of {@link en}. */
export const zh = {
  caption: '此会话已被接管，输入框已锁定。',
  badge: '已接管',
  unlock: '解锁',
} as const

/** The translator handed down from the locale service (or the fallback). */
export type Translate = (key: string) => string
