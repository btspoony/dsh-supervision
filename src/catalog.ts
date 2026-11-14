/**
 * The host's session menu as the one catalog frame payload: the skills a
 * session can invoke and the slash commands its agent advertises. Pure — no
 * socket, clock, or process state — because the host mounts the plugin, never
 * the reverse, so both services arrive as `unknown` and are read defensively.
 */

import {
  isRecord,
  MAX_CATALOG_ARGUMENT_HINT,
  MAX_CATALOG_COMMANDS,
  MAX_CATALOG_DESCRIPTION,
  MAX_CATALOG_NAME,
  MAX_CATALOG_SKILLS,
} from 'dsh-supervision-protocol'
import type { CatalogCommand, CatalogSkill } from 'dsh-supervision-protocol'

/** The payload of one `catalog` frame. */
export interface Catalog {
  readonly skills: readonly CatalogSkill[]
  readonly commands: readonly CatalogCommand[]
}

/** The two optional host services and the agent whose view they answer for. */
export interface CatalogSources {
  readonly skills: unknown
  readonly commands: unknown
  readonly agent: unknown
}

/**
 * Build one catalog payload from the host's two optional services.
 * A service that is absent, mistyped or throwing contributes an empty section:
 * a missing menu must never fail the attach that asked for it.
 * @param sources - the services, read reflectively, and their viewing agent.
 * @returns the capped skills and commands, in the order the host listed them.
 */
export async function catalogOf(sources: CatalogSources): Promise<Catalog> {
  return {
    skills: await skillsOf(sources.skills),
    commands: await commandsOf(sources.commands, sources.agent),
  }
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
    const name = text(row['name'], MAX_CATALOG_NAME)
    const description = text(row['description'], MAX_CATALOG_DESCRIPTION)
    if (name === undefined || description === undefined) continue
    skills.push({ name, description })
  }
  return skills
}

async function commandsOf(value: unknown, agent: unknown): Promise<CatalogCommand[]> {
  const list = listOf(value)
  if (list === undefined) return []
  let rows: unknown
  try {
    rows = await list.call(value, agent)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const commands: CatalogCommand[] = []
  for (const row of rows) {
    if (commands.length >= MAX_CATALOG_COMMANDS) break
    if (!isRecord(row)) continue
    const name = text(row['name'], MAX_CATALOG_NAME)
    const description = text(row['description'], MAX_CATALOG_DESCRIPTION)
    if (name === undefined || description === undefined) continue
    const argumentHint = inputHint(row['input'])
    commands.push(argumentHint === undefined ? { name, description } : { name, description, argumentHint })
  }
  return commands
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

/** The free-form input hint a command advertises, already capped. */
function inputHint(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return text(value['hint'], MAX_CATALOG_ARGUMENT_HINT)
}
