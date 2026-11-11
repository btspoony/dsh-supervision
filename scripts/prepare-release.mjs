/**
 * prepare-release.mjs — resolve the next version, assemble changelog
 * fragments, insert the changelog section, bump both published manifests,
 * archive the consumed fragments.
 *
 * Usage (from the repo root, via the package.json `release:prepare` script):
 *   pnpm release:prepare -- <version>    # explicit version, used as-is
 *   pnpm release:prepare -- --patch      # auto patch bump
 *
 * Exactly one of the two forms is required: running with no arguments exits
 * with a usage hint instead of silently auto-bumping.
 *
 * Version resolution:
 *   - Explicit version must match VERSION_RE and is used as-is (prerelease
 *     suffixes allowed, e.g. 0.1.0-alpha.1). The version must also yield a
 *     legal npm dist-tag (`distTagFor`): an empty, digit-only or `latest`
 *     prerelease channel is refused BEFORE any file is written — it would
 *     otherwise pass prepare and only fail later at release:validate, leaving
 *     a half-prepared tree (archived fragments, dirty changelog and manifests).
 *   - `--patch` auto bump:
 *       * current has a numeric prerelease tail (`X.Y.Z-pre.N`) -> bump only N
 *         (0.1.0-alpha.1 -> 0.1.0-alpha.2; never jumps to a stable release);
 *       * no prerelease -> patch + 1 (0.1.0 -> 0.1.1);
 *       * prerelease with a non-numeric tail -> exit 1, use an explicit
 *         version instead.
 *
 * What it does:
 *   1. Reads `.changes/unreleased/*.md` fragments (README.md / .gitkeep are
 *      skipped). Optional frontmatter `category:` groups bullets under a
 *      `### <category>` heading (default: `Changed`); the body is one or more
 *      English bullet lines, rendered verbatim.
 *   2. Inserts a `## [<version>] - <date>` section into CHANGELOG.md directly
 *      under `## [Unreleased]`, refusing a version that already has a section.
 *   3. Bumps the `version` field in both published manifests.
 *   4. Moves consumed fragments to `.changes/archive/<version>/`.
 *
 * This script only edits the working tree. Commit + PR is the caller's job
 * (the `release-prep` workflow commits and opens the `release v<version>` PR).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { VERSION_RE, bumpBothManifests, distTagFor, readVersions } from './release-version.mjs'

const CHANGES_DIR = '.changes'
const UNRELEASED_DIR = join(CHANGES_DIR, 'unreleased')
const ARCHIVE_DIR = join(CHANGES_DIR, 'archive')
const CHANGELOG_PATH = 'CHANGELOG.md'

const DEFAULT_CATEGORY = 'Changed'

/** @typedef {{ file: string, category?: string, bullets: string[] }} Fragment */

/** @returns {{ version?: string, autoBump: boolean }} */
export function parseArgs(argv) {
  const rest = argv.slice(2).filter((a) => a !== '--')
  let version
  let autoBump = false
  for (const arg of rest) {
    if (VERSION_RE.test(arg)) version = arg
    else if (arg === '--patch') autoBump = true
    else if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg} (expected <version> or --patch)`)
    else throw new Error(`Invalid version "${arg}". Expected X.Y.Z or X.Y.Z-pre.N (e.g. 0.1.0-alpha.1)`)
  }
  if (version !== undefined && autoBump) {
    throw new Error('Pass either an explicit <version> or --patch, not both')
  }
  return { version, autoBump }
}

/**
 * Auto patch bump. Deliberately not the naive split+increment approach (which
 * turns `0.1.0-alpha.1 --patch` into the stable `0.1.1`): a prerelease version
 * stays in its prerelease line, bumping only the numeric tail.
 */
export function autoBumpPatch(current) {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
  if (!m) throw new Error(`Cannot auto-bump "${current}": not a parseable X.Y.Z[-pre] version`)
  const [, major, minor, patch, pre] = m
  if (pre === undefined) return `${major}.${minor}.${Number(patch) + 1}`
  const tail = pre.split('.').at(-1)
  if (tail === undefined || !/^\d+$/.test(tail)) {
    throw new Error(
      `Cannot auto-bump "${current}": prerelease tail "${pre}" is not numeric. ` +
        'Pass an explicit version instead (e.g. `pnpm release:prepare -- <version>`).',
    )
  }
  const prefix = pre.slice(0, pre.length - tail.length) // "alpha." for "alpha.1"
  return `${major}.${minor}.${patch}-${prefix}${Number(tail) + 1}`
}

/** @returns {{ fm: Record<string, string>, body: string }} */
export function parseFrontmatter(text, file = '<fragment>') {
  const fm = {}
  if (!text.startsWith('---')) return { fm, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) {
    // An unclosed block would otherwise be written into the changelog verbatim.
    throw new Error(`fragment ${file}: frontmatter opened with "---" but never closed`)
  }
  const fmText = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\n/, '')
  for (const line of fmText.split('\n')) {
    const m = line.match(/^([A-Za-z0-9 _-]+):\s*(.*)$/)
    if (m) fm[m[1].trim()] = m[2].trim()
  }
  return { fm, body }
}

/** @returns {Fragment} */
export function parseFragment(file, text) {
  const { fm, body } = parseFrontmatter(text, file)
  const bullets = body
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
  return {
    file,
    category: fm.category?.trim() || undefined,
    bullets,
  }
}

/** @returns {Fragment[]} */
export function readFragments(dir = UNRELEASED_DIR) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => parseFragment(f, readFileSync(join(dir, f), 'utf8')))
}

/** Bullets between the version header and the next section, grouped by category. */
export function buildSectionBody(frags) {
  const groups = []
  for (const frag of frags) {
    const category = frag.category ?? DEFAULT_CATEGORY
    let group = groups.find((g) => g.category === category)
    if (!group) {
      group = { category, bullets: [] }
      groups.push(group)
    }
    group.bullets.push(...frag.bullets)
  }
  const lines = []
  for (const group of groups) {
    lines.push(`### ${group.category}`, '', ...group.bullets, '')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Insert `## [<version>] - <date>` directly under the `## [Unreleased]` header. */
export function insertSection(changelog, version, date, body) {
  const unreleased = changelog.indexOf('## [Unreleased]')
  if (unreleased === -1) throw new Error(`${CHANGELOG_PATH} has no "## [Unreleased]" header`)
  const afterLine = changelog.indexOf('\n', unreleased) + 1
  const tail = changelog.slice(afterLine).replace(/^\n+/, '')
  const section = [`## [${version}] - ${date}`]
  if (body.trim()) section.push('', body)
  return `${changelog.slice(0, afterLine)}\n${section.join('\n')}\n\n${tail}`
}

/** A re-run of prepare for an already-documented version must not duplicate the section. */
export function assertNotDocumented(changelog, version) {
  if (changelog.includes(`## [${version}]`)) {
    throw new Error(
      `${CHANGELOG_PATH} already has a "## [${version}]" section. ` +
        'Pick the next version (or rerun Release prep for it).',
    )
  }
}

export function archiveFragments(version, frags, from = UNRELEASED_DIR) {
  if (!frags.length) return
  const dest = join(ARCHIVE_DIR, version)
  mkdirSync(dest, { recursive: true })
  for (const frag of frags) {
    renameSync(join(from, frag.file), join(dest, frag.file))
  }
}

export function main() {
  const { version: explicit, autoBump } = parseArgs(process.argv)
  if (explicit === undefined && !autoBump) {
    console.error('Usage: pnpm release:prepare -- <version> | pnpm release:prepare -- --patch')
    console.error('Pass an explicit <version> (e.g. 0.1.0-alpha.1) or --patch for an auto bump.')
    process.exit(1)
  }
  // Every version surface must agree before anything is written: a drifted
  // manifest would otherwise leave a half-prepared tree (changelog written,
  // bump refused) that the next run cannot finish.
  const versions = readVersions()
  const current = versions[0]?.version
  if (!current) throw new Error(`${versions[0]?.path} has no version`)
  const drifted = versions.filter((surface) => surface.version !== current)
  if (drifted.length) {
    throw new Error(
      `Version surfaces drifted: ${versions.map((v) => `${v.path}=${v.version ?? '<missing>'}`).join(', ')}. ` +
        'Sync both manifests before preparing a release.',
    )
  }

  const version = explicit ?? autoBumpPatch(current)
  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid version "${version}". Expected X.Y.Z or X.Y.Z-pre.N (e.g. 0.1.0-alpha.1)`)
  }
  // Refuse a version the publish step could never tag BEFORE the destructive
  // writes: prepare would otherwise archive the fragments and dirty the
  // changelog and both manifests, and release:validate would only reject it
  // afterwards, leaving a tree the next run cannot finish.
  try {
    distTagFor(version)
  } catch (err) {
    throw new Error(`Cannot prepare release ${version}: ${err instanceof Error ? err.message : err}`)
  }
  const date = new Date().toISOString().slice(0, 10)

  console.log(`Preparing release ${current} -> ${version}\n`)

  const changelog = readFileSync(CHANGELOG_PATH, 'utf8')
  assertNotDocumented(changelog, version)

  const frags = readFragments()
  console.log(`Fragments: ${frags.length}`)
  for (const frag of frags) {
    console.log(`  - ${frag.file}${frag.category ? `  [category: ${frag.category}]` : ''}`)
  }
  if (!frags.length) console.log('  (no fragments — section will be empty)')

  const body = buildSectionBody(frags)
  writeFileSync(CHANGELOG_PATH, insertSection(changelog, version, date, body))
  console.log(`changelog: ${CHANGELOG_PATH} (## [${version}] - ${date})`)

  bumpBothManifests(current, version)
  for (const { path } of readVersions()) console.log(`bump: ${path}`)

  archiveFragments(version, frags)
  console.log(`archive: ${frags.length} fragment(s) -> ${join(ARCHIVE_DIR, version)}`)

  console.log(`\nDone. Next: commit and open PR "release v${version}".`)
  console.log(`Validate with: pnpm release:validate -- v${version}`)
}

// Run only when executed directly (node scripts/prepare-release.mjs) —
// importing the module (the committed test suite) must not start the flow.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === entry) {
  try {
    main()
  } catch (err) {
    console.error(`\nprepare-release failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
