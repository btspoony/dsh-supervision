/**
 * The bundled skill mount: the provider a host registry borrows, the manual it
 * renders, and the mount's tolerance for a host without a skill service.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { registerSkill, skillProvider } from './skill.js'
import type { SkillCandidateLike, SkillProviderLike } from './skill.js'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}
const raw = readFileSync(new URL('../skills/use-dsh-supervision/SKILL.md', import.meta.url), 'utf8')

/** A fake `ctx.skills`: what the host's registry would do with our provider. */
class FakeSkills {
  readonly providers: SkillProviderLike[] = []
  readonly disposed: boolean[] = []

  registerProvider(create: () => SkillProviderLike): () => void {
    const index = this.providers.push(create()) - 1
    this.disposed.push(false)
    return () => {
      this.disposed[index] = true
    }
  }
}

/** Mounts the skill against `service`; the fake effect runs its setup immediately, like Cordis. */
function mount(service: unknown): (() => void)[] {
  const effectDisposers: (() => void)[] = []
  registerSkill({
    get: (name) => (name === 'skills' ? service : undefined),
    effect: (setup) => {
      effectDisposers.push(setup())
      return undefined
    },
  })
  return effectDisposers
}

test('the catalog names the skill with the description from its frontmatter', async () => {
  const skills = new FakeSkills()
  mount(skills)
  assert.equal(skills.providers.length, 1)
  const provider = skills.providers[0]
  assert.ok(provider)
  assert.equal(provider.name, 'dsh-supervision')

  const [candidate] = await provider.list()
  assert.ok(candidate)
  assert.equal(candidate.name, 'use-dsh-supervision')
  assert.equal(candidate.source, 'bundled')
  assert.equal(candidate.provider, 'dsh-supervision')
  assert.equal(candidate.rank, 600)
  assert.equal(candidate.resourceBase.kind, 'directory')
  assert.match(candidate.resourceBase.path, /skills[/\\]use-dsh-supervision$/)
  const frontmatter = /^description:\s*(.+)$/m.exec(raw)?.[1]?.trim()
  assert.ok(frontmatter !== undefined)
  assert.equal(candidate.description, frontmatter)
});

test('loading the skill renders the packaged body with the plugin version', async () => {
  const provider = skillProvider()
  const [candidate] = await provider.list()
  assert.ok(candidate)
  const definition = await provider.get(candidate)
  assert.ok(definition)
  assert.ok(!definition.content.includes('name: use-dsh-supervision'))
  assert.ok(!definition.content.includes('{{version}}'))
  assert.ok(definition.content.includes('use-dsh-supervision'))
  assert.ok(definition.content.includes('dsh-sup --skill'))
  assert.ok(definition.content.includes(`dsh-sup@${manifest.version}`))
  assert.ok(definition.content.includes(`version ${manifest.version}`))
  assert.ok(definition.content.endsWith('\n') && !definition.content.endsWith('\n\n'))
})

test('a foreign candidate is not ours to load', async () => {
  const foreign: SkillCandidateLike = {
    path: '/tmp/other.md',
    name: 'other-skill',
    description: 'elsewhere',
    source: 'bundled',
    provider: 'dsh-supervision',
    rank: 600,
    locator: 'x',
    resourceBase: { kind: 'directory', path: '/tmp' },
    invocation: { modelInvocable: true, userInvocable: true },
  }
  assert.equal(await skillProvider().get(foreign), undefined)
})

test('a manual without a description yields no candidate and no throw', async () => {
  // The host rejects an empty description outside its per-provider catch, so
  // offering no candidate is the only safe answer to an unparseable manual.
  const provider = skillProvider(() => ({ description: '', body: '# no frontmatter\n' }))
  assert.deepEqual(await provider.list(), [])
  const requested: SkillCandidateLike = {
    path: '/tmp/SKILL.md',
    name: 'use-dsh-supervision',
    description: '',
    source: 'bundled',
    provider: 'dsh-supervision',
    rank: 600,
    locator: 'x',
    resourceBase: { kind: 'directory', path: '/tmp' },
    invocation: { modelInvocable: true, userInvocable: true },
  }
  assert.equal(await provider.get(requested), undefined)
})

test('a host without a skill service still loads, and disposal unregisters', () => {
  assert.doesNotThrow(() => mount(undefined))
  assert.doesNotThrow(() => mount({}))
  assert.doesNotThrow(() => registerSkill({ effect: () => () => {} }))

  const skills = new FakeSkills()
  const disposers = mount(skills)
  assert.equal(disposers.length, 1)
  const dispose = disposers[0]
  assert.ok(dispose)
  dispose()
  assert.deepEqual(skills.disposed, [true])
})
