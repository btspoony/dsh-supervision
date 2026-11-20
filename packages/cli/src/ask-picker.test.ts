import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AskFrame } from 'dsh-supervision-protocol';
import {
  answerSpec,
  commitTyping,
  complete,
  containsAssignment,
  moveCursor,
  pickerFor,
  pickRow,
  readsAsPick,
  rowsOf,
  skip,
  skipAll,
  toggleMulti,
} from './ask-picker.js';

const MULTI_ASK: Extract<AskFrame, { readonly questions: readonly unknown[] }> = {
  t: 'ask',
  id: '84e11a',
  questions: [
    { id: 'db', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
    { id: 'feat', question: 'Which features?', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    { id: 'note', question: 'Anything else?' },
  ],
};

function multiState(): ReturnType<typeof pickerFor> {
  return pickerFor(MULTI_ASK);
}

test('a single select emits the picked option number', () => {
  const state = pickerFor({
    t: 'ask',
    id: '3f9ac1',
    questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }],
  });
  const done = pickRow(state, 1);
  assert.equal(answerSpec(done), '/answer 3f9ac1 db=2');
});

test('a multi select emits the toggled indices sorted, comma-joined', () => {
  let state = multiState();
  // Question 1 (db) answered first with option 1.
  state = pickRow(state, 0);
  assert.equal(state.index, 1);
  // Question 2 (feat): rows are 3 options + skip + done; toggle 1 and 3, then done.
  state = pickRow(state, 0);
  state = pickRow(state, 2);
  assert.deepEqual(state.picks, [0, 2]);
  state = pickRow(state, 5); // done
  assert.equal(state.answers['feat'], '1,3');
});

test('toggling the same option twice untoggles it', () => {
  let state = multiState();
  state = pickRow(state, 0); // db=1
  state = pickRow(state, 0);
  state = pickRow(state, 0);
  assert.deepEqual(state.picks, []);
});

test('done with no picks answers the multi question with -', () => {
  let state = multiState();
  state = pickRow(state, 0); // db=1
  state = pickRow(state, 5); // done, nothing toggled
  assert.equal(state.answers['feat'], '-');
});

test('skip answers the current question with -', () => {
  let state = multiState();
  state = skip(state);
  assert.equal(state.answers['db'], '-');
  assert.equal(state.index, 1);
});

test('skipAll answers every question with - and produces one line', () => {
  const line = answerSpec(skipAll(multiState()));
  assert.equal(line, '/answer 84e11a db=- feat=- note=-');
});

test('custom text answers with the raw typed text', () => {
  let state = multiState();
  state = pickRow(state, 2); // Other row
  assert.equal(state.typing, true);
  state = commitTyping(state, '  something custom  ');
  assert.equal(state.answers['db'], 'something custom');
  assert.equal(state.typing, false);
});

test('an empty custom submit returns to the rows instead of answering', () => {
  let state = multiState();
  state = pickRow(state, 2);
  state = commitTyping(state, '   ');
  assert.equal(state.typing, true);
  assert.equal(state.answers['db'], undefined);
});

test('a question with no options goes straight to typing', () => {
  let state = multiState();
  state = pickRow(state, 0); // db=1
  state = pickRow(state, 5); // feat=- via done
  assert.equal(state.index, 2);
  assert.equal(state.typing, true); // note has no options
  state = commitTyping(state, 'call me');
  assert.equal(answerSpec(state), '/answer 84e11a db=1 feat=- note=call me');
});

test('answerSpec is undefined until every question is answered', () => {
  const state = multiState();
  assert.equal(complete(state), false);
  assert.equal(answerSpec(state), undefined);
});

test("a second question's answer never leaks into the first", () => {
  let state = multiState();
  state = pickRow(state, 1); // db=2
  state = pickRow(state, 0); // toggle feat option 1
  state = pickRow(state, 5); // done row commits feat=1
  state = commitTyping(state, 'done here'); // note=done here
  assert.equal(state.answers['db'], '2');
  assert.equal(state.answers['feat'], '1');
  assert.equal(state.answers['note'], 'done here');
});

test('rows expose option marks order and wrap the cursor', () => {
  const state = multiState();
  assert.deepEqual(
    rowsOf(state).map((row) => row.kind),
    ['option', 'option', 'other', 'skip'],
  );
  const multiQuestion = { ...state, index: 1 };
  assert.deepEqual(
    rowsOf(multiQuestion).map((row) => row.kind),
    ['option', 'option', 'option', 'other', 'skip', 'done'],
  );
  const wrapped = moveCursor(state, -1);
  assert.equal(wrapped.cursor, rowsOf(state).length - 1);
});

test('toggleMulti on a non-option row is a no-op', () => {
  const state = moveCursor(multiState(), 2); // Other row
  assert.deepEqual(toggleMulti(state).picks, []);
});

test('custom text that the grammar would read as a pick never commits', () => {
  const state = pickerFor({
    t: 'ask',
    id: 'dd44dd',
    questions: [{ id: 'why', question: 'Why?' }],
  });
  for (const text of ['2', '-', '7', '1,3', '  3  ']) {
    assert.equal(commitTyping(state, text), state, `"${text}" is refused`);
    assert.equal(readsAsPick(text.trim()), true, `"${text}" reads as a pick`);
  }
  for (const text of ['my answer', 'two words', '2.0', '-ish', '']) {
    assert.equal(readsAsPick(text.trim()), false, `"${text}" is literal text`);
  }
  const done = commitTyping(state, 'two words');
  assert.equal(done.answers['why'], 'two words');
});

test('custom text carrying an assignment token is refused before it reaches the wire', () => {
  const state = pickerFor({
    t: 'ask',
    id: 'ff66ff',
    questions: [{ id: 'note', question: 'Notes?' }],
  });
  assert.equal(containsAssignment('note=set A=1'), true);
  assert.equal(containsAssignment('set A 1'), false);
  assert.equal(containsAssignment('a=b'), true);
  assert.equal(commitTyping(state, 'note=set A=1'), state, 'the text is not committed');
  const done = commitTyping(state, 'set A 1');
  assert.equal(done.answers['note'], 'set A 1');
});

test('the Skip row answers - even with picks pending; only Done commits them', () => {
  let state = multiState();
  state = pickRow(state, 0); // db=1, now on the feat question
  state = pickRow(state, 0); // toggle option 1
  state = pickRow(state, 4); // Skip row: discards the pending picks
  assert.equal(state.answers['feat'], '-');
  assert.deepEqual(state.picks, []);
  // Contrast: the Done row is the only row that commits toggled picks.
  let doneState = multiState();
  doneState = pickRow(doneState, 0); // db=1
  doneState = pickRow(doneState, 0); // toggle option 1
  doneState = pickRow(doneState, 5); // Done row
  assert.equal(doneState.answers['feat'], '1');
});

test('skipAll abandons already-answered questions too', () => {
  let state = multiState();
  state = pickRow(state, 1); // db=2 was a real pick
  state = skipAll(state);
  assert.equal(answerSpec(state), '/answer 84e11a db=- feat=- note=-');
});
