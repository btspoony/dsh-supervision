/**
 * Browser half of the plugin: one dock entry above the composer that shows who
 * is supervising this session and offers the way back.
 *
 * The entry is session-scoped, so the slot's inject face hands it the current
 * session id; everything else (polling, rendering) lives in `Banner.tsx`.
 */

import type { ReactElement } from 'react'
import { Banner } from './BannerView.js'

/** One slot registration, reduced to the calls this plugin makes. */
interface SlotRegistrar {
  inject(key: string, callback: () => () => void): () => void
  register<P>(entry: {
    readonly name: string
    readonly id: string
    readonly order: number
    readonly inject?: (sessionId: string) => P
  }, component: (props: P) => ReactElement | null): () => void
}

/** The client context, reduced to the one service this plugin reads. */
export interface ClientContext {
  readonly slots: SlotRegistrar
}

export const name = 'dsh-supervision'
/** The slot service is the only member used: the banner reads its facts over HTTP. */
export const inject = ['slots']

/**
 * Register the banner dock entry.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'supervision',
    order: 10,
    inject: (sessionId: string) => ({ sessionId }),
  }, Banner))
}
