/**
 * release-version.mjs — the shared release-version contract for the release
 * scripts. Two packages publish from one release (`dsh-supervision` at the
 * root and `dsh-sup` in `packages/cli`), so a version surface is the pair of
 * manifests; keeping both helpers in one module stops the prepare and
 * validate scripts from drifting apart.
 *
 * Every path is relative to the current working directory, so the scripts run
 * both from the repo root and from throwaway fixture directories.
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** Architect-approved loose semver: numeric core, optional prerelease suffix. */
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** The published version surfaces, in publish order. */
export const MANIFESTS = ['package.json', 'packages/cli/package.json']

/** @returns {{ path: string, version: string | undefined }[]} */
export function readVersions() {
  return MANIFESTS.map((path) => ({
    path,
    version: JSON.parse(readFileSync(path, 'utf8')).version,
  }))
}

/**
 * Set the version field of every published manifest from `from` to `to`. A
 * surface that does not carry `from` (hand-edited drift) throws instead of
 * being silently rewritten.
 */
export function bumpBothManifests(from, to) {
  for (const path of MANIFESTS) {
    const text = readFileSync(path, 'utf8')
    const re = new RegExp(`("version"\\s*:\\s*")${from.replace(/\./g, '\\.')}(")`)
    if (!re.test(text)) throw new Error(`${path}: could not find version field "${from}"`)
    writeFileSync(path, text.replace(re, `$1${to}$2`))
  }
}
