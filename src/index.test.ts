/**
 * Plugin wiring: the activation gate, the hello shapes, and the reports a
 * bridge receives. The host is a fake — this package cannot depend on DSH —
 * so the test drives exactly the seam `apply` declares.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { after, test } from 'node:test'
import { DEFAULTS, apply, validateConfig } from './index.js'
import type { Config, PluginContext, SessionEvent } from './index.js'
import { PROTO, readRegistry } from 'dsh-supervision-protocol'
import type { InFrame, OutFrame } from 'dsh-supervision-protocol'

const roots: string[] = []
/** Every client this file opened; a dangling socket would keep the runner alive. */
const clients: Client[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-supervision-plugin-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const client of clients) client.socket.destroy()
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

interface FakeAgent {
  id: string
  status: 'idle' | 'running'
  session: { id: string; header: { cwd?: string } }
}

/** A host context whose agents are in-memory and whose events the test emits. */
class FakeHost {
  readonly agents: FakeAgent[] = []
  readonly created: string[] = []
  readonly resumed: string[] = []
  readonly #sessionListeners = new Set<(session: { id: string }, event: SessionEvent) => void>()
  readonly #statusListeners = new Set<(payload: { agent: FakeAgent; status: 'idle' | 'running' }) => void>()
  #disposer: (() => void) | undefined

  readonly ctx: PluginContext = {
    agents: {
      get: (id: string) => this.agents.find(agent => agent.id === id),
      list: () => this.agents,
      create: async ({ sessionId, meta }) => {
        this.created.push(sessionId)
        return { agent: this.add(sessionId, meta.cwd) }
      },
      resume: async ({ resumeSessionId }) => {
        this.resumed.push(resumeSessionId)
        return { agent: this.add(resumeSessionId, '/repo/resumed') }
      },
    },
    on: ((name: string, listener: never) => {
      const set = name === 'session/event' ? this.#sessionListeners : this.#statusListeners
      set.add(listener)
      return () => { set.delete(listener) }
    }) as PluginContext['on'],
    effect: setup => { this.#disposer = setup() },
  }

  /** Register an agent without going through `apply`. */
  add(id: string, cwd: string): FakeAgent {
    const agent: FakeAgent = { id, status: 'idle', session: { id, header: { cwd } } }
    this.agents.push(agent)
    return agent
  }

  emit(session: string, event: SessionEvent): void {
    for (const listener of this.#sessionListeners) listener({ id: session }, event)
  }

  /** @returns how many listeners the plugin still holds. */
  get listenerCount(): number {
    return this.#sessionListeners.size + this.#statusListeners.size
  }

  dispose(): void {
    this.#disposer?.()
  }
}

/** One client socket that collects frames. */
class Client {
  readonly socket: Socket
  readonly #frames: OutFrame[] = []
  #pending = ''
  #wake: (() => void) | undefined

  constructor(path: string) {
    clients.push(this)
    this.socket = connect(path)
    this.socket.setEncoding('utf8')
    this.socket.on('data', (chunk: string) => {
      this.#pending += chunk
      for (;;) {
        const index = this.#pending.indexOf('\n')
        if (index < 0) break
        this.#frames.push(JSON.parse(this.#pending.slice(0, index)) as OutFrame)
        this.#pending = this.#pending.slice(index + 1)
      }
      this.#wake?.()
    })
  }

  async ready(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('ready', resolve)
      this.socket.once('error', reject)
    })
  }

  write(frame: InFrame): void {
    this.socket.write(`${JSON.stringify(frame)}\n`)
  }

  async take(count: number): Promise<readonly OutFrame[]> {
    while (this.#frames.length < count) await new Promise<void>(resolve => { this.#wake = resolve })
    return this.#frames.slice(0, count)
  }

  /** Frames received so far, for assertions that expect no more. */
  get frames(): readonly OutFrame[] {
    return this.#frames
  }
}

const config = (overrides: Partial<Config> = {}): Config => ({ ...DEFAULTS, ...overrides })

/** Resolve once the plugin's registry entry appears, so the socket is listening. */
async function listening(dir: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [entry] = readRegistry(dir)
    if (entry !== undefined) return entry.socket
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  throw new Error(`no registry entry in ${dir}`)
}

test('a config row validates into defaults and rejects a mistyped field', () => {
  assert.deepEqual(validateConfig(undefined), { value: DEFAULTS })
  assert.deepEqual(validateConfig({ app: 'x' }), { value: { ...DEFAULTS, app: 'x' } })
  assert.deepEqual(validateConfig({ titleFrom: 'nope' }), {
    issues: [{ message: "titleFrom must be 'cwd-basename', 'session-title' or 'none'" }],
  })
  assert.deepEqual(validateConfig({ enabled: 'no' }), { issues: [{ message: 'enabled must be a boolean' }] })
})

test('an enabled plugin opens its socket and registry entry, then disposes both', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  apply(host.ctx, config({ socketDir: dir }))
  assert.ok(existsSync(await listening(dir)))
  host.dispose()
  for (let attempt = 0; attempt < 200 && readdirSync(dir).length > 0; attempt += 1) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  assert.deepEqual(readdirSync(dir), [])
})

test('enabled: false registers nothing at all', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  apply(host.ctx, config({ socketDir: dir, enabled: false }))
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(host.listenerCount, 0)
})

test('a bare hello creates a session and answers welcome before anything else', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid })
  const [welcome] = await client.take(1)
  assert.equal(welcome?.t, 'welcome')
  assert.equal(host.created.length, 1)
  assert.ok(welcome !== undefined && welcome.t === 'welcome' ? welcome.session.startsWith('session-') : false)
  host.dispose()
})

test('an attach to a live session reuses it; a resumed one comes from persistence', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-live', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-live' })
  const [welcome] = await client.take(1)
  assert.equal(welcome !== undefined && welcome.t === 'welcome' ? welcome.session : '', 'session-live')

  const other = new Client(await listening(dir))
  await other.ready()
  other.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-cold' })
  const [resumed] = await other.take(1)
  assert.equal(resumed !== undefined && resumed.t === 'welcome' ? resumed.session : '', 'session-cold')
  assert.deepEqual(host.resumed, ['session-cold'])
  host.dispose()
})

test('a new hello creates its session in the directory the forwarder named', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, new: { cwd: '/repo/api' } })
  const [welcome] = await client.take(1)
  assert.equal(welcome !== undefined && welcome.t === 'welcome' ? welcome.title : '', 'api')
  host.dispose()
})

test('a live turn reports working and its end reports done, with echo lines', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })
  await client.take(1)

  host.emit('session-1', { type: 'turn/start', data: { turn: 1 } })
  // welcome is the readiness signal; the first report is the turn's own.
  const afterStart = await client.take(3)
  assert.deepEqual(afterStart.map(frame => frame.t), ['welcome', 'osc', 'echo'])
  const working = afterStart[1]
  assert.equal(working !== undefined && working.t === 'osc' ? working.data : '', '\u001b]7501;state=working:app=dsh:title=cmVwbw==\u001b\\')

  host.emit('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const frames = await client.take(5)
  assert.deepEqual(frames.slice(3).map(frame => frame.t), ['osc', 'echo'])
  host.dispose()
})

test('a resumed session reports idle until its own live turn starts', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-cold', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-cold' })
  await client.take(1)

  // The replay a resume produces: the past turn's closer, then nothing.
  host.emit('session-cold', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.deepEqual(client.frames.map(frame => frame.t), ['welcome'], 'a historical turn/end must not report done')
  host.dispose()
})

test('a bridge that disconnects releases its listeners', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })
  await client.take(1)
  assert.equal(host.listenerCount, 2)
  client.socket.end()
  for (let attempt = 0; attempt < 200 && host.listenerCount > 0; attempt += 1) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  assert.equal(host.listenerCount, 0)
  host.dispose()
})

test('list reports live and bridged state without binding anything', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.add('session-2', '/repo/web')
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'list', cwd: '/repo' })
  const [frame] = await client.take(1)
  assert.deepEqual(frame, {
    t: 'sessions',
    items: [{ id: 'session-1', cwd: '/repo', live: true, bridged: false }],
  })
  host.dispose()
})

test('a hello whose proto is not 1 is refused with protocol', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: 9, pid: process.pid })
  const [frame] = await client.take(1)
  assert.equal(frame?.t, 'error')
  assert.equal(frame !== undefined && frame.t === 'error' ? frame.code : '', 'protocol')
  host.dispose()
})

test('a second hello for a bridged session is busy', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const first = new Client(await listening(dir))
  await first.ready()
  first.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })
  await first.take(1)

  const second = new Client(await listening(dir))
  await second.ready()
  second.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })
  const [frame] = await second.take(1)
  assert.equal(frame?.t, 'error')
  assert.equal(frame !== undefined && frame.t === 'error' ? frame.code : '', 'busy')
  host.dispose()
})

test('programStatus off sends no OSC at all', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir, programStatus: false }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })
  await client.take(1)
  host.emit('session-1', { type: 'turn/start', data: { turn: 1 } })
  const frames = await client.take(2)
  assert.equal(frames.some(frame => frame.t === 'osc'), false)
  assert.deepEqual(frames[1], { t: 'echo', text: '[turn 0] working' })
  host.dispose()
})
