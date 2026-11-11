/**
 * validate-release-version.mjs — gate: both published manifests carry the
 * release tag version and the tag is not released yet.
 *
 * Usage (from the repo root, via the package.json `release:validate` script):
 *   pnpm release:validate -- v<version>    # e.g. v0.1.0-alpha.1
 *
 * Checks (two published manifests, one shared version):
 *   1. Tag format: `v` prefix + VERSION_RE.
 *   2. `package.json` and `packages/cli/package.json` both equal the tag
 *      version (v prefix stripped); every surface is reported.
 *   3. Git tag `v<version>` does not exist yet (`git rev-parse` probe; exit 1
 *      with "already released" when it does). Outside a git repository the tag
 *      check is skipped with a note (fixture verification scenario, and the
 *      Release prep job runs it against a fresh tag).
 *
 * All paths are resolved relative to the current working directory.
 *
 * The pure validation logic is exported (`validateReleaseVersion`,
 * `tagExists`) so the committed `node --test` suite covers the positive and
 * negative cases; `main()` only runs when the file is executed directly.
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { VERSION_RE, readVersions } from './release-version.mjs'

/**
 * @returns true when the tag exists, false when it does not, null when the
 * directory is not inside a git work tree.
 */
export function tagExists(version, cwd = process.cwd()) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore', cwd })
  } catch {
    return null
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`], { stdio: 'ignore', cwd })
    return true
  } catch {
    return false
  }
}

/**
 * Pure gate used by `main()` and by the test suite: every version surface
 * carries `version` and the git tag is free. `versions` is the result of
 * `readVersions()`; `tagState` is the result of `tagExists` (true / false /
 * null when not a git repo).
 *
 * @param {string} version
 * @param {{ path: string, version: string | undefined }[]} versions
 * @param {boolean | null} tagState
 * @returns {{ ok: boolean, errors: string[], notes: string[] }}
 */
export function validateReleaseVersion(version, versions, tagState) {
  const errors = []
  const notes = []

  for (const surface of versions) {
    if (surface.version !== version) {
      errors.push(
        `MISMATCH ${surface.path}: tag v${version} => ${version}, ${surface.path} has ${surface.version ?? '<missing>'}`,
      )
    } else {
      notes.push(`OK ${surface.path}: ${surface.version}`)
    }
  }

  if (tagState === null) {
    notes.push('note: not a git repository — skipping tag-exists check')
  } else if (tagState) {
    errors.push(`FAIL already released: git tag v${version} already exists`)
  } else {
    notes.push(`OK git tag v${version} does not exist`)
  }

  return { ok: errors.length === 0, errors, notes }
}

function main() {
  // Strip a leading `--`: pnpm forwards `pnpm release:validate -- vX.Y.Z` as
  // argv [node, scripts/validate-release-version.mjs, --, vX.Y.Z].
  const tag = process.argv.slice(2).find((a) => a !== '--')
  if (!tag) {
    console.error('Usage: node scripts/validate-release-version.mjs v<version>')
    console.error('Example: pnpm release:validate -- v0.1.0-alpha.1')
    process.exit(1)
  }

  const version = tag.startsWith('v') ? tag.slice(1) : tag
  if (!VERSION_RE.test(version)) {
    console.error(`Invalid release tag "${tag}". Expected vX.Y.Z or vX.Y.Z-pre.N (e.g. v0.1.0-alpha.1).`)
    process.exit(1)
  }

  const result = validateReleaseVersion(version, readVersions(), tagExists(version))

  for (const note of result.notes) console.log(note)
  for (const error of result.errors) console.error(error)
  if (!result.ok) {
    console.error(`\nRelease tag ${tag} failed validation.`)
    process.exit(1)
  }
  console.log(`\nAll checks passed for ${tag}.`)
}

// Run only when executed directly — importing the module (the committed test
// suite) must not run the gate.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === entry) {
  main()
}
