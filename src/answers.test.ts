/**
 * The `/answer` grammar on its own: one spec in, one answer or one error out.
 * No host, socket or clock is involved, so these tests pin the grammar the
 * supervisor types rather than the plugin's wiring.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAnswers, skipAnswers } from './answers.js'
import type { AskQuestionLike } from './answers.js'

const DB: AskQuestionLike = { id: 'db', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }
const NOTE: AskQuestionLike = { id: 'note' }
const SINGLE = [DB]
const MULTI = [DB, NOTE]

const CASES: readonly {
  readonly name: string
  readonly questions: readonly AskQuestionLike[]
  readonly spec: string
  readonly expected: unknown
}[] = [
  {
    name: 'one question takes a bare 1-based option index',
    questions: SINGLE,
    spec: '2',
    expected: { answers: [{ id: 'db', selected: ['Postgres'] }] },
  },
  {
    name: 'an index list keeps the order the operator gave',
    questions: SINGLE,
    spec: '2,1',
    expected: { answers: [{ id: 'db', selected: ['Postgres', 'SQLite'] }] },
  },
  {
    name: 'a dash skips the question',
    questions: SINGLE,
    spec: '-',
    expected: { answers: [{ id: 'db', selected: [] }] },
  },
  {
    name: 'any other value is free text',
    questions: SINGLE,
    spec: 'mysql',
    expected: { answers: [{ id: 'db', selected: [], custom: 'mysql' }] },
  },
  {
    name: 'one question takes free text with spaces as its whole value',
    questions: SINGLE,
    spec: '我的 想法',
    expected: { answers: [{ id: 'db', selected: [], custom: '我的 想法' }] },
  },
  {
    name: 'a named answer keeps the words after its first token',
    questions: SINGLE,
    spec: 'db=选 项',
    expected: { answers: [{ id: 'db', selected: [], custom: '选 项' }] },
  },
  {
    name: 'one question may also be named by its id',
    questions: SINGLE,
    spec: 'db=2',
    expected: { answers: [{ id: 'db', selected: ['Postgres'] }] },
  },
  {
    name: 'several questions each need one token, and answers follow question order',
    questions: MULTI,
    spec: 'note=because db=1,2',
    expected: {
      answers: [
        { id: 'db', selected: ['SQLite', 'Postgres'] },
        { id: 'note', selected: [], custom: 'because' },
      ],
    },
  },
  {
    name: 'several tokens answer in question order, not token order',
    questions: MULTI,
    spec: 'note=- db=2',
    expected: {
      answers: [{ id: 'db', selected: ['Postgres'] }, { id: 'note', selected: [] }],
    },
  },
  {
    name: 'a multi-question answer groups spaces into the value they follow',
    questions: MULTI,
    spec: 'db=选 项 note=-',
    expected: {
      answers: [{ id: 'db', selected: [], custom: '选 项' }, { id: 'note', selected: [] }],
    },
  },
  {
    name: 'a bare value cannot answer more than one question',
    questions: MULTI,
    spec: '2',
    expected: { error: 'a bare answer needs exactly one question' },
  },
  {
    name: 'a token with no question id is an error',
    questions: SINGLE,
    spec: '=x',
    expected: { error: 'answer token has no question id' },
  },
  {
    name: 'an unknown question id is named',
    questions: SINGLE,
    spec: 'nope=1',
    expected: { error: 'unknown question nope' },
  },
  {
    name: 'the same question twice is an error',
    questions: SINGLE,
    spec: 'db=1 db=2',
    expected: { error: 'duplicate answer for db' },
  },
  {
    name: 'an empty value is an error',
    questions: SINGLE,
    spec: 'db=',
    expected: { error: 'empty answer for db' },
  },
  {
    name: 'an out-of-range index is an error',
    questions: SINGLE,
    spec: 'db=3',
    expected: { error: 'option 3 is out of range for db' },
  },
  {
    name: 'zero is not a 1-based option',
    questions: SINGLE,
    spec: 'db=0',
    expected: { error: 'option 0 is out of range for db' },
  },
  {
    name: 'a question without options cannot be answered by index',
    questions: MULTI,
    spec: 'db=1 note=1',
    expected: { error: 'question note has no options' },
  },
  {
    name: 'every question must be answered',
    questions: MULTI,
    spec: 'db=1',
    expected: { error: 'missing answer for note' },
  },
  {
    name: 'an empty spec answers nothing, and every question is missing',
    questions: SINGLE,
    spec: '',
    expected: { error: 'missing answer for db' },
  },
]

for (const item of CASES) {
  test(item.name, () => {
    assert.deepEqual(parseAnswers(item.questions, item.spec), item.expected)
  })
}

test('skipAnswers names every question and selects nothing', () => {
  assert.deepEqual(skipAnswers(MULTI), {
    answers: [{ id: 'db', selected: [] }, { id: 'note', selected: [] }],
  })
  assert.deepEqual(skipAnswers([]), { answers: [] })
})
