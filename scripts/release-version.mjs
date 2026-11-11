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
 * npm dist-tag for a release version. Stable `X.Y.Z` publishes under
 * `latest`; a prerelease `X.Y.Z-<channel>.N` publishes under `<channel>` (the
 * identifier before the first dot) so a prerelease never displaces the stable
 * channel.
 */
export function distTagFor(version) {
  const m = version.match(/^\d+\.\d+\.\d+(?:-(.+))?$/)
  if (!m) throw new Error(`Cannot derive an npm dist-tag from "${version}": not a release version.`)
  const pre = m[1]
  if (pre === undefined) return 'latest'

  const channel = pre.split('.')[0]
  if (!channel) {
    throw new Error(`Cannot derive an npm dist-tag from "${version}": empty prerelease channel.`)
  }
  // A digit-only channel (e.g. `1.0.0-1` -> `1`) is a valid SemVer range, which
  // npm rejects as a dist-tag; use a named channel such as alpha/beta/rc.
  if (/^\d+$/.test(channel)) {
    throw new Error(
      `Cannot derive an npm dist-tag from "${version}": channel "${channel}" is a SemVer range, not a dist-tag; use a named channel such as alpha/beta/rc.`,
    )
  }
  // A prerelease on `latest` would overwrite what stable consumers install.
  if (channel === 'latest') {
    throw new Error(
      `Cannot derive an npm dist-tag from "${version}": a prerelease must not publish under "latest"; use a named channel such as alpha/beta/rc.`,
    )
  }
  return channel
}

/**
 * Set the version field of every published manifest from `from` to `to`. Every
 * surface is checked before any file is written: a hand-edited drift must not
 * leave a half-bumped tree.
 */
export function bumpBothManifests(from, to) {
  const targets = MANIFESTS.map((path) => {
    const text = readFileSync(path, 'utf8')
    const re = new RegExp(`("version"\\s*:\\s*")${from.replace(/\./g, '\\.')}(")`)
    if (!re.test(text)) throw new Error(`${path}: could not find version field "${from}"`)
    return { path, text, re }
  })
  for (const { path, text, re } of targets) {
    writeFileSync(path, text.replace(re, `$1${to}$2`))
  }
}
