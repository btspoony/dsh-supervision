import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRIDGED_ATTR, bridgedIds, coalescer, paint, rowSessionId, STYLE, watch } from './dom.js'
import { apply } from './index.js'
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

test('the churn coalescer runs a burst once per window', async () => {
  let runs = 0
  const churn = coalescer(() => { runs += 1 }, 5)
  churn.schedule()
  churn.schedule()
  churn.schedule()
  assert.equal(runs, 0, 'the burst waits for the quiet period')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(runs, 1, 'three rapid mutations paint exactly once')
  churn.schedule()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(runs, 2, 'a later quiet burst paints again')
  churn.cancel()
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
  assert.ok(!STYLE.includes('#' + GUARD_ID + '::after'), 'no top-right decoration may remain')
  assert.ok(!STYLE.includes('#' + GUARD_ID + '::before'), 'the guard tail lives in the badge now')
  const copy = ruleBlock('#' + GUARD_ID + ' > .' + COPY_CLASS)
  assert.match(copy, /position:\s*absolute/, 'the caption hangs on the frame')
  assert.match(copy, /left:\s*50%/)
  assert.match(copy, /top:\s*0/)
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
  assert.match(badge, /border-radius:\s*0 8px 0 calc\(var\(--dsh-sup-radius, 16px\) - 3px\)/, 'bottom-left follows the card inner radius')
  assert.match(badge, /z-index:\s*1/)
  assert.match(badge, /pointer-events:\s*none/)
  assert.match(badge, /padding:\s*3px 10px 3px 24px/, 'room on the left for the tail')
  const badgeTail = ruleBlock('#' + GUARD_ID + ' > .' + BADGE_CLASS + '::before')
  assert.match(badgeTail, /content:\s*''/)
  assert.match(badgeTail, /position:\s*absolute/)
  assert.match(badgeTail, /left:\s*7px/)
  assert.match(badgeTail, /top:\s*50%/)
  assert.match(badgeTail, /translate:\s*0 -50%/)
  assert.match(badgeTail, /width:\s*14px/)
  assert.match(badgeTail, /height:\s*14px/)
  assert.match(badgeTail, /background:\s*#fff/, 'the badge tail is white on the blue pill')
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
})

/* ------------------------------------------------------------------------ */
/* A minimal fake DOM: only what paint/syncGuard touch. Behavior tests for  */
/* the guard (review T1/S1) run in node against these stubs.                */
/* ------------------------------------------------------------------------ */

class FakeEl {
  tagName: string
  id = ''
  className = ''
  type = ''
  textContent = ''
  children: FakeEl[] = []
  parentEl: FakeEl | null = null
  attrs = new Map<string, string>()
  style: Record<string, string> & { setProperty?: (name: string, value: string) => void } = {}

  constructor(tagName: string) {
    this.tagName = tagName
    const style = {} as Record<string, string> & { setProperty: (name: string, value: string) => void }
    style.setProperty = (name: string, value: string): void => {
      style[name] = value
    }
    this.style = style
  }
  private listeners = new Map<string, Array<() => void>>()

  get parentElement(): FakeEl | null {
    return this.parentEl
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }

  append(...els: FakeEl[]): void {
    for (const el of els) {
      el.parentEl = this
      this.children.push(el)
    }
  }

  replaceChildren(...els: FakeEl[]): void {
    this.children = []
    this.append(...els)
  }

  remove(): void {
    if (this.parentEl !== null) {
      const index = this.parentEl.children.indexOf(this)
      if (index >= 0) this.parentEl.children.splice(index, 1)
      this.parentEl = null
    }
  }

  contains(other: FakeEl): boolean {
    let cur: FakeEl | null = other
    while (cur !== null) {
      if (cur === this) return true
      cur = cur.parentEl
    }
    return false
  }

  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1)
    const attr = /^\[([\w-]+)(?:="([\w-]+)")?\]$/.exec(selector)
    if (attr !== null && attr[1] !== undefined) {
      const value = attr[2]
      return value === undefined ? this.hasAttribute(attr[1]) : this.getAttribute(attr[1]) === value
    }
    const tag = /^(\w+)(?:\.([\w-]+))?$/.exec(selector)
    if (tag !== null && tag[1] !== undefined) {
      if (this.tagName !== tag[1]) return false
      return tag[2] === undefined || this.className.split(' ').includes(tag[2])
    }
    return false
  }

  closest(selector: string): FakeEl | null {
    let cur: FakeEl | null = this
    while (cur !== null) {
      if (cur.matches(selector)) return cur
      cur = cur.parentEl
    }
    return null
  }

  querySelectorAll(selector: string): FakeEl[] {
    const out: FakeEl[] = []
    const walk = (el: FakeEl): void => {
      for (const child of el.children) {
        if (child.matches(selector)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }

  querySelector(selector: string): FakeEl | null {
    if (selector.startsWith(':scope > ')) {
      const inner = selector.slice(':scope > '.length)
      return this.children.find(child => child.matches(inner)) ?? null
    }
    return this.querySelectorAll(selector)[0] ?? null
  }
}

class FakeDoc {
  root = new FakeEl('root')
  head = new FakeEl('head')
  body: FakeEl
  listenerCount = 0

  constructor() {
    this.body = this.root
    this.root.append(this.head)
  }

  addEventListener(): void {
    this.listenerCount += 1
  }

  removeEventListener(): void {
    this.listenerCount -= 1
  }

  createElement(tagName: string): FakeEl {
    return new FakeEl(tagName)
  }

  createTextNode(text: string): FakeEl {
    const node = new FakeEl('#text')
    node.textContent = text
    return node
  }

  getElementById(id: string): FakeEl | null {
    return this.root.querySelector('#' + id)
  }

  querySelector(selector: string): FakeEl | null {
    return this.root.querySelector(selector)
  }

  querySelectorAll(selector: string): FakeEl[] {
    return this.root.querySelectorAll(selector)
  }
}

const t = (key: string): string => en[key as keyof typeof en]

/** One composer inside a composer card, plus two session rows. */
function bridgedScene(): { doc: FakeDoc; card: FakeEl; host: FakeEl; composer: FakeEl; rowA: FakeEl; rowB: FakeEl } {
  const doc = new FakeDoc()
  const composer = new FakeEl('div')
  composer.setAttribute('contenteditable', 'true')
  const host = new FakeEl('div')
  host.append(composer)
  const card = new FakeEl('div')
  card.setAttribute('data-composer-card', '')
  card.append(host)
  const rowA = new FakeEl('div')
  rowA.setAttribute('data-row-key', 'session:session-a')
  rowA.setAttribute('aria-selected', 'true')
  const rowB = new FakeEl('div')
  rowB.setAttribute('data-row-key', 'session:session-b')
  doc.root.append(card, rowA, rowB)
  return { doc, card, host, composer, rowA, rowB }
}

function withFakeDom(run: () => void): void {
  const g = globalThis as Record<string, unknown>
  const prev = { document: g.document, MutationObserver: g.MutationObserver, getComputedStyle: g.getComputedStyle }
  g.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
  g.getComputedStyle = (): { borderRadius: string } => ({ borderRadius: '16px' })
  try {
    run()
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete g[key]
      else g[key] = value
    }
  }
}

test('a bridged composer is covered by one guard under the card, and Unlock reclaims it', () => {
  withFakeDom(() => {
    const { doc, card, host, composer } = bridgedScene()
    const reclaimed: string[] = []
    const take = (session: string): Promise<boolean> => {
      reclaimed.push(session)
      return new Promise(() => {})
    }
    paint(doc as unknown as Document, new Set(['session-a']), t, take)
    const guard = doc.getElementById(GUARD_ID)
    assert.ok(guard !== null, 'the guard mounts')
    assert.equal(guard.parentEl, card, 'the guard sits under the composer card')
    assert.equal(guard.style['--dsh-sup-radius'], '16px', 'seatGuard publishes the card radius for the badge')
    assert.ok(host.hasAttribute('inert'), 'the editor subtree is inert')
    const buttons = guard.querySelectorAll('button')
    assert.equal(buttons.length, 1, 'exactly one reclaim control')
    assert.equal(buttons[0]?.textContent, en.unlock)
    buttons[0]?.dispatch('click')
    assert.deepEqual(reclaimed, ['session-a'], 'the click reclaims the covered session')
  })
})

test('a card that is the editor parent still covers it, with the guard outside the inert subtree', () => {
  withFakeDom(() => {
    const doc = new FakeDoc()
    const composer = new FakeEl('div')
    composer.setAttribute('contenteditable', 'true')
    const card = new FakeEl('div')
    card.setAttribute('data-composer-card', '')
    card.append(composer)
    const row = new FakeEl('div')
    row.setAttribute('data-row-key', 'session:session-a')
    row.setAttribute('aria-selected', 'true')
    doc.root.append(card, row)
    const reclaimed: string[] = []
    const take = (session: string): Promise<boolean> => {
      reclaimed.push(session)
      return new Promise(() => {})
    }
    paint(doc as unknown as Document, new Set(['session-a']), t, take)
    const guard = doc.getElementById(GUARD_ID)
    assert.ok(guard !== null, 'the composer is always covered when bridged')
    assert.equal(guard.parentEl, doc.root, 'the guard mounts on the nearest strict ancestor, not the inert card')
    assert.ok(!card.contains(guard), 'the guard stays outside the inert subtree')
    assert.ok(card.hasAttribute('inert'), 'the editor subtree is inert')
    assert.equal(guard.querySelector('span.' + COPY_CLASS)?.textContent, en.caption)
    assert.equal(guard.querySelector('span.' + BADGE_CLASS)?.textContent, en.badge)
    assert.equal(guard.querySelectorAll('button').length, 1, 'exactly one reclaim control')
    guard.querySelector('button')?.dispatch('click')
    assert.deepEqual(reclaimed, ['session-a'], 'Unlock stays clickable outside the inert subtree')
  })
})

/** Run a test body with the fake DOM globals installed, awaiting it first. */
async function withFakeDomAsync(run: () => Promise<void>): Promise<void> {
  const g = globalThis as Record<string, unknown>
  const prev = { document: g.document, MutationObserver: g.MutationObserver, getComputedStyle: g.getComputedStyle, fetch: g.fetch }
  g.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
  g.getComputedStyle = (): { borderRadius: string } => ({ borderRadius: '16px' })
  try {
    await run()
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete g[key]
      else g[key] = value
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('a successful Unlock drops the session from the cache so a later repaint stays uncovered', async () => {
  await withFakeDomAsync(async () => {
    const g = globalThis as Record<string, unknown>
    const observers: Array<(records: Array<{ target: unknown }>) => void> = []
    g.MutationObserver = class {
      constructor(cb: (records: Array<{ target: unknown }>) => void) {
        observers.push(cb)
      }
      observe(): void {}
      disconnect(): void {}
    }
    g.fetch = async (url: string | URL): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
      if (String(url).includes('reclaim')) return { ok: true, status: 200, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ proto: 1, sessions: { 'session-a': { bridged: true, terminal: 'dsh-sup', pid: 81773, since: 2, asks: [] } } }) }
    }
    const scene = bridgedScene()
    const doc = scene.doc
    g.document = doc
    const stop = watch(doc as unknown as Document, t)
    try {
      await sleep(20)
      const guard = doc.getElementById(GUARD_ID)
      assert.ok(guard !== null, 'the guard mounts from the poll')
      guard.querySelector('button')?.dispatch('click')
      await sleep(20)
      assert.equal(doc.getElementById(GUARD_ID), null, 'a confirmed reclaim removes the guard')
      observers[0]?.([{ target: scene.rowA }])
      await sleep(20)
      assert.equal(doc.getElementById(GUARD_ID), null, 'the stale cache does not re-cover the composer')
    } finally {
      stop()
    }
  })
})

test('the churn observer ignores guard-internal mutations and schedules outside ones', async () => {
  await withFakeDomAsync(async () => {
    const g = globalThis as Record<string, unknown>
    const observers: Array<(records: Array<{ target: unknown }>) => void> = []
    g.MutationObserver = class {
      constructor(cb: (records: Array<{ target: unknown }>) => void) {
        observers.push(cb)
      }
      observe(): void {}
      disconnect(): void {}
    }
    g.fetch = async (): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> =>
      ({ ok: true, status: 200, json: async () => ({ proto: 1, sessions: { 'session-a': { bridged: true, terminal: 'dsh-sup', pid: 81773, since: 2, asks: [] } } }) })
    const scene = bridgedScene()
    const doc = scene.doc
    g.document = doc
    let draws = 0
    const draw = (...args: Parameters<typeof paint>): void => {
      draws += 1
      paint(...args)
    }
    const stop = watch(doc as unknown as Document, t, draw)
    try {
      await sleep(20)
      const guard = doc.getElementById(GUARD_ID)
      assert.ok(guard !== null && draws >= 1)
      const rowA = scene.rowA
      const churnCallback = observers[1]
      assert.ok(typeof churnCallback === 'function', 'the second observer watches churn')
      const before = draws
      churnCallback([{ target: guard }])
      churnCallback([{ target: guard.querySelector('span.' + COPY_CLASS) }])
      await sleep(150)
      assert.equal(draws, before, 'guard-internal mutations repaint nothing')
      churnCallback([{ target: rowA }])
      await sleep(150)
      assert.equal(draws, before + 1, 'an outside mutation schedules exactly one repaint')
    } finally {
      stop()
    }
  })
})

test('after a retarget the same guard reclaims the newly selected session', () => {
  withFakeDom(() => {
    const { doc, rowA, rowB } = bridgedScene()
    const reclaimed: string[] = []
    const take = (session: string): Promise<boolean> => {
      reclaimed.push(session)
      return new Promise(() => {})
    }
    paint(doc as unknown as Document, new Set(['session-a', 'session-b']), t, take)
    rowA.setAttribute('aria-selected', 'false')
    rowB.setAttribute('aria-selected', 'true')
    paint(doc as unknown as Document, new Set(['session-a', 'session-b']), t, take)
    const guard = doc.getElementById(GUARD_ID)
    assert.ok(guard !== null)
    assert.equal(guard.querySelectorAll('button').length, 1, 'retarget keeps a single control')
    guard.querySelector('button')?.dispatch('click')
    assert.deepEqual(reclaimed, ['session-b'], 'Unlock reclaims the session selected now')
  })
})

test('apply owns the watch and locale registrations through the host effect scope', () => {
  withFakeDom(() => {
    const g = globalThis as Record<string, unknown>
    g.document = new FakeDoc()
    const registrations: Array<{ run: () => () => void; label: string }> = []
    const registered: string[] = []
    const fakeLocale = {
      register: (namespace: string): (() => void) => {
        registered.push(namespace)
        return () => {}
      },
      bind: (): typeof t => t,
    }
    const ctx = {
      effect: (run: () => () => void, label: string): void => {
        registrations.push({ run, label })
      },
      get: (name: string): unknown => (name === 'locale' ? fakeLocale : undefined),
    }
    apply(ctx)
    apply(ctx)
    const labels = registrations.map(registration => registration.label)
    assert.equal(labels.filter(label => label === 'dsh-supervision: locale').length, 2, 'dictionary registration is effect-owned')
    assert.equal(labels.filter(label => label === 'dsh-supervision: watch').length, 2, 'each apply offers its watch; the host scope owns disposal by label')
    const stops = registrations.map(registration => registration.run())
    for (const stop of stops) assert.equal(typeof stop, 'function', 'every registration disposes')
    assert.deepEqual(registered, ['supervision', 'supervision'], 'running the effects registers the dictionaries reflectively')
    for (const stop of stops) stop()
  })
})
