/**
 * The browser-side bridge decoration: a supervised session gets a heavy outline
 * and a whale-tail badge in the sidebar, and its composer is covered until the
 * operator takes control back.
 *
 * The pure half (`rowSessionId`, `bridgedIds`, `guardFor`) is here so the
 * decisions stay testable without a DOM; the small imperative half only writes
 * attributes and one node, and it is idempotent — the poll calls it every tick.
 */

import { isBridgePayload } from './banner.js'
import type { SupervisionState } from './banner.js'

/** A sidebar row carries its session in `data-row-key="session:<id>"`. */
export const ROW_KEY = 'session:'
/** The attribute the stylesheet keys on. */
export const BRIDGED_ATTR = 'data-dsh-sup-bridged'
/** The composer guard node id. */
export const GUARD_ID = 'dsh-sup-guard'
/** Marks a composer container as relatively positioned by this module. */
const HOST_ATTR = 'data-dsh-sup-composer'

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

/**
 * Whether the composer must be covered for one session.
 * @param ids - the bridged sessions.
 * @param session - the session the composer currently belongs to.
 * @returns true when this session is supervised from elsewhere.
 */
export function guardFor(ids: ReadonlySet<string>, session: string | undefined): boolean {
  return session !== undefined && ids.has(session)
}

/** The whale-tail badge: the same silhouette the thinking state draws. */
const TAIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8fb0ff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19c1.8-1.2 3-3.3 3.4-6.1.1-.8.7-1.2 1.4-.8.6.4 1.1 1 1.6 1.8.9-2.9 2.6-4.8 4.9-5.9-.3 2.5.2 4.6 1.5 6.4 1.6 2.2 3.6 3 6.2 3-1.1 2.4-3 3.9-5.6 4.4-3.6.7-7-.2-10.2-2.6"/></svg>`

/** The one stylesheet this module installs, keyed by {@link BRIDGED_ATTR}. */
const STYLE = `
[${BRIDGED_ATTR}] {
  position: relative;
  padding-right: 20px !important;
  border-radius: 10px;
  box-shadow: inset 0 0 0 2px #7aa2ff, 0 0 0 1px rgba(122, 162, 255, 0.25), 0 0 14px rgba(122, 162, 255, 0.18);
}
[${BRIDGED_ATTR}]::after {
  content: '';
  position: absolute;
  top: 50%;
  right: 4px;
  width: 12px;
  height: 12px;
  transform: translateY(-50%);
  background: no-repeat center / contain url("data:image/svg+xml,${encodeURIComponent(TAIL_SVG)}");
  opacity: 0.95;
}
#${GUARD_ID} {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 0.75rem;
  border-radius: 12px;
  background: rgba(9, 12, 20, 0.78);
  backdrop-filter: blur(3px);
  color: #dbe4ff;
  font-size: 0.8125rem;
}
#${GUARD_ID} button {
  font: inherit;
  cursor: pointer;
  padding: 0.25rem 0.75rem;
  border-radius: 999px;
  border: 1px solid #7aa2ff;
  background: rgba(122, 162, 255, 0.16);
  color: #e6edff;
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

/** The state route; absent on a `dsh web` without this plugin. */
const STATE_URL = '/dsh-supervision/state'
/** The one action the guard offers. */
const RECLAIM_URL = '/dsh-supervision/reclaim'
/** The poll period: a bridge changes state a few times a day. */
const POLL_MS = 2000

/**
 * Take one session back from its supervisor.
 * @param session - the bridged session.
 */
async function reclaim(session: string): Promise<void> {
  try {
    await fetch(RECLAIM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session }),
    })
    // 409 is the bridge already gone, which is the outcome asked for; any other
    // answer leaves the guard to the next poll.
  } catch {
    // A dropped fetch leaves the guard up: the bridge is still there.
  }
}

/**
 * Poll the supervision state and keep the decoration in step.
 * @param doc - the page document.
 * @param draw - the paint callback, injectable for a test.
 * @returns a stop function; the page normally outlives it.
 */
export function watch(doc: Document, draw: typeof paint = paint): () => void {
  let stopped = false
  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const response = await fetch(STATE_URL)
      if (!response.ok) {
        draw(doc, new Set(), reclaim)
        return
      }
      const payload: unknown = await response.json()
      draw(doc, bridgedIds(isBridgePayload(payload) ? payload : undefined), reclaim)
    } catch {
      // An absent route (plain `dsh web`) or a dropped fetch means "not bridged".
      draw(doc, new Set(), reclaim)
    }
  }
  void tick()
  const timer = setInterval(() => { void tick() }, POLL_MS)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/**
 * Paint every session row with its bridge state, and keep one composer guard in
 * step with the selected session.
 * @param doc - the page document.
 * @param ids - the bridged sessions from the latest poll.
 * @param reclaim - takes one session back; the guard's button calls it.
 */
export function paint(doc: Document, ids: ReadonlySet<string>, reclaim: (session: string) => Promise<void>): void {
  installStyle(doc)
  let selected: string | undefined
  for (const row of doc.querySelectorAll('[data-row-key]')) {
    const session = rowSessionId(row.getAttribute('data-row-key'))
    if (session === undefined) continue
    if (row.getAttribute('aria-selected') === 'true') selected = session
    if (ids.has(session)) row.setAttribute(BRIDGED_ATTR, '')
    else row.removeAttribute(BRIDGED_ATTR)
  }
  syncGuard(doc, selected, ids, reclaim)
}

/**
 * Add, update or remove the composer guard for the selected session.
 * @param doc - the page document.
 * @param selected - the session the composer belongs to.
 * @param ids - the bridged sessions.
 * @param reclaim - the unlock action.
 */
function syncGuard(doc: Document, selected: string | undefined, ids: ReadonlySet<string>, reclaim: (session: string) => Promise<void>): void {
  const existing = doc.getElementById(GUARD_ID)
  const wanted = guardFor(ids, selected)
  if (!wanted) {
    existing?.remove()
    return
  }
  const composer = doc.querySelector('[contenteditable="true"]')
  const host = composer?.parentElement
  if (host === null || host === undefined) {
    existing?.remove()
    return
  }
  if (existing !== null && existing.parentElement === host) return
  existing?.remove()
  // The guard overlays the composer's own box, so that box must be a containing
  // block; the original inline value is restored when the guard is removed.
  if (host.getAttribute(HOST_ATTR) !== '') {
    host.setAttribute(HOST_ATTR, '')
    host.style.position = 'relative'
  }
  const guard = doc.createElement('div')
  guard.id = GUARD_ID
  const label = doc.createElement('span')
  label.textContent = 'Supervised from dsh-sup — this composer is locked.'
  const button = doc.createElement('button')
  button.type = 'button'
  button.textContent = 'Unlock'
  button.addEventListener('click', () => { void reclaim(selected ?? '').then(() => { guard.remove() }) })
  guard.append(label, button)
  host.append(guard)
}
