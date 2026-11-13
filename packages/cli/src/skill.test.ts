import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
