import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs, usageText } from './args.js';

const base = '/work';

test('bare invocation creates a session in the current directory', () => {
  assert.deepEqual(parseArgs([], base), { kind: 'new', cwd: base });
});

test('new is the explicit spelling of the bare form', () => {
  assert.deepEqual(parseArgs(['new'], base), { kind: 'new', cwd: base });
});

test('--cwd resolves a relative path against the forwarder directory', () => {
  assert.deepEqual(parseArgs(['new', '--cwd', 'repo/api'], base), { kind: 'new', cwd: '/work/repo/api' });
});

test('attach takes exactly one session id', () => {
  assert.deepEqual(parseArgs(['attach', 'session-abc'], base), { kind: 'attach', session: 'session-abc' });
  assert.equal(parseArgs(['attach'], base).kind, 'usage');
  assert.equal(parseArgs(['attach', 'session-a', 'session-b'], base).kind, 'usage');
});

test('a bare session id is the attach shorthand', () => {
  assert.deepEqual(parseArgs(['session-1a07'], base), { kind: 'attach', session: 'session-1a07' });
  assert.equal(parseArgs(['session-'], base).kind, 'usage');
});

test('list defaults to every session and --cwd filters it', () => {
  assert.deepEqual(parseArgs(['list'], base), { kind: 'list' });
  assert.deepEqual(parseArgs(['list', '--cwd', '/elsewhere'], base), { kind: 'list', cwd: '/elsewhere' });
});

test('--pid selects among several backends and is accepted by every command', () => {
  assert.deepEqual(parseArgs(['--pid', '42817'], base), { kind: 'new', cwd: base, pid: 42817 });
  assert.deepEqual(parseArgs(['new', '--pid', '42817'], base), { kind: 'new', cwd: base, pid: 42817 });
  assert.deepEqual(parseArgs(['attach', 'session-x', '--pid', '7'], base), {
    kind: 'attach',
    session: 'session-x',
    pid: 7,
  });
  assert.deepEqual(parseArgs(['list', '--pid', '7'], base), { kind: 'list', pid: 7 });
});

test('unknown words, options and bad values are usage errors, never a guess', () => {
  for (const argv of [
    ['frobnicate'],
    ['--nope'],
    ['new', 'extra'],
    ['list', 'extra'],
    ['attach', 'other-id'],
    ['--pid', '0'],
    ['--pid', 'abc'],
    ['--pid'],
    ['--cwd'],
    ['attach', 'session-x', '--cwd', '/w'],
  ]) {
    assert.equal(parseArgs(argv, base).kind, 'usage', `argv: ${argv.join(' ')}`);
  }
});

test('--version and --skill are terminal flags that take no operand', () => {
  assert.deepEqual(parseArgs(['--version'], base), { kind: 'version' });
  assert.deepEqual(parseArgs(['--skill'], base), { kind: 'skill' });
  for (const argv of [['new', '--version'], ['--skill', '--pid', '7'], ['--skill', 'list']]) {
    assert.equal(parseArgs(argv, base).kind, 'usage', `argv: ${argv.join(' ')}`);
  }
});

test('the usage text names both informational flags', () => {
  assert.match(usageText, /dsh-sup --version/);
  assert.match(usageText, /dsh-sup --skill/);
});

test('a usage result always names a reason', () => {
  const parsed = parseArgs(['--pid', '0'], base);
  assert.equal(parsed.kind, 'usage');
  assert.match(parsed.kind === 'usage' ? parsed.reason : '', /--pid/);
});
