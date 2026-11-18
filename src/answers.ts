/**
 * The `/answer` grammar, kept pure: the forwarder splits stdin into lines and
 * the plugin only decides what one answer line means. No host, socket, clock or
 * filesystem here, so the grammar is testable as a table.
 */

/** The slice of one question this grammar reads. */
export interface AskQuestionLike {
  readonly id: string
  readonly options?: readonly { readonly label: string }[]
}

/** One answer, in the shape DSH's `ask_user_question` answerer returns. */
export interface AnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** The whole answer to one parked ask. */
export interface QuestionAnswers {
  readonly answers: readonly AnswerItem[]
}

/** What one answer value means: the selection, or the reason it is unusable. */
type ParsedValue = { readonly answer: AnswerItem } | { readonly error: string }

/**
 * Answer every question with nothing: the answer a withdrawn or dropped ask
 * settles with, so no asker is left waiting on a supervisor that is gone.
 * @param questions - the questions of the parked ask.
 * @returns one skipped answer per question, in the order asked.
 */
export function skipAnswers(questions: readonly AskQuestionLike[]): QuestionAnswers {
  return { answers: questions.map(question => ({ id: question.id, selected: [] })) }
}

/**
 * Parse one `/answer` spec: whitespace-separated `<qid>=<value>` tokens, or a
 * bare `<value>` when the ask has exactly one question.
 * @param questions - the questions of the parked ask.
 * @param spec - the text after the ask id, as the operator typed it.
 * @returns the answers, or one sentence naming the malformed token.
 */
export function parseAnswers(
  questions: readonly AskQuestionLike[],
  spec: string,
): QuestionAnswers | { readonly error: string } {
  const text = spec.trim()
  // One question owns the whole line: the id is redundant, and free text may
  // contain spaces. A line carrying `=` is still the token grammar below.
  if (questions.length === 1 && text !== '' && !text.includes('=')) {
    const question = questions[0]
    if (question !== undefined) {
      const parsed = valueOf(question, text)
      if ('error' in parsed) return parsed
      return { answers: [parsed.answer] }
    }
  }
  // Tokens group into answers: `=` starts the next one, and every word after it
  // belongs to that value, so `q=two words` is one custom answer.
  const items: { id: string; value: string }[] = []
  for (const token of text.split(/\s+/).filter(part => part !== '')) {
    const at = token.indexOf('=')
    if (at !== -1) {
      items.push({ id: token.slice(0, at), value: token.slice(at + 1) })
      continue
    }
    const current = items[items.length - 1]
    if (current !== undefined) {
      current.value = current.value === '' ? token : `${current.value} ${token}`
      continue
    }
    // A bare value names no question, so only an ask with one question can
    // infer it. Rejecting the rest keeps a typo from answering the wrong one.
    if (questions.length > 1) return { error: 'a bare answer needs exactly one question' }
    const question = questions[0]
    if (question === undefined) return { error: 'no question to answer' }
    items.push({ id: question.id, value: token })
  }
  const answers = new Map<string, AnswerItem>()
  for (const item of items) {
    if (item.id === '') return { error: 'answer token has no question id' }
    const question = questions.find(candidate => candidate.id === item.id)
    if (question === undefined) return { error: `unknown question ${item.id}` }
    if (answers.has(item.id)) return { error: `duplicate answer for ${item.id}` }
    if (item.value === '') return { error: `empty answer for ${item.id}` }
    const parsed = valueOf(question, item.value)
    if ('error' in parsed) return parsed
    answers.set(item.id, parsed.answer)
  }
  // Every question appears exactly once: a partial answer would leave the host
  // waiting on a question the supervisor never saw answered.
  const ordered: AnswerItem[] = []
  for (const question of questions) {
    const answer = answers.get(question.id)
    if (answer === undefined) return { error: `missing answer for ${question.id}` }
    ordered.push(answer)
  }
  return { answers: ordered }
}

/**
 * One value: `-` skips, 1-based option indexes select labels in the order given,
 * and anything else is free text. Multi-select is not enforced — an index list is
 * a legal answer for any question, and the host decides whether it is happy.
 * @param question - the question this value answers.
 * @param value - the token after `=`, or a bare value.
 * @returns the answer, or the reason the value cannot answer this question.
 */
function valueOf(question: AskQuestionLike, value: string): ParsedValue {
  if (value === '-') return { answer: { id: question.id, selected: [] } }
  if (/^\d+(,\d+)*$/.test(value)) {
    const options = question.options ?? []
    if (options.length === 0) return { error: `question ${question.id} has no options` }
    const selected: string[] = []
    for (const part of value.split(',')) {
      const option = options[Number(part) - 1]
      if (option === undefined) return { error: `option ${part} is out of range for ${question.id}` }
      selected.push(option.label)
    }
    return { answer: { id: question.id, selected } }
  }
  return { answer: { id: question.id, selected: [], custom: value } }
}
