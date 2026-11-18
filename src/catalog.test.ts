/**
 * Catalog assembly: the host's skill service and the command descriptors
 * `establish` already read become the menu payload, and a missing, mistyped or
 * throwing source contributes an empty section instead of a fault.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeChunk,
  encodeFrame,
  MAX_CATALOG_ARGUMENT_HINT,
  MAX_CATALOG_COMMANDS,
  MAX_CATALOG_DESCRIPTION,
  MAX_CATALOG_NAME,
  MAX_CATALOG_SKILLS,
  MAX_FRAME,
} from 'dsh-supervision-protocol'
import { catalogOf } from './catalog.js'

test('the skill service and the command rows become the menu', async () => {
  const catalog = await catalogOf({
    skills: { list: async () => [{ name: 'use-dsh-sup', description: 'drive the terminal' }] },
    commands: [
      { name: 'compact', description: 'shrink the context', input: { hint: 'focus' } },
      { name: 'goal', description: 'set a goal' },
    ],
  })
  assert.deepEqual(catalog, {
    skills: [{ name: 'use-dsh-sup', description: 'drive the terminal' }],
    commands: [
      { name: 'compact', description: 'shrink the context', argumentHint: 'focus' },
      { name: 'goal', description: 'set a goal' },
    ],
  })
})

test('an absent source contributes an empty section', async () => {
  assert.deepEqual(await catalogOf({ skills: undefined, commands: undefined }), { skills: [], commands: [] })
  assert.deepEqual(await catalogOf({ skills: { list: async () => [] }, commands: [] }), { skills: [], commands: [] })
  assert.deepEqual(await catalogOf({ skills: undefined, commands: 'nope' }), { skills: [], commands: [] })
})

test('a throwing or mistyped skill service is an empty menu, never a rejection', async () => {
  assert.deepEqual(
    await catalogOf({ skills: { list: async () => { throw new Error('skills down') } }, commands: [] }),
    { skills: [], commands: [] },
  )
  assert.deepEqual(await catalogOf({ skills: { list: 1 }, commands: [] }), { skills: [], commands: [] })
  assert.deepEqual(await catalogOf({ skills: 'nope', commands: [] }), { skills: [], commands: [] })
})

test('malformed rows are skipped, not fatal', async () => {
  const catalog = await catalogOf({
    skills: {
      list: async () => [
        { name: 'good', description: 'kept' },
        { name: 'no-description' },
        { description: 'no-name' },
        'not a row',
        { name: 1, description: 'wrong type' },
      ],
    },
    commands: [
      { name: 'kept', description: 'kept too', input: { hint: 'hint kept' } },
      { name: 'no-description' },
      { description: 'no-name' },
      'not a row',
      { name: 1, description: 'wrong type' },
      { name: 'bad-hint', description: 'hint not a string', input: { hint: 1 } },
    ],
  })
  assert.deepEqual(catalog, {
    skills: [{ name: 'good', description: 'kept' }],
    commands: [
      { name: 'kept', description: 'kept too', argumentHint: 'hint kept' },
      { name: 'bad-hint', description: 'hint not a string' },
    ],
  })
})

test('row and field caps hold for both sections', async () => {
  const catalog = await catalogOf({
    skills: {
      list: async () =>
        Array.from({ length: MAX_CATALOG_SKILLS + 3 }, (_, index) => ({
          name: `s${String(index)}`,
          description: 'd'.repeat(MAX_CATALOG_DESCRIPTION + 5),
        })),
    },
    commands: Array.from({ length: MAX_CATALOG_COMMANDS + 3 }, (_, index) => ({
      name: `c${String(index)}`,
      description: 'd'.repeat(MAX_CATALOG_DESCRIPTION + 5),
      input: { hint: 'h'.repeat(MAX_CATALOG_ARGUMENT_HINT + 5) },
    })),
  })
  assert.equal(catalog.skills.length, MAX_CATALOG_SKILLS)
  assert.equal(catalog.skills[0]?.description.length, MAX_CATALOG_DESCRIPTION)
  assert.equal(catalog.commands.length, MAX_CATALOG_COMMANDS)
  assert.equal(catalog.commands[0]?.description.length, MAX_CATALOG_DESCRIPTION)
  assert.equal(catalog.commands[0]?.argumentHint?.length, MAX_CATALOG_ARGUMENT_HINT)
})

test('a name that cannot be a key drops its row', async () => {
  const catalog = await catalogOf({
    skills: {
      list: async () => [
        { name: 'good', description: 'kept' },
        { name: 'n'.repeat(MAX_CATALOG_NAME + 1), description: 'over the name cap' },
        { name: 'esc\u001b[31m', description: 'control bytes' },
        { name: '', description: 'empty' },
      ],
    },
    commands: [
      { name: 'good', description: 'kept' },
      { name: 'n'.repeat(MAX_CATALOG_NAME + 1), description: 'over the name cap' },
      { name: 'esc\u001b[31m', description: 'control bytes' },
      { name: '', description: 'empty' },
    ],
  })
  assert.deepEqual(catalog, {
    skills: [{ name: 'good', description: 'kept' }],
    commands: [{ name: 'good', description: 'kept' }],
  })
})

test('a cap-max catalog is byte-budgeted to a frame the codec accepts', async () => {
  for (const fill of ['d', '漢']) {
    const build = async (): Promise<Awaited<ReturnType<typeof catalogOf>>> => catalogOf({
      skills: {
        list: async () =>
          Array.from({ length: MAX_CATALOG_SKILLS + 10 }, (_, index) => ({
            name: `s${String(index)}`,
            description: fill.repeat(MAX_CATALOG_DESCRIPTION),
          })),
      },
      commands: Array.from({ length: MAX_CATALOG_COMMANDS + 10 }, (_, index) => ({
        name: `c${String(index)}`,
        description: fill.repeat(MAX_CATALOG_DESCRIPTION),
      })),
    })
    const first = await build()
    const second = await build()
    assert.deepEqual(first, second, 'trimming is deterministic')
    const line = encodeFrame({ t: 'catalog', skills: first.skills, commands: first.commands })
    assert.ok(Buffer.byteLength(line, 'utf8') <= MAX_FRAME, `${fill === '漢' ? 'multibyte' : 'ASCII'} fits`)
    assert.equal(decodeChunk('', line).ok, true, 'the trimmed catalog still decodes')
    assert.ok(first.skills.length <= MAX_CATALOG_SKILLS)
    assert.ok(first.commands.length <= MAX_CATALOG_COMMANDS)
    // Commands are the smaller section, so they shrink first and the menu keeps
    // the skills it can; the head of both lists survives.
    assert.ok(first.skills.length > 0)
    assert.equal(first.skills[0]?.name, 's0')
    if (first.commands.length > 0) assert.equal(first.commands[0]?.name, 'c0')
  }
})
