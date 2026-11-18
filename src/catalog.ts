/**
 * The host's session menu as the one catalog frame payload: the skills a
 * session can invoke and the slash commands it can run. Pure — no socket,
 * clock, or process state — because the host mounts the plugin, never the
 * reverse, so each source arrives as `unknown` and is read defensively.
 */

import {
  isRecord,
  MAX_CATALOG_ARGUMENT_HINT,
  MAX_CATALOG_COMMANDS,
  MAX_CATALOG_DESCRIPTION,
  MAX_CATALOG_NAME,
  MAX_CATALOG_SKILLS,
  MAX_FRAME,
  stripControls,
} from 'dsh-supervision-protocol'
import type { CatalogCommand, CatalogSkill } from 'dsh-supervision-protocol'

/** The payload of one `catalog` frame. */
export interface Catalog {
  readonly skills: readonly CatalogSkill[]
  readonly commands: readonly CatalogCommand[]
}

/**
 * The optional host sources the menu is built from. `commands` is the rows
 * `establish` already read — `commands.list` needs the agent, which this pure
 * builder does not have — while `skills` is the skill service itself.
 */
export interface CatalogSources {
  readonly skills: unknown
  readonly commands: unknown
}

/**
 * Build one catalog payload from the host's services.
 * A service that is absent, mistyped or throwing contributes an empty menu:
 * a missing menu must never fail the attach that asked for it.
 * @param sources - the services and rows, read reflectively.
 * @returns the capped skills and commands, in the order the host listed them.
 */
export async function catalogOf(sources: CatalogSources): Promise<Catalog> {
  return fitCatalog(await skillsOf(sources.skills), commandsOf(sources.commands))
}

/**
 * Shrink a capped catalog until its encoded frame fits the wire. Row and column
 * caps do not compose to a frame — 200 skills with multibyte descriptions alone
 * can exceed {@link MAX_FRAME} — and the transport answers an oversized frame by
 * closing the attach. Commands go first and each section from the tail, so the
 * menu keeps all the skills it can.
 */
function fitCatalog(skills: CatalogSkill[], commands: CatalogCommand[]): Catalog {
  while (frameBytes(skills, commands) > MAX_FRAME) {
    if (commands.length > 0) commands.pop()
    else if (skills.length > 0) skills.pop()
    else break
  }
  return { skills, commands }
}

/** One catalog frame's encoded size, the trailing newline included. */
function frameBytes(skills: readonly CatalogSkill[], commands: readonly CatalogCommand[]): number {
  return Buffer.byteLength(JSON.stringify({ t: 'catalog', skills, commands }), 'utf8') + 1
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

/** The already-read command descriptors, capped and validated like skills. */
function commandsOf(rows: unknown): CatalogCommand[] {
  if (!Array.isArray(rows)) return []
  const commands: CatalogCommand[] = []
  for (const row of rows) {
    if (commands.length >= MAX_CATALOG_COMMANDS) break
    if (!isRecord(row)) continue
    const name = nameOf(row['name'])
    const description = text(row['description'], MAX_CATALOG_DESCRIPTION)
    if (name === undefined || description === undefined) continue
    const argumentHint = hintOf(row['input'])
    commands.push({ name, description, ...(argumentHint === undefined ? {} : { argumentHint }) })
  }
  return commands
}

/** The placeholder a command advertises for its free-form input, if any. */
function hintOf(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  const hint = input['hint']
  return typeof hint === 'string' ? text(hint, MAX_CATALOG_ARGUMENT_HINT) : undefined
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
 * not repairable without advertising something nobody can invoke.
 */
function nameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = stripControls(value)
  if (clean !== value || clean === '' || clean.length > MAX_CATALOG_NAME) return undefined
  return clean
}
