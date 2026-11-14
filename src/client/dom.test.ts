import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRIDGED_ATTR, bridgedIds, rowSessionId, STYLE } from './dom.js'
import { BADGE_CLASS, COPY_CLASS, GUARD_ID, guardFor } from './dom.guard.js'
import { en, zh } from './locale.js'

test('a sidebar row key yields its session id', () => {
  assert.equal(rowSessionId('session:session-abc'), 'session-abc')
  assert.equal(rowSessionId('workspace:b002f50e'), undefined, 'a workspace row is not a session')
  assert.equal(rowSessionId('session:'), undefined, 'an empty id is no target')
  assert.equal(rowSessionId(null), undefined)
})

test('bridged ids come straight from the state payload', () => {
  assert.deepEqual([...bridgedIds(undefined)], [])
  assert.deepEqual(
    [...bridgedIds({
      proto: 1,
      sessions: {
        'session-a': { bridged: true, terminal: 't1', pid: 1, since: 2, asks: [] },
        'session-b': { bridged: true, terminal: 't1', pid: 1, since: 2, asks: [] },
      },
    })],
    ['session-a', 'session-b'],
  )
})

test('the guard covers exactly a bridged selected session', () => {
  const ids = new Set(['session-a'])
  assert.equal(guardFor(ids, 'session-a'), true)
  assert.equal(guardFor(ids, 'session-b'), false)
  assert.equal(guardFor(ids, undefined), false, 'no selection means no composer to cover')
})

test('the locale dictionaries carry every guard string in en and zh', () => {
  for (const key of ['caption', 'badge', 'unlock'] as const) {
    assert.ok(en[key].length > 0, 'en ' + key)
    assert.ok(zh[key].length > 0, 'zh ' + key)
    assert.notEqual(zh[key], en[key], 'zh ' + key + ' is translated, not copied')
  }
})

test('the bridged row wears a 3px ring on the host radius token', () => {
  assert.ok(STYLE.includes('border-radius: var(--dsw-radius-md, 12px) !important'))
  assert.ok(STYLE.includes('border-color: #3b6cf5 !important'))
  assert.ok(STYLE.includes('border-block: 3px solid #3b6cf5 !important'))
  assert.ok(STYLE.includes('padding-right: 40px !important'))
  assert.ok(
    STYLE.includes('background-color: rgba(127, 174, 255, 0.30) !important'),
    'the row fill is the shared light blue at 30% alpha',
  )
})

/** The declaration block of one rule, so assertions read the right layer only. */
function ruleBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = STYLE.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'))
  assert.ok(match, 'expected a ' + selector + ' rule')
  return match[1] ?? ''
}

test('the capsule fills the row under its APNG tail, with no synthesized sway', () => {
  const capsule = ruleBlock('[' + BRIDGED_ATTR + ']::after')
  assert.match(capsule, /top:\s*0/)
  assert.match(capsule, /bottom:\s*0/)
  assert.match(capsule, /right:\s*0/)
  assert.match(capsule, /width:\s*40px/)
  assert.match(capsule, /border-radius:\s*0 calc\(var\(--dsw-radius-md, 12px\) - 3px\) calc\(var\(--dsw-radius-md, 12px\) - 3px\) 0/, 'left square, right follows the row border')
  assert.match(capsule, /z-index:\s*0/, 'the capsule paints below its tail')
  const tail = ruleBlock('[' + BRIDGED_ATTR + ']::before')
  assert.match(tail, /z-index:\s*1/, 'the tail paints above its capsule')
  assert.match(tail, /width:\s*40px/)
  assert.match(tail, /mask:[^;]*center \/ 18px 18px/, 'the tail silhouette is mask-sized')
  const apngMasks = STYLE.match(/^ *mask: url\("[^"]*running-whale/gm) ?? []
  assert.equal(apngMasks.length, 2, 'sidebar and guard tails both animate via the APNG mask')
  assert.ok(!STYLE.includes('dsh-sup-sway'), 'the APNG frames own the wag; no CSS rotate may remain')
  assert.ok(!STYLE.includes('rotate:'), 'no synthesized rotation anywhere')
})

test('the guard covers the input card and the page has one reclaim control', () => {
  const pane = ruleBlock('#' + GUARD_ID)
  assert.match(pane, /position:\s*absolute/, 'the guard overlays the card, never pushes it')
  assert.match(pane, /inset:\s*0/)
  assert.match(pane, /z-index:\s*40/)
  assert.doesNotMatch(pane, /display:\s*grid/, 'no grid: everything hangs absolute')
  assert.match(pane, /padding:\s*24px;/)
  assert.ok(
    STYLE.includes('background: rgba(127, 174, 255, 0.30);'),
    'the guard fill is the same shared light blue, flat',
  )
  assert.doesNotMatch(pane, /linear-gradient/, 'the pane itself has no gradient')
  assert.doesNotMatch(pane, /overflow:\s*hidden/, 'the caption tab hangs outside the top edge')
  assert.ok(!STYLE.includes('rgba(2, 6, 16'), 'the dark bottom band is gone entirely')
  const square = ruleBlock('#' + GUARD_ID + '::after')
  assert.match(square, /position:\s*absolute/)
  assert.match(square, /top:\s*0/)
  assert.match(square, /right:\s*0/)
  assert.match(square, /width:\s*32px/)
  assert.match(square, /height:\s*32px/)
  assert.match(square, /background:\s*#3b6cf5/)
  assert.match(square, /border-radius:\s*0 8px 0 8px/, 'top-right and bottom-left rounded')
  assert.match(square, /z-index:\s*0/)
  const tail = ruleBlock('#' + GUARD_ID + '::before')
  assert.match(tail, /position:\s*absolute/)
  assert.match(tail, /top:\s*0/)
  assert.match(tail, /right:\s*0/)
  assert.match(tail, /width:\s*32px/)
  assert.doesNotMatch(tail, /width:\s*52px/, 'the large left tail is gone')
  assert.match(tail, /background:\s*#fff/, 'the badge tail is white on the blue square')
  assert.match(tail, /z-index:\s*1/)
  assert.match(tail, /mask:[^;]*center \/ 15px 15px/, 'the tail sits at the host base size')
  const copy = ruleBlock('#' + GUARD_ID + ' > .' + COPY_CLASS)
  assert.match(copy, /position:\s*absolute/, 'the caption hangs on the frame')
  assert.match(copy, /left:\s*50%/)
  assert.match(copy, /top:\s*-3px/)
  assert.match(copy, /transform:\s*translate\(-50%, -100%\)/, 'the tab sits fully above the top edge')
  assert.match(copy, /background:\s*#3b6cf5/)
  assert.match(copy, /color:\s*#fff/)
  assert.match(copy, /border-radius:\s*8px 8px 0 0/, 'a tab: rounded on top, square at the frame')
  assert.match(copy, /padding:\s*3px 12px/)
  assert.match(copy, /font-size:\s*11px/)
  assert.match(copy, /line-height:\s*16px/)
  assert.match(copy, /white-space:\s*nowrap/)
  assert.match(copy, /z-index:\s*2/, 'the tab paints above badge and button')
  const badge = ruleBlock('#' + GUARD_ID + ' > .' + BADGE_CLASS)
  assert.match(badge, /position:\s*absolute/)
  assert.match(badge, /left:\s*0/)
  assert.match(badge, /bottom:\s*0/, 'the badge hugs the overlay bottom-left corner')
  assert.match(badge, /background:\s*#3b6cf5/)
  assert.match(badge, /color:\s*#fff/)
  assert.match(badge, /border-radius:\s*0 8px 0 8px/, 'top-left/bottom-right square, the others rounded')
  assert.match(badge, /z-index:\s*1/)
  assert.match(badge, /pointer-events:\s*none/)
  const button = ruleBlock('#' + GUARD_ID + ' button')
  assert.match(button, /position:\s*absolute/)
  assert.match(button, /left:\s*50%/)
  assert.match(button, /top:\s*50%/)
  assert.match(button, /transform:\s*translate\(-50%, -50%\)/, 'Unlock is centered on both axes')
  assert.doesNotMatch(button, /flex:\s*1/)
  assert.match(button, /min-height:\s*36px/)
  assert.match(button, /transition:\s*background-color \.15s ease/)
  const hover = ruleBlock('#' + GUARD_ID + ' button:hover')
  assert.match(hover, /background:\s*#5b86ff/, 'hover lifts to the lighter fill')
  assert.match(hover, /calc\(-50% - 1px\)/, 'the lift keeps the centering')
  const active = ruleBlock('#' + GUARD_ID + ' button:active')
  assert.match(active, /background:\s*#3b6cf5/, 'active returns to the base fill')
  assert.match(active, /transform:\s*translate\(-50%, -50%\)/, 'active resets the hover lift')
  const focused = ruleBlock('#' + GUARD_ID + ' button:focus-visible')
  assert.match(focused, /outline:\s*2px solid rgba\(255, 255, 255, \.75\)/)
  const buttons = STYLE.match(new RegExp('#' + GUARD_ID + ' button\\s*\\{', 'g')) ?? []
  assert.equal(buttons.length, 1, 'exactly one reclaim control may exist')
  const guardSource = readFileSync(new URL('../../src/client/dom.guard.ts', import.meta.url), 'utf8')
  const created = guardSource.match(/createElement\('button'\)/g) ?? []
  assert.equal(created.length, 1, 'the guard builds exactly one button node; a second DOM control fails here')
  const badges = guardSource.match(/className = BADGE_CLASS/g) ?? []
  assert.equal(badges.length, 1, 'the guard builds exactly one badge node')
  for (const call of ["t('caption')", "t('badge')", "t('unlock')"]) {
    assert.ok(guardSource.includes(call), 'the guard renders ' + call + ' through the translator')
  }
})
