/**
 * dist-tag.mjs — thin CLI over `distTagFor` so the Release workflow does not
 * re-implement the channel rules in shell.
 *
 * Usage: node scripts/dist-tag.mjs <version>
 */
import { distTagFor } from './release-version.mjs'

const version = process.argv.slice(2).find((a) => a !== '--')
if (!version) {
  console.error('Usage: node scripts/dist-tag.mjs <version>')
  process.exit(1)
}
try {
  console.log(distTagFor(version))
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
