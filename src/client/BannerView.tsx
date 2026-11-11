/**
 * The banner's visual half: poll the state route while mounted and render the
 * one sentence that says who holds this session, plus the way back.
 *
 * Every reading of the payload goes through `banner.ts`; this file owns only
 * effect lifetime, the fetch, and the button.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { bannerText, isBridgePayload, supervisedEntry } from './banner.js'
import type { SupervisionState } from './banner.js'

/** The state route; absent on a `dsh web` without this plugin. */
const STATE_URL = '/dsh-supervision/state'
/** The one action this plugin offers. */
const RECLAIM_URL = '/dsh-supervision/reclaim'
/** The poll period: the fact changes a few times a day, so a boolean is enough. */
const POLL_MS = 2000

export interface BannerProps {
  /** The session this dock entry belongs to, delivered by the slot's inject face. */
  readonly sessionId: string
}

/**
 * The supervision banner: nothing while the session is not bridged.
 * @param props - the session id from the dock's inject face.
 */
export function Banner({ sessionId }: BannerProps): ReactElement | null {
  const [state, setState] = useState<SupervisionState | undefined>(undefined)
  const [hidden, setHidden] = useState(false)
  /**
   * Bumped by a reclaim so a poll already in flight cannot resurrect the
   * banner: its answer predates the action.
   */
  const epoch = useRef(0)

  useEffect(() => {
    const abort = new AbortController()
    const poll = async (): Promise<void> => {
      const at = epoch.current
      try {
        const response = await fetch(STATE_URL, { signal: abort.signal })
        if (!response.ok) {
          if (at === epoch.current) setState(undefined)
          return
        }
        const payload: unknown = await response.json()
        if (at !== epoch.current) return
        // A shape this client cannot read is "not supervised", never an error.
        setState(isBridgePayload(payload) ? payload : undefined)
        setHidden(false)
      } catch {
        // An absent route (plain `dsh web`) or a dropped fetch is the same fact.
        if (at === epoch.current) setState(undefined)
      }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, POLL_MS)
    return () => {
      abort.abort()
      clearInterval(timer)
    }
  }, [])

  const entry = hidden ? undefined : supervisedEntry(state, sessionId)
  if (entry === undefined) return null

  const reclaim = async (): Promise<void> => {
    try {
      const response = await fetch(RECLAIM_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: sessionId }),
      })
      // 409 is the bridge already gone, which is the outcome asked for.
      if (!response.ok && response.status !== 409) return
      epoch.current += 1
      setHidden(true)
    } catch {
      // Leave the banner up: the next poll shows the bridge is still there.
    }
  }

  return (
    <section
      aria-label="Supervision"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.25rem 0.75rem',
        fontSize: '0.8125rem',
        color: 'inherit',
        opacity: 0.85,
      }}
    >
      <span>{bannerText(entry)}</span>
      <button type="button" onClick={() => { void reclaim() }} style={{ font: 'inherit', cursor: 'pointer' }}>
        Take back control
      </button>
    </section>
  )
}
