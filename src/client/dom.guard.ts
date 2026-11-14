/**
 * The composer guard: while a session is supervised from a terminal its input
 * area — editor and toolbar — is covered and the editor is made `inert`, so
 * neither a pointer nor an already-focused caret can type into it. The guard
 * itself sits beside the editor, because an `inert` subtree cannot host the
 * button that takes the session back.
 *
 * Both mechanisms are re-asserted on every paint: the host may swap the editor
 * node while keeping its container, and a guard that trusted its own earlier
 * DOM writes would then show "covered" over a typeable editor.
 */

import type { Translate } from './locale.js'

/** The composer guard node id. */
export const GUARD_ID = 'dsh-sup-guard'
/** The caption span's class; also keys the stylesheet. */
export const COPY_CLASS = 'dsh-sup-copy'
/** The corner badge's class; also keys the stylesheet. */
export const BADGE_CLASS = 'dsh-sup-badge'
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
 * Seat the guard's border on the holder's own rounding, so the cover hugs the
 * input card instead of guessing a token.
 * @param guard - the mounted guard.
 * @param holder - the container the guard overlays.
 */
function seatGuard(guard: HTMLElement, holder: HTMLElement): void {
  const radius = getComputedStyle(holder).borderRadius
  guard.style.borderRadius = radius === '' ? '16px' : radius
  // The bottom-left badge reads the same rounding, so its corner follows the
  // card instead of keeping a fixed radius that may not match.
  guard.style.setProperty('--dsh-sup-radius', radius === '' ? '16px' : radius)
}

/**
 * Re-assert the covered state on one editor and its container.
 * @param host - the editor's parent.
 * @param holder - the container the guard overlays.
 */
function cover(host: HTMLElement, holder: HTMLElement): void {
  host.setAttribute(HOST_ATTR, '')
  host.setAttribute('inert', '')
  if (!holder.hasAttribute(HOLDER_ATTR)) holder.setAttribute(HOLDER_ATTR, holder.style.position)
  if (holder.style.position !== 'relative') holder.style.position = 'relative'
}

/**
 * Remove the guard and put every editor and container back as it was.
 * @param doc - the page document.
 */
export function releaseGuard(doc: Document): void {
  // Every marked node, not the first: a host that replaced the editor can leave
  // the old node behind, and a leftover `inert` would freeze typing for good.
  for (const host of doc.querySelectorAll<HTMLElement>(`[${HOST_ATTR}]`)) {
    host.removeAttribute(HOST_ATTR)
    host.removeAttribute('inert')
  }
  for (const holder of doc.querySelectorAll<HTMLElement>(`[${HOLDER_ATTR}]`)) {
    holder.style.position = holder.getAttribute(HOLDER_ATTR) ?? ''
    holder.removeAttribute(HOLDER_ATTR)
  }
  guardNode(doc)?.remove()
}

/**
 * Keep exactly one guard in step with the selected session.
 * @param doc - the page document.
 * @param selected - the session the composer belongs to.
 * @param ids - the bridged sessions.
 * @param t - the translator for the guard's strings.
 * @param reclaim - takes one session back; resolves true when the bridge is gone.
 */
export function syncGuard(
  doc: Document,
  selected: string | undefined,
  ids: ReadonlySet<string>,
  t: Translate,
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
  // The whole input area (editor + toolbar) is the host's composer card; when
  // present it is the holder, so the cover spans both like the host's own
  // overlay slot would. The holder must be a strict ancestor of `host`: an
  // `inert` subtree cannot host the guard's button, so a card that IS the
  // editor's own parent would leave the only reclaim control dead.
  const card = (composer?.closest('[data-composer-card]') ?? null) as HTMLElement | null
  const candidate = card ?? host.parentElement ?? null
  const holder = candidate !== null && candidate !== host && candidate.contains(host) ? candidate : null
  if (holder === null) {
    releaseGuard(doc)
    return
  }
  const existing = guardNode(doc)
  if (existing !== null && existing.parentElement === holder) {
    // The guard outlives a session switch in the same composer: retarget it, so
    // Unlock never reclaims the session selected before this one, and re-assert
    // the covered state in case the host swapped the editor under the guard.
    // The strings are re-read too, so a locale change lands on the next poll.
    existing.setAttribute(SESSION_ATTR, selected ?? '')
    existing.querySelector(':scope > span.' + COPY_CLASS)?.replaceChildren(doc.createTextNode(t('caption')))
    existing.querySelector(':scope > span.' + BADGE_CLASS)?.replaceChildren(doc.createTextNode(t('badge')))
    existing.querySelector(':scope > button')?.replaceChildren(doc.createTextNode(t('unlock')))
    cover(host, holder)
    seatGuard(existing, holder)
    return
  }
  releaseGuard(doc)
  cover(host, holder)
  const guard = doc.createElement('div')
  guard.id = GUARD_ID
  guard.setAttribute(SESSION_ATTR, selected ?? '')
  const copy = doc.createElement('span')
  copy.className = COPY_CLASS
  copy.textContent = t('caption')
  const badge = doc.createElement('span')
  badge.className = BADGE_CLASS
  badge.textContent = t('badge')
  const button = doc.createElement('button')
  button.type = 'button'
  button.textContent = t('unlock')
  button.addEventListener('click', () => {
    const target = guard.getAttribute(SESSION_ATTR) ?? ''
    void reclaim(target).then(taken => {
      // A refused reclaim leaves the guard up: the bridge is still there.
      if (taken) releaseGuard(doc)
    })
  })
  guard.append(copy, badge, button)
  seatGuard(guard, holder)
  holder.append(guard)
}
