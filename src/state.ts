/**
 * Pure root-report derivation. herdr-core keeps one record per terminal and a
 * report replaces it whole, so this module decides what the record says and
 * when re-sending is worth a frame. No socket, clock, or process state here.
 */

import type { ProgramState } from 'dsh-supervision-protocol'

/** The record one bridge reports; a record is replaced whole, so every field is present. */
export interface RootRecord {
  readonly state: ProgramState
  readonly app: string
  readonly title: string
}

/** The word a finished turn leaves behind. */
export type TerminalWord = 'done' | 'error' | 'blocked' | 'idle'

/** Facts the root record is derived from. */
export type StateEvent =
  | { readonly type: 'turn/start'; readonly turn: number }
  | { readonly type: 'turn/end'; readonly turn: number; readonly reason: string }
  | { readonly type: 'agent/status'; readonly status: 'idle' | 'running' }
  | { readonly type: 'title'; readonly title: string }

export interface RootState {
  /** The `app` field every report restates. */
  readonly app: string
  readonly title: string
  /** What the last finished turn left behind. */
  readonly terminal: TerminalWord
  /** A live turn or a running agent keeps the root on `working`. */
  readonly working: boolean
  /**
   * A live `turn/start` has been seen. A resumed session replays its history,
   * so until one arrives every `turn/end` belongs to the past.
   */
  readonly live: boolean
  readonly turn: number
  /** The record last settled on; identity changes only when its fields change. */
  readonly current: RootRecord
}

/** `turn/end.reason.kind` → the word shown after the turn. */
function terminalOf(reason: string): TerminalWord {
  switch (reason) {
    case 'completed': return 'done'
    case 'blocked': return 'blocked'
    case 'error':
    case 'max-tokens': return 'error'
    // `aborted` / `interrupted` are a stopped turn rather than a result worth
    // showing, and an unknown extension variant is safer as idle than as a lie.
    default: return 'idle'
  }
}

/**
 * The root word. Precedence: blocked > working > error > done > idle, where a
 * parked approval outranks a live turn because hc's `send` gate reads this root.
 * @param state - the fields that decide the word.
 * @returns the word to report.
 */
export function rootWord(state: Pick<RootState, 'working' | 'terminal'>): ProgramState {
  if (state.terminal === 'blocked') return 'blocked'
  if (state.working) return 'working'
  return state.terminal
}

/**
 * Open a root state before any fact arrives.
 * @param app - the program name every report restates.
 * @param title - the root title derived from the session.
 * @returns a state whose first report is `idle`.
 */
export function createRootState(app: string, title: string): RootState {
  return {
    app,
    title,
    terminal: 'idle',
    working: false,
    live: false,
    turn: 0,
    current: { state: 'idle', app, title },
  }
}

/**
 * Fold one fact into the root state.
 * @param state - the previous state.
 * @param event - one session or agent fact.
 * @returns the next state; `current` keeps its identity when the record did not change.
 */
export function reduceRootState(state: RootState, event: StateEvent): RootState {
  let settled: Pick<RootState, 'app' | 'title' | 'terminal' | 'working' | 'live'>
  switch (event.type) {
    case 'turn/start':
      settled = { ...state, working: true, live: true, terminal: 'idle' }
      break
    case 'turn/end':
      // Historical ends replay on resume; only a live turn's end is news.
      if (!state.live) return state
      settled = { ...state, working: false, terminal: terminalOf(event.reason) }
      break
    case 'agent/status':
      settled = { ...state, working: event.status === 'running' }
      break
    case 'title':
      settled = { ...state, title: event.title }
      break
  }

  // hc increments its own turn each time the root leaves `working`, and a
  // repeated word is not a turn; mirroring that exactly is what keeps the two
  // counters equal.
  const leaving = state.current.state === 'working' && rootWord(settled) !== 'working'
  const turn = leaving ? state.turn + 1 : state.turn
  const record: RootRecord = { state: rootWord(settled), app: settled.app, title: settled.title }
  const unchanged = record.state === state.current.state
    && record.app === state.current.app
    && record.title === state.current.title
  return { ...settled, turn, current: unchanged ? state.current : record }
}
