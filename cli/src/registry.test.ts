import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { liveEntries, parseEntry, readEntries, resolveSocketDir, selectEntry, type RegistryEntry } from './registry.js';

function entry(pid: number, socket = `/run/${pid}.sock`): RegistryEntry {
  return { proto: 1, pid, socket, startedAt: 1762000000000, dshVersion: '0.2.2-rc.1' };
}

const alive = (): boolean => true;
const dead = (): boolean => false;
/** Only the entries listed here count as alive; mirrors a pid plus socket check. */
const aliveOnly = (...pids: number[]) => (candidate: RegistryEntry): boolean => pids.includes(candidate.pid);

test('a malformed or foreign registry entry is rejected', () => {
  assert.equal(parseEntry(null), undefined);
  assert.equal(parseEntry({ proto: 2, pid: 1, socket: '/s', startedAt: 1, dshVersion: 'x' }), undefined);
  assert.equal(parseEntry({ proto: 1, pid: '1', socket: '/s', startedAt: 1, dshVersion: 'x' }), undefined);
  assert.equal(parseEntry({ proto: 1, pid: 1, socket: '', startedAt: 1, dshVersion: 'x' }), undefined);
  assert.deepEqual(parseEntry({ proto: 1, pid: 1, socket: '/s', startedAt: 1, dshVersion: 'x' }), {
    proto: 1,
    pid: 1,
    socket: '/s',
    startedAt: 1,
    dshVersion: 'x',
  });
});

test('a stale entry is dropped before selection, so it cannot block the live one', () => {
  assert.deepEqual(liveEntries([entry(1), entry(2)], dead), []);
  assert.deepEqual(liveEntries([entry(1), entry(2)], aliveOnly(2)), [entry(2)]);
});

test('--pid narrows the candidates before liveness is considered', () => {
  const entries = [entry(1), entry(2)];
  assert.deepEqual(liveEntries(entries, alive, 2), [entry(2)]);
  assert.deepEqual(liveEntries(entries, alive, 3), []);
  assert.deepEqual(liveEntries(entries, dead, 2), []);
});

test('no live backend reports none', () => {
  assert.deepEqual(selectEntry([entry(1)], dead), { error: 'none', entries: [] });
});

test('exactly one live backend is selected', () => {
  assert.deepEqual(selectEntry([entry(2)], alive), { entry: entry(2) });
});

test('two live backends are ambiguous and both are offered', () => {
  assert.deepEqual(selectEntry([entry(1), entry(2)], alive), {
    error: 'ambiguous',
    entries: [entry(1), entry(2)],
  });
});

test('a stale entry does not compete with the live one', () => {
  assert.deepEqual(selectEntry([entry(1), entry(2)], aliveOnly(2)), { entry: entry(2) });
});

test('an entry is stale when its pid died even though its file remains', () => {
  assert.deepEqual(selectEntry([entry(42)], dead, 42), { error: 'none', entries: [] });
});

test('readEntries skips malformed and foreign files in a temp registry dir', (t) => {
  const dir = mkdtempSync('/tmp/dsh-reg-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const entry = { proto: 1, pid: 42, socket: join(dir, '42-abcdef12.sock'), startedAt: 1, dshVersion: 'x' };
  writeFileSync(join(dir, '42-abcdef12.json'), JSON.stringify(entry));
  writeFileSync(join(dir, 'broken.json'), '{');
  writeFileSync(join(dir, 'foreign.json'), JSON.stringify({ ...entry, proto: 2 }));
  writeFileSync(join(dir, 'note.txt'), 'ignored');

  assert.deepEqual(readEntries(dir), [entry]);
});

test('readEntries yields nothing when the directory does not exist', () => {
  assert.deepEqual(readEntries('/tmp/dsh-reg-absent-directory'), []);
});

test('resolveSocketDir honours DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(resolveSocketDir({ DSH_HOME: '/custom' }), join('/custom', 'supervision'));
  assert.match(resolveSocketDir({}), /[/\\]\.dsh[/\\]supervision$/);
});
