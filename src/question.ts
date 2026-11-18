/**
 * The parked-question queue: an agent question that reached a supervisor stays
 * here until someone answers it, so this module owns the one truth about which
 * questions are open. Apart from the outcome promise each ask holds, nothing
 * here touches the host, a socket or a clock.
 */

import { randomBytes } from 'node:crypto'
import type { AskQuestion } from 'dsh-supervision-protocol'
import type { DecisionSource } from './approval.js'
import type { QuestionAnswers } from './answers.js'

/** One parked ask, reduced to the questions a supervisor answers and its bridge. */
export interface QuestionAsk {
  readonly questions: readonly AskQuestion[]
  /** The bridged root session whose tree raised the ask. */
  readonly session: string
}

/** One parked question, as the supervisor names it. */
export interface ParkedQuestion extends QuestionAsk {
  /** Six hex characters, unique among the asks parked right now. */
  readonly id: string
}

/** One settled question, which is exactly what the audit echo reports. */
export interface QuestionDecision {
  readonly ask: ParkedQuestion
  readonly answers: QuestionAnswers
  readonly source: DecisionSource
}

/** A parked question, its promise, and the resolver that promise hangs on. */
interface OpenQuestion {
  readonly ask: ParkedQuestion
  readonly outcome: Promise<QuestionAnswers>
  readonly resolve: (answers: QuestionAnswers) => void
}

/** @returns a six-hex id that no parked question holds. */
function newId(taken: ReadonlyMap<string, OpenQuestion>): string {
  for (;;) {
    const id = randomBytes(3).toString('hex')
    if (!taken.has(id)) return id
  }
}

export class QuestionQueue {
  readonly #open = new Map<string, OpenQuestion>()
  readonly #onDecision: (decision: QuestionDecision) => void

  /**
   * @param onDecision - told once per {@link settle}, so the caller can audit the decision.
   */
  constructor(onDecision: (decision: QuestionDecision) => void) {
    this.#onDecision = onDecision
  }

  /**
   * Park one ask.
   * @param ask - the questions and the bridge they belong to.
   * @returns the id the supervisor names the ask by.
   */
  park(ask: QuestionAsk): string {
    const id = newId(this.#open)
    let resolve: (answers: QuestionAnswers) => void = () => {}
    const outcome = new Promise<QuestionAnswers>(settled => { resolve = settled })
    this.#open.set(id, { ask: { id, questions: ask.questions, session: ask.session }, outcome, resolve })
    return id
  }

  /**
   * The outcome promise of a parked ask.
   * @param id - the ask id.
   * @returns the promise {@link settle} resolves, or undefined when `id` is not parked.
   */
  outcome(id: string): Promise<QuestionAnswers> | undefined {
    return this.#open.get(id)?.outcome
  }

  /**
   * The asks parked right now.
   * @returns the parked asks, oldest first.
   */
  list(): readonly ParkedQuestion[] {
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
   * @param answers - the answer handed back to DSH.
   * @param source - who decided it, for the audit echo.
   * @returns true when the ask was still parked and this call ended it.
   */
  settle(id: string, answers: QuestionAnswers, source: DecisionSource): boolean {
    const open = this.#open.get(id)
    if (open === undefined) return false
    this.#open.delete(id)
    open.resolve(answers)
    this.#onDecision({ ask: open.ask, answers, source })
    return true
  }

  /**
   * Resolve every parked ask, for a supervisor that is going away. No decision
   * is announced: the bridge that would read the audit line is the one leaving.
   * @param answers - builds each ask's answer; a per-ask function because a skip
   *   must name that ask's own question ids.
   */
  clearAll(answers: (ask: ParkedQuestion) => QuestionAnswers): void {
    for (const id of this.ids()) {
      const open = this.#open.get(id)
      if (open === undefined) continue
      this.#open.delete(id)
      open.resolve(answers(open.ask))
    }
  }
}
