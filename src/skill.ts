/**
 * The bundled `use-dsh-supervision` skill: what an agent inside a supervised
 * session needs to know, read from the Markdown file this package ships.
 *
 * The host's skill service is not a dependency (the host mounts the plugin, not
 * the reverse), so its shape is declared structurally here.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SKILL_NAME = 'use-dsh-supervision'
/** One provider name = one source in the catalog, and it is this plugin. */
const PROVIDER = 'dsh-supervision'
/**
 * `BUNDLED_SKILL_RANK` from `@deepseek-ai/dsh-skill`, mirrored because this
 * package takes no DSH runtime dependency.
 */
const RANK = 600

const manualUrl = new URL('../skills/use-dsh-supervision/SKILL.md', import.meta.url)
const manualPath = fileURLToPath(manualUrl)
/** The skill directory, so relative links in the body resolve next to the file. */
const skillDir = fileURLToPath(new URL('../skills/use-dsh-supervision', import.meta.url))
const manifestUrl = new URL('../package.json', import.meta.url)

export interface SkillCandidateLike {
  readonly path: string
  readonly name: string
  readonly description: string
  readonly source: 'bundled'
  readonly provider: string
  readonly rank: number
  readonly locator: unknown
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
}

export interface SkillDefinitionLike extends Omit<SkillCandidateLike, 'rank' | 'locator'> {
  readonly content: string
}

/** The provider contract `ctx.skills.registerProvider` borrows from us. */
export interface SkillProviderLike {
  readonly name: string
  list(): Promise<readonly SkillCandidateLike[]>
  get(candidate: SkillCandidateLike): Promise<SkillDefinitionLike | undefined>
}

/** The `ctx.skills` slice this plugin needs; `registerProvider` is the whole seam. */
export interface SkillsLike {
  registerProvider(create: () => SkillProviderLike): () => void
}

/** The context `apply` hands over, reduced to what the skill mount reads. */
export interface SkillMountContext {
  get?(name: string): unknown
  effect(setup: () => () => void): unknown
}

/**
 * Registers the bundled skill when the host mounts a skill registry, inside an
 * effect so disposal unregisters it. The service is read reflectively for the
 * same reason as every other host seam: a host without it still loads the plugin.
 */
export function registerSkill(ctx: SkillMountContext): void {
  const skills = ctx.get?.('skills')
  if (!isSkillsLike(skills)) return
  ctx.effect(() => skills.registerProvider(() => skillProvider()))
}

/** What the provider renders from the packaged manual. */
interface SkillManual {
  readonly description: string
  readonly body: string
}

/**
 * Builds the provider the registry borrows: one candidate, rendered on demand.
 * `read` is injectable so the no-description path can be exercised without a
 * malformed file on disk.
 */
export function skillProvider(read: () => SkillManual = readManual): SkillProviderLike {
  return {
    name: PROVIDER,
    list: async () => {
      const { description } = read()
      // The host validates candidates outside its per-provider catch, so a
      // description the validator rejects would take every skill in the process
      // down. An unparseable manual is therefore simply not a candidate.
      if (description === '') return []
      return [{ ...summary(description), rank: RANK, locator: manualPath }]
    },
    get: async (requested) => {
      if (requested.name !== SKILL_NAME) return undefined
      const { description, body } = read()
      if (description === '') return undefined
      return { ...summary(description), content: body }
    },
  }
}

/** The fields a candidate and a loaded definition share. */
function summary(description: string): Omit<SkillCandidateLike, 'rank' | 'locator'> {
  return {
    path: manualPath,
    name: SKILL_NAME,
    description,
    source: 'bundled',
    provider: PROVIDER,
    resourceBase: { kind: 'directory', path: skillDir },
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

/** Reads the packaged manual: the frontmatter description and the rendered body. */
function readManual(): SkillManual {
  const markdown = readFileSync(manualUrl, 'utf8')
  const end = markdown.startsWith('---\n') ? markdown.indexOf('\n---\n', 3) : -1
  const front = end === -1 ? '' : markdown.slice(4, end)
  const body = end === -1 ? markdown : markdown.slice(end + 5)
  return {
    description: /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? '',
    body: `${body.trim().replaceAll('{{version}}', packageVersion())}\n`,
  }
}

/** The plugin version, which is also the forwarder version this skill requires. */
function packageVersion(): string {
  return (JSON.parse(readFileSync(manifestUrl, 'utf8')) as { version: string }).version
}

export function isSkillsLike(value: unknown): value is SkillsLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { registerProvider?: unknown }).registerProvider === 'function'
  )
}
