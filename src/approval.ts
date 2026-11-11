/**
 * The parked-ask queue: an approval question that reached a supervisor stays
 * here until someone answers it, so this module owns the one truth about which
 * asks are open. Apart from the outcome promise each ask holds, nothing here
 * touches the host, a socket or a clock.
 */

import { randomBytes } from 'node:crypto'

/**
 * The closed approval outcomes DSH speaks
 * (`packages/interaction/user-approval/src/types.ts:36`).
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Who ended a parked ask: the supervisor's command, or the asker withdrawing itself. */
export type DecisionSource = 'supervisor' | 'attached'

/** The slice of DSH's `ApprovalRequestEvent` that a parked ask keeps. */
export interface ApprovalAsk {
  readonly toolName: string
  readonly reason?: string
}

/** One parked ask, as the supervisor names it. */
export interface ParkedAsk {
  /** Six hex characters, unique among the asks parked right now. */
  readonly id: string
  readonly toolName: string
  /** The asker's reason; `''` when it gave none. */
  readonly reason: string
  /** The bridged root session whose tree raised the ask. */
  readonly session: string
}

/** One settled ask, which is exactly what the audit echo reports. */
export interface AskDecision {
  readonly ask: ParkedAsk
  readonly outcome: ApprovalOutcome
  readonly source: DecisionSource
}

/** A parked ask, its promise, and the resolver that promise hangs on. */
interface OpenAsk {
  readonly ask: ParkedAsk
  readonly outcome: Promise<ApprovalOutcome>
  readonly resolve: (outcome: ApprovalOutcome) => void
}

/** @returns a six-hex id that no parked ask holds. */
function newId(taken: ReadonlyMap<string, OpenAsk>): string {
  for (;;) {
    const id = randomBytes(3).toString('hex')
    if (!taken.has(id)) return id
  }
}

export class ApprovalQueue {
  readonly #open = new Map<string, OpenAsk>()
  readonly #onDecision: (decision: AskDecision) => void

  /**
   * @param onDecision - told once per {@link settle}, so the caller can audit the decision.
   */
  constructor(onDecision: (decision: AskDecision) => void) {
    this.#onDecision = onDecision
  }

  /**
   * Park one ask.
   * @param ask - the question, reduced to what a supervisor reads.
   * @param session - the bridged root session whose tree raised it.
   * @returns the id the supervisor names the ask by.
   */
  park(ask: ApprovalAsk, session: string): string {
    const id = newId(this.#open)
    let resolve: (outcome: ApprovalOutcome) => void = () => {}
    const outcome = new Promise<ApprovalOutcome>(settled => { resolve = settled })
    const parked: ParkedAsk = {
      id,
      toolName: ask.toolName,
      reason: ask.reason ?? '',
      session,
    }
    this.#open.set(id, { ask: parked, outcome, resolve })
    return id
  }

  /**
   * The outcome promise of a parked ask.
   * @param id - the ask id.
   * @returns the promise {@link settle} resolves, or undefined when `id` is not parked.
   */
  outcome(id: string): Promise<ApprovalOutcome> | undefined {
    return this.#open.get(id)?.outcome
  }

  /**
   * The asks parked right now.
   * @returns the parked asks, oldest first.
   */
  list(): readonly ParkedAsk[] {
    return [...this.#open.values()].map(open => open.ask)
  }

  /**
   * The ids of the asks parked right now.
   * @returns the ids, oldest first.
   */
  ids(): readonly string[] {
    return [...this.#open.keys()]
  }

  /**
   * Resolve one parked ask.
   * @param id - the ask id.
   * @param outcome - the decision handed back to DSH.
   * @param source - who decided it, for the audit echo.
   * @returns true when the ask was still parked and this call ended it.
   */
  settle(id: string, outcome: ApprovalOutcome, source: DecisionSource): boolean {
    const open = this.#open.get(id)
    if (open === undefined) return false
    this.#open.delete(id)
    open.resolve(outcome)
    this.#onDecision({ ask: open.ask, outcome, source })
    return true
  }

  /**
   * Resolve every parked ask, for a supervisor that is going away. No decision
   * is announced: the bridge that would read the audit line is the one leaving.
   * @param outcome - the outcome every parked ask receives.
   */
  clearAll(outcome: ApprovalOutcome): void {
    for (const id of this.ids()) {
      const open = this.#open.get(id)
      if (open === undefined) continue
      this.#open.delete(id)
      open.resolve(outcome)
    }
  }
}
