/**
 * strip-workspace-deps.mjs — drop pnpm `workspace:` specifiers from the
 * package.json that npm is about to pack.
 *
 * Why: npm neither resolves nor rewrites the pnpm workspace protocol, so a
 * `workspace:*` entry would be published verbatim and break npm installs of
 * the package. The protocol package is bundled into the build output, so it
 * must not appear in the published manifest at all.
 *
 * Run from the package directory (the publish job does). Only the four
 * dependency sections are touched, and the file is rewritten only when
 * something was actually removed — re-running it is a no-op.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PATH = 'package.json'
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

const manifest = JSON.parse(readFileSync(PATH, 'utf8'))
const removed = []

for (const section of SECTIONS) {
  const deps = manifest[section]
  if (!deps || typeof deps !== 'object') continue
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec === 'string' && spec.startsWith('workspace:')) {
      delete deps[name]
      removed.push(`${section}: ${name}`)
    }
  }
}

if (!removed.length) {
  console.log(`${PATH}: no workspace: specifiers, left unchanged`)
} else {
  writeFileSync(PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const entry of removed) console.log(`removed ${entry}`)
  console.log(`${PATH}: removed ${removed.length} workspace: specifier(s)`)
}
