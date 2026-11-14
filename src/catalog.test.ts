/**
 * Catalog assembly: both host services become one menu payload, and a missing,
 * mistyped or throwing service contributes an empty section instead of a fault.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_CATALOG_ARGUMENT_HINT,
  MAX_CATALOG_COMMANDS,
  MAX_CATALOG_DESCRIPTION,
  MAX_CATALOG_NAME,
  MAX_CATALOG_SKILLS,
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

test('the caps trim sections and fields instead of dropping the menu', async () => {
  const catalog = await catalogOf({
    skills: {
      list: async () =>
        Array.from({ length: MAX_CATALOG_SKILLS + 3 }, (_, index) => ({
          name: 's'.repeat(MAX_CATALOG_NAME + 5),
          description: 'd'.repeat(MAX_CATALOG_DESCRIPTION + 5),
        })).map((row, index) => ({ ...row, name: `${String(index)}${row.name}` })),
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
  assert.equal(catalog.skills[0]?.name.length, MAX_CATALOG_NAME)
  assert.equal(catalog.skills[0]?.description.length, MAX_CATALOG_DESCRIPTION)
  assert.equal(catalog.commands.length, MAX_CATALOG_COMMANDS)
  assert.equal(catalog.commands[0]?.argumentHint?.length, MAX_CATALOG_ARGUMENT_HINT)
})
