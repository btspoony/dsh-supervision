/**
 * The pure state behind the terminal ask panel: one question at a time,
 * cursor over numbered rows, and the committed answers that become one
 * `/answer <ask> <qid>=<value> ...` line. No terminal, no timers — the
 * surface (`tui.ts`) owns rendering, focus and key routing and only calls
 * into these transitions.
 */

import type { AskFrame, AskQuestion } from 'dsh-supervision-protocol';

/** One picker run over one ask frame's questions, in frame order. */
export interface AskPickerState {
  readonly askId: string;
  readonly questions: readonly AskQuestion[];
  /** The question currently on screen. */
  readonly index: number;
  /** Committed answers so far: option numbers (`2`, `1,3`), `-`, or free text. */
  readonly answers: Readonly<Record<string, string>>;
  /** Options toggled for the current multi-select question, in pick order. */
  readonly picks: readonly number[];
  /** The highlighted row inside `rowsOf(state)`. */
  readonly cursor: number;
  /** True while the editor owns input for a custom ("Other") answer. */
  readonly typing: boolean;
}

/** One visible row of the current question, in display order. */
export type PickerRow =
  | { readonly kind: 'option'; readonly index: number }
  | { readonly kind: 'other' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'done' };

/** A fresh picker for one open ask frame. */
export function pickerFor(frame: Extract<AskFrame, { readonly questions: readonly AskQuestion[] }>): AskPickerState {
  return {
    askId: frame.id,
    questions: frame.questions,
    index: 0,
    answers: {},
    picks: [],
    cursor: 0,
    typing: frame.questions[0] !== undefined && (frame.questions[0].options ?? []).length === 0,
  };
}

/** The current question, or undefined once every question is answered. */
function current(state: AskPickerState): AskQuestion | undefined {
  return state.questions[state.index];
}

/** The visible rows for the current question: options, then Other, Skip, Done. */
export function rowsOf(state: AskPickerState): readonly PickerRow[] {
  const question = current(state);
  if (question === undefined) return [];
  const rows: PickerRow[] = (question.options ?? []).map((_, index) => ({ kind: 'option', index }) as PickerRow);
  if (rows.length > 0) rows.push({ kind: 'other' });
  rows.push({ kind: 'skip' });
  if (question.multiSelect === true) rows.push({ kind: 'done' });
  return rows;
}

/** Moves the cursor one row, wrapping at the ends; no-op when nothing to move. */
export function moveCursor(state: AskPickerState, delta: number): AskPickerState {
  const rows = rowsOf(state);
  if (rows.length === 0) return state;
  const cursor = (((state.cursor + delta) % rows.length) + rows.length) % rows.length;
  return { ...state, cursor };
}

/** Toggles the cursor's option for a multi-select question. */
export function toggleMulti(state: AskPickerState): AskPickerState {
  const row = rowsOf(state)[state.cursor];
  if (row === undefined || row.kind !== 'option') return state;
  const picks = state.picks.includes(row.index)
    ? state.picks.filter((pick) => pick !== row.index)
    : [...state.picks, row.index].sort((a, b) => a - b);
  return { ...state, picks };
}

/** Applies one question's value and steps to the next unanswered question. */
function commit(state: AskPickerState, question: AskQuestion, value: string): AskPickerState {
  const answers = { ...state.answers, [question.id]: value };
  let index = state.index + 1;
  while (index < state.questions.length && answers[state.questions[index]!.id] !== undefined) index += 1;
  const next = state.questions[index];
  return {
    ...state,
    answers,
    index,
    picks: [],
    cursor: 0,
    typing: next !== undefined && (next.options ?? []).length === 0,
  };
}

/** Acts on the row at `rowIndex` exactly as if the cursor were there. */
export function pickRow(state: AskPickerState, rowIndex: number): AskPickerState {
  const question = current(state);
  const row = rowsOf(state)[rowIndex];
  if (question === undefined || row === undefined) return state;
  switch (row.kind) {
    case 'option':
      if (question.multiSelect === true) {
        const toggled = toggleMulti({ ...state, cursor: rowIndex });
        return { ...toggled, cursor: rowIndex };
      }
      return commit(state, question, String(row.index + 1));
    case 'other':
      return { ...state, typing: true };
    case 'skip':
      return commit(state, question, '-');
    case 'done':
      return commit(state, question, state.picks.length === 0 ? '-' : state.picks.map((p) => String(p + 1)).join(','));
  }
}

/**
 * True when custom text would be parsed by the answer grammar as a pick or a
 * skip ("2" = option 2, "1,3" = two options, "-" = skip) rather than a
 * literal value. The surface refuses to commit such text and keeps the editor,
 * so a numeric answer can never be typed silently into a free-text question.
 */
export function readsAsPick(text: string): boolean {
  return /^-$|^\d+(,\d+)*$/.test(text);
}

/**
 * True when custom text carries a `token=` part: on the wire the answer grammar
 * would parse that token as `question-id=value` for an unknown question and
 * refuse the whole `/answer` line.
 */
export function containsAssignment(text: string): boolean {
  return text.trim().split(/\s+/).some((token) => token.includes('='));
}

/**
 * Records a custom ("Other") answer typed in the editor. Empty text, text that
 * {@link readsAsPick} would misread as a pick, or text carrying an assignment
 * token ({@link containsAssignment}) leaves the state untouched.
 */
export function commitTyping(state: AskPickerState, text: string): AskPickerState {
  const question = current(state);
  const value = text.trim();
  if (question === undefined || value === '' || readsAsPick(value) || containsAssignment(value)) return state;
  return commit({ ...state, typing: false }, question, value);
}

/** Answers the current question with `-` (skip). */
export function skip(state: AskPickerState): AskPickerState {
  const question = current(state);
  if (question === undefined) return state;
  return commit(state, question, '-');
}

/**
 * Abandons the whole ask: every question becomes `-`, including ones already
 * answered — Esc means "withdraw my picks", not "fill in the rest".
 */
export function skipAll(state: AskPickerState): AskPickerState {
  let next = state;
  for (const question of state.questions) next = commit(next, question, '-');
  return next;
}

/** True once every question has an answer; `answerSpec` needs this. */
export function complete(state: AskPickerState): boolean {
  return state.questions.every((question) => state.answers[question.id] !== undefined);
}

/**
 * The `/answer` line the picker emits, or undefined until every question is
 * answered. This is the only thing the picker sends: the wire grammar and the
 * plugin's parser (`answers.ts`) are unchanged.
 */
export function answerSpec(state: AskPickerState): string | undefined {
  if (!complete(state)) return undefined;
  const spec = state.questions.map((question) => `${question.id}=${state.answers[question.id]}`).join(' ');
  return `/answer ${state.askId} ${spec}`;
}
