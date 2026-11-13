/**
 * The composer guard: while a session is supervised from a terminal its editor
 * is covered and made `inert`, so neither a pointer nor an already-focused
 * caret can type into it. The guard itself sits beside the editor, because an
 * `inert` subtree cannot host the button that takes the session back.
 */

import type { SupervisionState } from './banner.js'

/** The composer guard node id. */
export const GUARD_ID = 'dsh-sup-guard'
/** Marks the editor this module made inert. */
export const HOST_ATTR = 'data-dsh-sup-composer'
/** Records the holder's original inline `position` while the guard is mounted. */
const HOLDER_ATTR = 'data-dsh-sup-holder'
/** The session the mounted guard belongs to; kept current on every paint. */
const SESSION_ATTR = 'data-dsh-sup-session'

/**
 * Whether the composer must be covered for one session.
 * @param ids - the bridged sessions.
 * @param session - the session the composer currently belongs to.
 * @returns true when this session is supervised from elsewhere.
 */
export function guardFor(ids: ReadonlySet<string>, session: string | undefined): boolean {
  return session !== undefined && ids.has(session)
}

/** @returns the mounted guard, when one is in the document. */
function guardNode(doc: Document): HTMLElement | null {
  return doc.getElementById(GUARD_ID)
}

/**
 * Remove the guard and put the editor back exactly as it was.
 * @param doc - the page document.
 */
export function releaseGuard(doc: Document): void {
  const host = doc.querySelector<HTMLElement>(`[${HOST_ATTR}]`)
  if (host !== null) {
    host.removeAttribute(HOST_ATTR)
    host.removeAttribute('inert')
    const holder = host.parentElement
    if (holder !== null && holder.hasAttribute(HOLDER_ATTR)) {
      holder.style.position = holder.getAttribute(HOLDER_ATTR) ?? ''
      holder.removeAttribute(HOLDER_ATTR)
    }
  }
  guardNode(doc)?.remove()
}

/**
 * Keep exactly one guard in step with the selected session.
 * @param doc - the page document.
 * @param selected - the session the composer belongs to.
 * @param ids - the bridged sessions.
 * @param reclaim - takes one session back; resolves true when the bridge is gone.
 */
export function syncGuard(
  doc: Document,
  selected: string | undefined,
  ids: ReadonlySet<string>,
  reclaim: (session: string) => Promise<boolean>,
): void {
  if (!guardFor(ids, selected)) {
    releaseGuard(doc)
    return
  }
  const composer = doc.querySelector<HTMLElement>('[contenteditable="true"]')
  const host = composer?.parentElement
  if (host === null || host === undefined) {
    releaseGuard(doc)
    return
  }
  const holder = host.parentElement ?? host
  const existing = guardNode(doc)
  if (existing !== null && existing.parentElement === holder) {
    // The guard outlives a session switch in the same composer: retarget it, so
    // Unlock never reclaims the session that was selected before this one.
    existing.setAttribute(SESSION_ATTR, selected ?? '')
    return
  }
  releaseGuard(doc)
  host.setAttribute(HOST_ATTR, '')
  host.setAttribute('inert', '')
  holder.setAttribute(HOLDER_ATTR, holder.style.position)
  holder.style.position = 'relative'
  const guard = doc.createElement('div')
  guard.id = GUARD_ID
  guard.setAttribute(SESSION_ATTR, selected ?? '')
  const label = doc.createElement('span')
  label.textContent = 'Supervised from dsh-sup — this composer is covered.'
  const button = doc.createElement('button')
  button.type = 'button'
  button.textContent = 'Unlock'
  button.addEventListener('click', () => {
    const target = guard.getAttribute(SESSION_ATTR) ?? ''
    void reclaim(target).then(taken => {
      // A refused reclaim leaves the guard up: the bridge is still there.
      if (taken) releaseGuard(doc)
    })
  })
  guard.append(label, button)
  holder.append(guard)
}
