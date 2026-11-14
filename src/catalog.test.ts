/**
 * Catalog assembly: both host services become one menu payload, and a missing,
 * mistyped or throwing service contributes an empty section instead of a fault.
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

test('both services become the menu with their descriptions and input hints', async () => {
  const agent = { id: 'session-1' }
  let listedFor: unknown
  const catalog = await catalogOf({
    skills: {
      list: async () => [{ name: 'use-dsh-sup', description: 'drive the terminal' }],
    },
    commands: {
      list: (who: unknown) => {
        listedFor = who
        return [
          { name: 'compact', description: 'shrink the context', input: { hint: '<focus>', attachments: true } },
          { name: 'status', description: 'show usage' },
        ]
      },
    },
    agent,
  })
  assert.deepEqual(catalog.skills, [{ name: 'use-dsh-sup', description: 'drive the terminal' }])
  assert.deepEqual(catalog.commands, [
    { name: 'compact', description: 'shrink the context', argumentHint: '<focus>' },
    { name: 'status', description: 'show usage' },
  ])
  assert.equal(listedFor, agent, 'commands are listed for the viewing agent')
})

test('each service that is absent contributes an empty section', async () => {
  assert.deepEqual(await catalogOf({ skills: undefined, commands: undefined, agent: {} }), {
    skills: [],
    commands: [],
  })
  assert.deepEqual(await catalogOf({ skills: { list: async () => [] }, commands: undefined, agent: {} }), {
    skills: [],
    commands: [],
  })
})

test('a throwing or mistyped service is an empty section, never a rejection', async () => {
  const catalog = await catalogOf({
    skills: { list: async () => { throw new Error('skills down') } },
    commands: {
      list: () => {
        throw new Error('commands down')
      },
    },
    agent: {},
  })
  assert.deepEqual(catalog, { skills: [], commands: [] })
  assert.deepEqual(await catalogOf({ skills: { list: 1 }, commands: 'nope', agent: {} }), {
    skills: [],
    commands: [],
  })
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
    commands: {
      list: () => [{ name: 'good', description: 'kept', input: { hint: 7 } }, null],
    },
    agent: {},
  })
  assert.deepEqual(catalog.skills, [{ name: 'good', description: 'kept' }])
  assert.deepEqual(catalog.commands, [{ name: 'good', description: 'kept' }])
})

test('row and field caps hold', async () => {
  const catalog = await catalogOf({
    skills: {
      list: async () =>
        Array.from({ length: MAX_CATALOG_SKILLS + 3 }, (_, index) => ({
          name: `s${String(index)}`,
          description: 'd'.repeat(MAX_CATALOG_DESCRIPTION + 5),
        })),
    },
    commands: {
      list: () =>
        Array.from({ length: MAX_CATALOG_COMMANDS + 3 }, (_, index) => ({
          name: `c${String(index)}`,
          description: 'short',
          input: { hint: 'h'.repeat(MAX_CATALOG_ARGUMENT_HINT + 5) },
        })),
    },
    agent: {},
  })
  assert.equal(catalog.skills.length, MAX_CATALOG_SKILLS)
  assert.equal(catalog.skills[0]?.description.length, MAX_CATALOG_DESCRIPTION)
  assert.equal(catalog.commands.length, MAX_CATALOG_COMMANDS)
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
    commands: { list: () => [{ name: 'ok', description: 'kept' }] },
    agent: {},
  })
  assert.deepEqual(catalog.skills, [{ name: 'good', description: 'kept' }])
  assert.deepEqual(catalog.commands, [{ name: 'ok', description: 'kept' }])
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
      commands: {
        list: () =>
          Array.from({ length: MAX_CATALOG_COMMANDS + 10 }, (_, index) => ({
            name: `c${String(index)}`,
            description: fill.repeat(MAX_CATALOG_DESCRIPTION),
            input: { hint: fill.repeat(MAX_CATALOG_ARGUMENT_HINT) },
          })),
      },
      agent: {},
    })
    const first = await build()
    const second = await build()
    assert.deepEqual(first, second, 'trimming is deterministic')
    const line = encodeFrame({ t: 'catalog', skills: first.skills, commands: first.commands })
    assert.ok(Buffer.byteLength(line, 'utf8') <= MAX_FRAME, `${fill === '漢' ? 'multibyte' : 'ASCII'} fits`)
    assert.equal(decodeChunk('', line).ok, true, 'the trimmed catalog still decodes')
    assert.ok(first.skills.length <= MAX_CATALOG_SKILLS)
    assert.ok(first.commands.length <= MAX_CATALOG_COMMANDS)
    assert.ok(first.skills.length > 0 || first.commands.length > 0)
  }
})
