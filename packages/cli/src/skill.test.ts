import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT } from './exit.js';
import { skillText, version } from './skill.js';

test('version is the packaged CLI version', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  assert.equal(version(), manifest.version);
});

test('the packaged manual keeps the frontmatter the skill catalog reads', () => {
  const raw = readFileSync(new URL('../skills/use-dsh-sup/SKILL.md', import.meta.url), 'utf8');
  assert.match(raw, /^---\nname: use-dsh-sup\n/);
  assert.ok(raw.includes('{{version}}'));
});

test('--skill prints the manual with the frontmatter stripped and the version filled', () => {
  const text = skillText();
  assert.ok(text.startsWith('# dsh-sup\n'), text.slice(0, 20));
  assert.ok(!text.includes('name: use-dsh-sup'));
  assert.ok(!text.includes('{{version}}'));
  assert.ok(text.includes(version()));
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
  assert.match(text, /dsh-sup --skill/);
  assert.match(text, /dsh-sup --version/);
});

test('--skill names an unreadable manual on stderr and exits 2', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sup-skill-'));
  // A throwaway copy of the entry points without the packaged manual: a broken
  // install, with nothing in the tree under test moved or touched. It lives in
  // the temp dir, so even a killed run leaves the checkout alone.
  const pkg = mkdtempSync(join(tmpdir(), 'dsh-sup-pkg-'));
  const bin = join(pkg, 'bin', 'dsh-sup.mjs');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../bin/dsh-sup.mjs', import.meta.url)), bin);
  copyFileSync(fileURLToPath(new URL('./main.js', import.meta.url)), join(pkg, 'lib', 'main.js'));
  // The copy sits outside the package, so its runtime deps come from this one.
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(pkg, 'node_modules'), 'dir');
  try {
    const run = spawnSync(process.execPath, [bin, '--skill'], {
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(run.status, EXIT.usage);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^cannot read .*SKILL\.md: /);
    assert.equal(run.stderr.trimEnd().split('\n').length, 1, 'one stderr line');
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('both flags answer without a registry or live backend', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-sup-skill-'));
  const bin = fileURLToPath(new URL('../bin/dsh-sup.mjs', import.meta.url));
  try {
    const env = { ...process.env, DSH_HOME: home };
    assert.equal(execFileSync(process.execPath, [bin, '--version'], { env, encoding: 'utf8' }), `${version()}\n`);
    assert.equal(execFileSync(process.execPath, [bin, '--skill'], { env, encoding: 'utf8' }), skillText());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
