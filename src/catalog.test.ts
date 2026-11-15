/**
 * Catalog assembly: the host's skill service becomes the menu payload, and a
 * missing, mistyped or throwing service contributes an empty section instead of
 * a fault. Host commands are never collected, so the wire field stays empty.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeChunk,
  encodeFrame,
  MAX_CATALOG_DESCRIPTION,
  MAX_CATALOG_NAME,
  MAX_CATALOG_SKILLS,
  MAX_FRAME,
} from 'dsh-supervision-protocol'
import { catalogOf } from './catalog.js'

test('the skill service becomes the menu, and commands stay empty', async () => {
  const catalog = await catalogOf({
    skills: { list: async () => [{ name: 'use-dsh-sup', description: 'drive the terminal' }] },
  })
  assert.deepEqual(catalog, {
    skills: [{ name: 'use-dsh-sup', description: 'drive the terminal' }],
    commands: [],
  })
})

test('an absent service contributes an empty menu', async () => {
  assert.deepEqual(await catalogOf({ skills: undefined }), { skills: [], commands: [] })
  assert.deepEqual(await catalogOf({ skills: { list: async () => [] } }), { skills: [], commands: [] })
})

test('a throwing or mistyped service is an empty menu, never a rejection', async () => {
  assert.deepEqual(await catalogOf({ skills: { list: async () => { throw new Error('skills down') } } }), {
    skills: [],
    commands: [],
  })
  assert.deepEqual(await catalogOf({ skills: { list: 1 } }), { skills: [], commands: [] })
  assert.deepEqual(await catalogOf({ skills: 'nope' }), { skills: [], commands: [] })
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
  })
  assert.deepEqual(catalog, { skills: [{ name: 'good', description: 'kept' }], commands: [] })
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
  })
  assert.equal(catalog.skills.length, MAX_CATALOG_SKILLS)
  assert.equal(catalog.skills[0]?.description.length, MAX_CATALOG_DESCRIPTION)
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
  })
  assert.deepEqual(catalog, { skills: [{ name: 'good', description: 'kept' }], commands: [] })
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
    })
    const first = await build()
    const second = await build()
    assert.deepEqual(first, second, 'trimming is deterministic')
    const line = encodeFrame({ t: 'catalog', skills: first.skills, commands: first.commands })
    assert.ok(Buffer.byteLength(line, 'utf8') <= MAX_FRAME, `${fill === '漢' ? 'multibyte' : 'ASCII'} fits`)
    assert.equal(decodeChunk('', line).ok, true, 'the trimmed catalog still decodes')
    assert.ok(first.skills.length <= MAX_CATALOG_SKILLS)
    assert.ok(first.skills.length > 0)
  }
})
