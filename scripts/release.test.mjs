/**
 * release.test.mjs — `node --test` coverage for the release tooling. Fixtures
 * are throwaway temp directories (no network, no repository state): the
 * prepare script resolves every path from the current working directory, so a
 * fixture repo root is a complete stand-in for the real one.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { autoBumpPatch, buildSectionBody, insertSection, parseFragment } from './prepare-release.mjs'
import { distTagFor } from './release-version.mjs'
import { tagExists, validateReleaseVersion } from './validate-release-version.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))

const CHANGELOG = `# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.0.0] - 2026-01-01

- Baseline.
`

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A minimal repo root: two manifests, a changelog and one fragment. */
function fixture(t, { version = '0.0.0', fragments = { 'add-release-tooling.md': '- Release tooling added.\n' } } = {}) {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'packages/cli'), { recursive: true })
  mkdirSync(join(dir, '.changes/unreleased'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-supervision', version }, null, 2))
  writeFileSync(join(dir, 'packages/cli/package.json'), JSON.stringify({ name: 'dsh-sup', version }, null, 2))
  writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG)
  for (const [name, body] of Object.entries(fragments)) {
    writeFileSync(join(dir, '.changes/unreleased', name), body)
  }
  return dir
}

function runPrepare(cwd, ...args) {
  return spawnSync(process.execPath, [join(SCRIPTS_DIR, 'prepare-release.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
  })
}

test('autoBumpPatch bumps the patch of a stable version', () => {
  assert.equal(autoBumpPatch('0.1.0'), '0.1.1')
  assert.equal(autoBumpPatch('1.2.9'), '1.2.10')
})

test('autoBumpPatch keeps a prerelease in its line and bumps only the numeric tail', () => {
  assert.equal(autoBumpPatch('0.1.0-alpha.1'), '0.1.0-alpha.2')
  assert.equal(autoBumpPatch('1.0.0-rc.9'), '1.0.0-rc.10')
})

test('autoBumpPatch refuses a non-numeric prerelease tail', () => {
  assert.throws(() => autoBumpPatch('0.1.0-alpha'), /not numeric/)
  assert.throws(() => autoBumpPatch('not-a-version'), /not a parseable/)
})

test('insertSection places the new section directly under [Unreleased]', () => {
  const out = insertSection(CHANGELOG, '0.1.0-alpha.1', '2026-11-11', '### Changed\n\n- One change.')
  assert.ok(
    out.startsWith(
      '# Changelog\n\nAll notable changes to this project are documented in this file.\n\n' +
        '## [Unreleased]\n\n## [0.1.0-alpha.1] - 2026-11-11\n\n### Changed\n\n- One change.\n\n## [0.0.0]',
    ),
    out,
  )
})

test('insertSection ignores repeated blank lines already under [Unreleased]', () => {
  const out = insertSection('# Changelog\n\n## [Unreleased]\n\n\n\n', '1.0.0', '2026-11-11', '')
  assert.equal(out, '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-11-11\n\n')
})

test('buildSectionBody groups fragments by category, defaulting to Changed', () => {
  const added = parseFragment('a.md', '---\ncategory: Added\n---\n- New option.\n')
  const changed = parseFragment('b.md', '- Behaviour change.\n')
  const added2 = parseFragment('c.md', '---\ncategory: Added\n---\n- Second addition.\n')
  assert.equal(
    buildSectionBody([added, changed, added2]),
    '### Added\n\n- New option.\n- Second addition.\n\n### Changed\n\n- Behaviour change.',
  )
})

test('validateReleaseVersion reports every surface that matches the tag', () => {
  const versions = [
    { path: 'package.json', version: '0.1.0-alpha.1' },
    { path: 'packages/cli/package.json', version: '0.1.0-alpha.1' },
  ]
  const result = validateReleaseVersion('0.1.0-alpha.1', versions, false)
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual(result.notes, [
    'OK package.json: 0.1.0-alpha.1',
    'OK packages/cli/package.json: 0.1.0-alpha.1',
    'OK git tag v0.1.0-alpha.1 does not exist',
  ])
})

test('validateReleaseVersion reports a mismatched surface by path', () => {
  const versions = [
    { path: 'package.json', version: '0.1.0-alpha.1' },
    { path: 'packages/cli/package.json', version: '0.1.0-alpha.0' },
  ]
  const result = validateReleaseVersion('0.1.0-alpha.1', versions, false)
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /MISMATCH packages\/cli\/package\.json/)
})

test('validateReleaseVersion refuses an existing tag and skips the check outside a repo', () => {
  const versions = [{ path: 'package.json', version: '1.0.0' }]
  assert.equal(validateReleaseVersion('1.0.0', versions, true).ok, false)
  assert.match(validateReleaseVersion('1.0.0', versions, true).errors[0], /already released/)
  assert.match(validateReleaseVersion('1.0.0', versions, null).notes[1], /not a git repository/)
})

test('tagExists is null outside a repository and distinguishes created tags', (t) => {
  const dir = tempDir(t)
  assert.equal(tagExists('1.0.0', dir), null)

  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'release-test',
        GIT_AUTHOR_EMAIL: 'release-test@example.com',
        GIT_COMMITTER_NAME: 'release-test',
        GIT_COMMITTER_EMAIL: 'release-test@example.com',
      },
    })
  git('init', '-q')
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git('add', '.')
  git('commit', '-q', '-m', 'fixture')
  // -c tag.gpgSign=false: a developer's global config must not sign (and thus
  // fail) the fixture tag.
  git('-c', 'tag.gpgSign=false', 'tag', 'v1.0.0')

  assert.equal(tagExists('1.0.0', dir), true)
  assert.equal(tagExists('2.0.0', dir), false)
})

test('distTagFor publishes stable versions on latest', () => {
  assert.equal(distTagFor('1.0.0'), 'latest')
  assert.equal(distTagFor('0.1.2'), 'latest')
})

test('distTagFor maps a prerelease to the channel before the first dot', () => {
  assert.equal(distTagFor('0.1.0-alpha.1'), 'alpha')
  assert.equal(distTagFor('1.0.0-rc.1'), 'rc')
})

test('distTagFor refuses a latest, digit-only or empty prerelease channel', () => {
  assert.throws(() => distTagFor('1.0.0-latest'), /must not publish under "latest"/)
  assert.throws(() => distTagFor('1.0.0-latest.1'), /must not publish under "latest"/)
  assert.throws(() => distTagFor('1.0.0-1'), /SemVer range, not a dist-tag/)
  assert.throws(() => distTagFor('1.0.0-.1'), /empty prerelease channel/)
  assert.throws(() => distTagFor('not-a-version'), /not a release version/)
})

test('prepare refuses drifted manifests before writing anything', (t) => {
  const dir = fixture(t)
  writeFileSync(join(dir, 'packages/cli/package.json'), JSON.stringify({ name: 'dsh-sup', version: '0.0.1' }, null, 2))
  const changelogBefore = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')

  const run = runPrepare(dir, '0.1.0-alpha.1')
  assert.equal(run.status, 1)
  assert.match(run.stderr, /Version surfaces drifted: package\.json=0\.0\.0, packages\/cli\/package\.json=0\.0\.1/)
  assert.equal(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), changelogBefore)
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '0.0.0')
})

test('prepare bumps both manifests, inserts the section and archives the fragment', (t) => {
  const dir = fixture(t, {
    version: '0.0.0',
    fragments: {
      'release-tooling.md': '---\ncategory: Added\n---\n- Release scripts.\n',
      'ci.md': '- CI workflow.\n',
    },
  })
  const run = runPrepare(dir, '0.1.0-alpha.1')
  assert.equal(run.status, 0, run.stderr)

  for (const path of ['package.json', 'packages/cli/package.json']) {
    assert.equal(JSON.parse(readFileSync(join(dir, path), 'utf8')).version, '0.1.0-alpha.1')
  }
  const changelog = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
  // Fragment filename order decides group order: ci.md ("Changed") first.
  assert.match(
    changelog,
    /## \[Unreleased\]\n\n## \[0\.1\.0-alpha\.1\] - \d{4}-\d{2}-\d{2}\n\n### Changed\n\n- CI workflow\.\n\n### Added\n\n- Release scripts\./,
  )
  assert.match(readFileSync(join(dir, '.changes/archive/0.1.0-alpha.1/ci.md'), 'utf8'), /CI workflow/)
  assert.equal(runPrepare(dir, '0.1.0-alpha.1').status, 1)
})

test('prepare refuses a version that already has a changelog section', (t) => {
  const dir = fixture(t)
  const second = runPrepare(dir, '0.0.0')
  assert.equal(second.status, 1)
  assert.match(second.stderr, /already has a "## \[0\.0\.0\]" section/)
})

test('prepare --patch follows the prerelease line of the current version', (t) => {
  const dir = fixture(t, { version: '0.1.0-alpha.1' })
  const run = runPrepare(dir, '--patch')
  assert.equal(run.status, 0, run.stderr)
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '0.1.0-alpha.2')
  assert.equal(JSON.parse(readFileSync(join(dir, 'packages/cli/package.json'), 'utf8')).version, '0.1.0-alpha.2')
})
