/**
 * Browser half of the plugin: the supervision decoration. Bridged sidebar rows
 * wear the ring and whale-tail capsule, and the composer card is covered with
 * the localized notice and the single way back until the operator reclaims
 * the session. There is no separate banner: the notice lives on the overlay.
 */

import { watch } from './dom.js'
import { en, zh } from './locale.js'
import type { Translate } from './locale.js'

/** The locale service face this plugin uses. */
interface LocaleFace {
  /** Install the plugin's dictionaries; returns the unregister function. */
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  /** Bind a translator for one namespace to the active locale. */
  bind(namespace: string): Translate
}

/** The client context, reduced to the faces this plugin touches. */
export interface ClientContext {
  /** Direct member, when the host wires one. */
  readonly locale?: LocaleFace
  /** Reflective service lookup; the repo convention for optional services. */
  readonly get?: (name: string) => unknown
  /**
   * Host effect scope: runs the callback, tracks its cleanup, and disposes it
   * with the entry. Absent on hosts without the scope service.
   */
  readonly effect?: (run: () => () => void, label: string) => void
}

export const name = 'dsh-supervision'
/**
 * No required services: the locale face is read reflectively (`ctx.get`), so a
 * host without it still loads the decoration in English.
 */
export const inject: string[] = []

/**
 * Start the decoration: register the strings, then poll and paint.
 * @param ctx - the client root context; every member may be absent.
 */
export function apply(ctx?: ClientContext): void {
  if (typeof document === 'undefined') return
  // Optional host service, read reflectively like the server half reads its
  // webserver: a declared dependency would keep this plugin from loading on
  // hosts that mount no locale service at all.
  const locale = (ctx?.get?.('locale') ?? ctx?.locale) as LocaleFace | undefined
  let t: Translate
  if (locale !== undefined) {
    const register = (): (() => void) => locale.register('supervision', { en, zh })
    // Official plugins own registration through the host effect scope, so a
    // hot re-apply cannot double-register the namespace.
    if (ctx?.effect !== undefined) ctx.effect(register, 'dsh-supervision: locale')
    else register()
    t = locale.bind('supervision')
  } else {
    // No locale service: the English dictionary is the fallback rendering.
    t = (key) => en[key as keyof typeof en] ?? key
  }
  // Own the watcher like the registration: a hot re-apply must not leak a
  // second interval that keeps polling after unload.
  if (ctx?.effect !== undefined) ctx.effect(() => watch(document, t), 'dsh-supervision: watch')
  else watch(document, t)
}
