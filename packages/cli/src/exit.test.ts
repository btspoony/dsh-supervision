import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ErrorCode } from 'dsh-supervision-protocol';
import { EXIT, exitCodeFor } from './exit.js';

test('a local protocol refusal exits 6, never as a lost backend', () => {
  assert.equal(EXIT.protocol, 6);
  assert.notEqual(EXIT.protocol, EXIT.backendLost);
});

// Record<ErrorCode, …> makes a new protocol error code a typecheck failure here.
const expected: Record<ErrorCode, number> = {
  busy: EXIT.busy,
  'unknown-session': EXIT.backendLost,
  'create-failed': EXIT.createFailed,
  locked: EXIT.locked,
  protocol: EXIT.protocol,
  internal: EXIT.backendLost,
};

test('every protocol error code maps to its ADR exit', () => {
  for (const [code, exit] of Object.entries(expected)) {
    assert.equal(exitCodeFor(code), exit, code);
  }
});

test('an unknown code still exits as a lost backend', () => {
  assert.equal(exitCodeFor('not-a-code'), EXIT.backendLost);
});
