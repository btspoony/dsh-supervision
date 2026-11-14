/**
 * The browser-side bridge decoration: a supervised session gets a heavy outline
 * and a whale-tail capsule in the sidebar, and its input area is covered until
 * the operator takes control back.
 *
 * The pure half (`rowSessionId`, `bridgedIds`) is here so the decisions stay
 * testable without a DOM; the imperative half only writes attributes and one
 * node, and it is idempotent — the poll calls it every tick.
 */

import { isBridgePayload } from './banner.js'
import type { SupervisionState } from './banner.js'
import { GUARD_ID, syncGuard } from './dom.guard.js'
import type { Translate } from './locale.js'

/** A sidebar row carries its session in `data-row-key="session:<id>"`. */
export const ROW_KEY = 'session:'
/** The attribute the stylesheet keys on. */
export const BRIDGED_ATTR = 'data-dsh-sup-bridged'
/** The state route; absent on a `dsh web` without this plugin. */
const STATE_URL = '/dsh-supervision/state'
/** The one action the guard offers. */
const RECLAIM_URL = '/dsh-supervision/reclaim'
/** The poll period: a bridge changes state a few times a day. */
const POLL_MS = 2000

/**
 * Read the session id out of one sidebar row key.
 * @param key - the row's `data-row-key`, or null when absent.
 * @returns the session id, or undefined for a workspace row or an empty key.
 */
export function rowSessionId(key: string | null): string | undefined {
  if (key === null || !key.startsWith(ROW_KEY)) return undefined
  const id = key.slice(ROW_KEY.length)
  return id === '' ? undefined : id
}

/**
 * @param state - the last polled supervision payload.
 * @returns every bridged session id; empty when nothing answered.
 */
export function bridgedIds(state: SupervisionState | undefined): ReadonlySet<string> {
  return new Set(state === undefined ? [] : Object.keys(state.sessions))
}

/** The whale-tail silhouette the host thinking state draws (16x16 viewBox). */
const TAIL_REST_PATH = 'M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742'
/** A stroked copy of the contour: the mask cutout and the still badge. */
const tailSvg = (color: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="${TAIL_REST_PATH}"/></svg>`
// shortcut: host asset hash, breaks when dsh-client-ui-chat renames the running-whale APNG; re-verify the /plugins/... URL then.
const WHALE_APNG_URL = '/plugins/@deepseek-ai/dsh-client-ui-chat/assets/running-whale%402x-06738fa29b2f.png'

/**
 * The one stylesheet this module installs, keyed by {@link BRIDGED_ATTR}.
 * Exported pure so the visual contract stays testable without a DOM.
 *
 * The tails animate like the host's thinking state: the running-whale APNG is
 * the mask, and its frames own the wag. The stroked SVG is the still fallback
 * for reduced-motion and unsupported `mask`.
 */
export const STYLE = `
[${BRIDGED_ATTR}] {
  position: relative;
  padding-right: 40px !important;
  border-radius: var(--dsw-radius-md, 12px) !important;
  border-color: #3b6cf5 !important;
  border-block: 3px solid #3b6cf5 !important;
  background-color: rgba(127, 174, 255, 0.30) !important;
}
[${BRIDGED_ATTR}]::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 40px;
  border-radius: 0 calc(var(--dsw-radius-md, 12px) - 3px) calc(var(--dsw-radius-md, 12px) - 3px) 0;
  background: #3b6cf5;
  z-index: 0;
  pointer-events: none;
}
[${BRIDGED_ATTR}]::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 40px;
  background: #fff;
  z-index: 1;
  pointer-events: none;
  -webkit-mask: url("data:image/svg+xml,${encodeURIComponent(tailSvg('#fff'))}") no-repeat center / 18px 18px;
  mask: url("data:image/svg+xml,${encodeURIComponent(tailSvg('#fff'))}") no-repeat center / 18px 18px;
}
#${GUARD_ID} {
  position: absolute;
  inset: 0;
  z-index: 40;
  padding: 24px;
  border: 3px solid #3b6cf5;
  background: rgba(127, 174, 255, 0.30);
  color: #fff;
  font-size: 0.8125rem;
}
#${GUARD_ID} > .dsh-sup-copy {
  position: absolute;
  left: 50%;
  top: 1px;
  transform: translate(-50%, -100%);
  background: #3b6cf5;
  color: #fff;
  border-radius: 8px 8px 0 0;
  padding: 3px 12px;
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  z-index: 2;
}
#${GUARD_ID} > .dsh-sup-badge {
  position: absolute;
  left: 0;
  bottom: 0;
  padding: 3px 10px 3px 24px;
  background: #3b6cf5;
  color: #fff;
  font-size: 11px;
  font-weight: 500;
  line-height: 14px;
  border-radius: 0 8px 0 8px;
  z-index: 1;
  pointer-events: none;
}
#${GUARD_ID} > .dsh-sup-badge::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 50%;
  translate: 0 -50%;
  width: 14px;
  height: 14px;
  background: #fff;
  -webkit-mask: url("data:image/svg+xml,${encodeURIComponent(tailSvg('#fff'))}") no-repeat center / contain;
  mask: url("data:image/svg+xml,${encodeURIComponent(tailSvg('#fff'))}") no-repeat center / contain;
}
#${GUARD_ID} button {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 1;
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
  min-height: 36px;
  padding: 0.375rem 1.5rem;
  border: none;
  border-radius: 999px;
  background: #3b6cf5;
  color: #fff;
  box-shadow: 0 1px 2px rgba(9, 22, 54, .25);
  transition: background-color .15s ease, box-shadow .15s ease, transform .15s ease;
}
#${GUARD_ID} button:hover {
  background: #5b86ff;
  transform: translate(-50%, calc(-50% - 1px));
  box-shadow: 0 3px 8px rgba(9, 22, 54, .35);
}
#${GUARD_ID} button:active {
  background: #3b6cf5;
  transform: translate(-50%, -50%);
  box-shadow: 0 1px 2px rgba(9, 22, 54, .25);
}
#${GUARD_ID} button:focus-visible {
  outline: 2px solid rgba(255, 255, 255, .75);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: no-preference) {
  @supports (mask-mode: alpha) {
    [${BRIDGED_ATTR}]::before {
      -webkit-mask: url("${WHALE_APNG_URL}") no-repeat center / 18px 18px;
      mask: url("${WHALE_APNG_URL}") no-repeat center / 18px 18px;
    }
    #${GUARD_ID} > .dsh-sup-badge::before {
      -webkit-mask: url("${WHALE_APNG_URL}") no-repeat center / contain;
      mask: url("${WHALE_APNG_URL}") no-repeat center / contain;
    }
  }
}
`
let styleInstalled = false

/**
 * Install the stylesheet once per document.
 * @param doc - the page document.
 */
function installStyle(doc: Document): void {
  if (styleInstalled || doc.getElementById('dsh-sup-style') !== null) {
    styleInstalled = true
    return
  }
  const style = doc.createElement('style')
  style.id = 'dsh-sup-style'
  style.textContent = STYLE
  doc.head.append(style)
  styleInstalled = true
}

/**
 * Take one session back from its supervisor.
 * @param session - the bridged session.
 * @returns whether the bridge is gone (an already-reclaimed 409 counts).
 */
export async function reclaim(session: string): Promise<boolean> {
  try {
    const response = await fetch(RECLAIM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session }),
    })
    return response.ok || response.status === 409
  } catch {
    // A dropped fetch leaves the guard up: the bridge is still there.
    return false
  }
}

/**
 * Coalesce a burst of signals into at most one run per window. Extracted pure
 * of the DOM so the throttling contract stays unit-testable.
 * @param run - the work to run at most once per window.
 * @param windowMs - the quiet period that separates two runs.
 * @returns the schedule and cancel handles.
 */
export function coalescer(run: () => void, windowMs: number): { schedule(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    schedule(): void {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        run()
      }, windowMs)
    },
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

/**
 * Poll the supervision state and keep the decoration in step. The 2s poll is
 * the freshness source, but selection changes and DOM churn also repaint from
 * the cached state, so opening a supervised session shows the overlay at once
 * instead of up to two seconds late.
 * @param doc - the page document.
 * @param t - the translator for the guard's strings.
 * @param draw - the paint callback, injectable for a test.
 * @returns a stop function; the page normally outlives it.
 */
export function watch(doc: Document, t: Translate, draw: typeof paint = paint): () => void {
  let stopped = false
  let cache: SupervisionState | undefined
  const repaint = (): void => {
    if (!stopped) draw(doc, bridgedIds(cache), t, reclaim)
  }
  const churn = coalescer(repaint, 100)
  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const response = await fetch(STATE_URL)
      if (!response.ok) {
        cache = undefined
        repaint()
        return
      }
      const payload: unknown = await response.json()
      cache = isBridgePayload(payload) ? payload : undefined
      repaint()
    } catch {
      // An absent route (plain `dsh web`) or a dropped fetch means "not bridged".
      cache = undefined
      repaint()
    }
  }
  void tick()
  const timer = setInterval(() => { void tick() }, POLL_MS)
  // Selection changes are rare: repaint from the cache immediately.
  const selectionObserver = new MutationObserver(repaint)
  const churnObserver = new MutationObserver(() => { churn.schedule() })
  if (doc.body !== null) {
    selectionObserver.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['aria-selected'] })
    churnObserver.observe(doc.body, { subtree: true, childList: true })
  }
  // The click that opens a session schedules a paint even before the observers fire.
  const onClick = (): void => { churn.schedule() }
  doc.addEventListener('click', onClick, { capture: true })
  return () => {
    stopped = true
    clearInterval(timer)
    churn.cancel()
    selectionObserver.disconnect()
    churnObserver.disconnect()
    doc.removeEventListener('click', onClick, { capture: true })
  }
}

/**
 * Paint every session row with its bridge state, and keep one composer guard in
 * step with the selected session.
 * @param doc - the page document.
 * @param ids - the bridged sessions from the latest poll.
 * @param t - the translator for the guard's strings.
 * @param take - takes one session back; the guard's button calls it.
 */
export function paint(
  doc: Document,
  ids: ReadonlySet<string>,
  t: Translate,
  take: (session: string) => Promise<boolean>,
): void {
  installStyle(doc)
  let selected: string | undefined
  for (const row of doc.querySelectorAll('[data-row-key]')) {
    const session = rowSessionId(row.getAttribute('data-row-key'))
    if (session === undefined) continue
    if (row.getAttribute('aria-selected') === 'true') selected = session
    if (ids.has(session)) row.setAttribute(BRIDGED_ATTR, '')
    else row.removeAttribute(BRIDGED_ATTR)
  }
  syncGuard(doc, selected, ids, t, take)
}
