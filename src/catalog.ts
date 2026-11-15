/**
 * The host's session menu as the one catalog frame payload: the skills a
 * session can invoke. Pure — no socket, clock, or process state — because the
 * host mounts the plugin, never the reverse, so the service arrives as
 * `unknown` and is read defensively. Host commands are deliberately not
 * collected: the bridge can list them but never run one.
 */

import {
  isRecord,
  MAX_CATALOG_DESCRIPTION,
  MAX_CATALOG_NAME,
  MAX_CATALOG_SKILLS,
  MAX_FRAME,
  stripControls,
} from 'dsh-supervision-protocol'
import type { CatalogCommand, CatalogSkill } from 'dsh-supervision-protocol'

/** The payload of one `catalog` frame; `commands` stays on the wire, always empty. */
export interface Catalog {
  readonly skills: readonly CatalogSkill[]
  readonly commands: readonly CatalogCommand[]
}

/** The optional host service the menu is built from. */
export interface CatalogSources {
  readonly skills: unknown
}

/**
 * Build one catalog payload from the host's skill service.
 * A service that is absent, mistyped or throwing contributes an empty menu:
 * a missing menu must never fail the attach that asked for it.
 * @param sources - the service, read reflectively.
 * @returns the capped skills, in the order the host listed them.
 */
export async function catalogOf(sources: CatalogSources): Promise<Catalog> {
  return fitCatalog(await skillsOf(sources.skills))
}

/**
 * Shrink a capped catalog until its encoded frame fits the wire. Row and column
 * caps do not compose to a frame — 200 skills with multibyte descriptions alone
 * can exceed {@link MAX_FRAME} — and the transport answers an oversized frame by
 * closing the attach. Skills go from the tail, so the list keeps its head.
 */
function fitCatalog(skills: CatalogSkill[]): Catalog {
  while (skills.length > 0 && frameBytes(skills) > MAX_FRAME) skills.pop()
  return { skills, commands: [] }
}

/** One catalog frame's encoded size, the trailing newline included. */
function frameBytes(skills: readonly CatalogSkill[]): number {
  return Buffer.byteLength(JSON.stringify({ t: 'catalog', skills, commands: [] }), 'utf8') + 1
}

async function skillsOf(value: unknown): Promise<CatalogSkill[]> {
  const list = listOf(value)
  if (list === undefined) return []
  let rows: unknown
  try {
    rows = await list.call(value)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const skills: CatalogSkill[] = []
  for (const row of rows) {
    if (skills.length >= MAX_CATALOG_SKILLS) break
    if (!isRecord(row)) continue
    const name = nameOf(row['name'])
    const description = text(row['description'], MAX_CATALOG_DESCRIPTION)
    if (name === undefined || description === undefined) continue
    skills.push({ name, description })
  }
  return skills
}

/** The service's `list` method, when it has one this plugin can call. */
function listOf(value: unknown): ((...args: unknown[]) => unknown) | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const list = (value as { list?: unknown }).list
  return typeof list === 'function' ? list as (...args: unknown[]) => unknown : undefined
}

/** One capped string field, or undefined when the row cannot supply it. */
function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length > limit ? value.slice(0, limit) : value
}

/**
 * A menu name, or undefined when the row must be dropped: the name is the key
 * the menu hands back, so a control byte, an empty name or one over its cap is
 * not repairable without advertising a skill nobody can invoke.
 */
function nameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = stripControls(value)
  if (clean !== value || clean === '' || clean.length > MAX_CATALOG_NAME) return undefined
  return clean
}
