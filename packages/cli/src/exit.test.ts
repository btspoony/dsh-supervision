import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, exitCodeFor } from './exit.js';

test('a local protocol refusal exits 6, never as a lost backend', () => {
  assert.equal(EXIT.protocol, 6);
  assert.notEqual(EXIT.protocol, EXIT.backendLost);
});

test('the plugin refusal codes keep their ADR exits; everything else is a lost backend', () => {
  assert.equal(exitCodeFor('busy'), EXIT.busy);
  assert.equal(exitCodeFor('locked'), EXIT.locked);
  assert.equal(exitCodeFor('create-failed'), EXIT.createFailed);
  assert.equal(exitCodeFor('internal'), EXIT.backendLost);
});
