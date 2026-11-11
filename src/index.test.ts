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
import type { Config, PluginContext, SessionEvent, UserMessage } from './index.js'
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
  steer(message: UserMessage): void
  cancel(cause: { readonly kind: 'user' }): void
}

/** One fake response: status, headers and body the handler wrote. */
class FakeResponse {
  statusCode = 0
  readonly headers = new Map<string, string>()
  body = ''

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value)
  }

  end(body?: string): void {
    this.body = body ?? ''
  }

  /** @returns the parsed JSON body. */
  get json(): unknown {
    return JSON.parse(this.body) as unknown
  }
}

/** A fake `ctx.webServer` that answers a request through its registered route. */
class FakeServer {
  readonly #handlers = new Map<string, (req: unknown, res: FakeResponse) => void | Promise<void>>()

  /** The paths currently registered. */
  get paths(): readonly string[] {
    return [...this.#handlers.keys()]
  }

  register(route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (req: never, res: never) => void | Promise<void>
  }): () => void {
    this.#handlers.set(route.path, route.handler as (req: unknown, res: FakeResponse) => void | Promise<void>)
    return () => { this.#handlers.delete(route.path) }
  }

  /** Call the route at `path` with a request of `method`, `headers` and `body`. */
  async call(path: string, method: string, headers: Record<string, string>, body = ''): Promise<FakeResponse> {
    const handler = this.#handlers.get(path)
    assert.ok(handler !== undefined, `no route at ${path}`)
    const chunks = [Buffer.from(body, 'utf8')]
    const req = { method, headers, async *[Symbol.asyncIterator]() { yield* chunks } }
    const res = new FakeResponse()
    await handler(req, res)
    return res
  }
}

/** A host context whose agents are in-memory and whose events the test emits. */
class FakeHost {
  readonly agents: FakeAgent[] = []
  readonly created: string[] = []
  readonly resumed: string[] = []
  /** Every steer the plugin delivered, with the session it went to. */
  readonly steered: { readonly session: string; readonly message: UserMessage }[] = []
  /** Every cancel the plugin delivered, with the session it went to. */
  readonly cancelled: string[] = []
  /** Stands in for `ctx.get('subagents')`; undefined mimics a host without one. */
  subagentRoots: Map<string, string> | undefined
  /** Sessions whose resume must fail, for the attach-failure branch. */
  readonly failResume = new Set<string>()
  /** The fake webserver; `attachServer: false` mimics a CLI-only host. */
  readonly server = new FakeServer()
  attachServer = true
  readonly #sessionListeners = new Set<(session: { id: string }, event: SessionEvent) => void>()
  readonly #statusListeners = new Set<(payload: { agent: FakeAgent; status: 'idle' | 'running' }) => void>()
  #disposer: (() => void) | undefined

  /** The context `apply` receives; a CLI-only host mounts no webserver. */
  get ctx(): PluginContext {
    return {
      agents: {
        get: (id: string) => this.agents.find(agent => agent.id === id),
        list: () => this.agents,
        create: async ({ sessionId, meta }) => {
          this.created.push(sessionId)
          return { agent: this.add(sessionId, meta.cwd) }
        },
        resume: async ({ resumeSessionId }) => {
          if (this.failResume.has(resumeSessionId)) throw new Error('no such session')
          this.resumed.push(resumeSessionId)
          return { agent: this.add(resumeSessionId, '/repo/resumed') }
        },
      },
      get: (name: string) => {
        if (name === 'webServer') return this.attachServer ? this.server : undefined
        if (name !== 'subagents' || this.subagentRoots === undefined) return undefined
        return {
          rootOf: (agent: FakeAgent) => {
            const root = this.subagentRoots?.get(agent.id)
            return root === undefined ? agent : this.agents.find(candidate => candidate.id === root) ?? agent
          },
        }
      },
      on: ((name: string, listener: never) => {
        const set = name === 'session/event' ? this.#sessionListeners : this.#statusListeners
        set.add(listener)
        return () => { set.delete(listener) }
      }) as PluginContext['on'],
      effect: setup => { this.#disposer = setup() },
    }
  }

  /** Register an agent without going through `apply`. */
  add(id: string, cwd: string): FakeAgent {
    const agent: FakeAgent = {
      id,
      status: 'idle',
      session: { id, header: { cwd } },
      steer: message => { this.steered.push({ session: id, message }) },
      cancel: cause => { this.cancelled.push(`${id}:${cause.kind}`) },
    }
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

  /** Resolve once the peer closed the connection. */
  async closed(): Promise<void> {
    await new Promise<void>(resolve => {
      if (this.socket.destroyed) { resolve(); return }
      this.socket.once('close', () => { resolve() })
    })
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

/** The session map of a state payload, for assertions on one entry. */
function sessionsOf(payload: unknown): Record<string, { bridged: true; terminal: string; pid: number; since: number; asks: readonly string[] }> {
  assert.ok(payload !== null && typeof payload === 'object')
  const sessions = Reflect.get(payload, 'sessions') as unknown
  assert.ok(sessions !== null && typeof sessions === 'object' && !Array.isArray(sessions))
  return sessions as Record<string, { bridged: true; terminal: string; pid: number; since: number; asks: readonly string[] }>
}

/** Poll without timers: the runner only moves forward on `setImmediate`. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A client already attached and past its welcome. */
async function attached(host: FakeHost, dir: string, session: string): Promise<Client> {
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: session })
  await client.take(1)
  return client
}

test('a plain line steers the attached session and a blank one does nothing', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  client.write({ t: 'line', text: '   ' })
  client.write({ t: 'line', text: 'run the tests\r\n' })
  await until(() => host.steered.length === 1, 'one steer')
  await new Promise<void>(resolve => { setImmediate(resolve) })

  assert.equal(host.steered.length, 1)
  const [delivered] = host.steered
  assert.equal(delivered?.session, 'session-1')
  assert.equal(delivered?.message.role, 'user')
  assert.equal(delivered?.message.source.kind, 'user')
  assert.deepEqual(delivered?.message.content, [{ type: 'text', text: 'run the tests' }])
  assert.ok(Object.isFrozen(delivered?.message))
  assert.deepEqual(client.frames.map(frame => frame.t), ['welcome'], 'a line alone reports nothing')
  host.dispose()
})

test('/cancel cancels the attached agent as the operator', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')
  client.write({ t: 'line', text: '/cancel' })
  await until(() => host.cancelled.length === 1, 'one cancel')
  assert.deepEqual(host.cancelled, ['session-1:user'])
  assert.deepEqual(host.steered, [])
  host.dispose()
})

test('/status echoes one line and malformed input never reaches the agent', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  client.write({ t: 'line', text: '/status' })
  client.write({ t: 'line', text: '/help' })
  client.write({ t: 'line', text: '/attach nope' })
  client.write({ t: 'line', text: '/y' })
  await until(() => client.frames.length === 5, 'four echoes')
  assert.deepEqual(client.frames.slice(1), [
    { t: 'echo', text: 'session=session-1 state=idle turn=0 asks=-' },
    { t: 'echo', text: 'unknown command /help' },
    { t: 'echo', text: 'unknown command /attach' },
    { t: 'echo', text: 'no approval pending' },
  ])
  assert.deepEqual(host.steered, [], 'no diagnostic reaches the agent')
  host.dispose()
})

test('/attach switches the bridge without a second welcome or a leaked listener', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.add('session-2', '/repo/web')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')
  await until(() => client.frames.length === 2, 'the seeded child record')

  client.write({ t: 'line', text: '/attach session-2' })
  await until(() => client.frames.length === 6, 'the switch')
  assert.deepEqual(client.frames.map(frame => frame.t), ['welcome', 'osc', 'osc', 'osc', 'echo', 'osc'])
  // The old child record is cleared, the new root reported, then the old session is a child.
  assert.deepEqual(client.frames[2], { t: 'osc', data: '\u001b]7501;state=clear:id=session-2\u001b\\' })
  assert.deepEqual(client.frames[3], { t: 'osc', data: '\u001b]7501;state=idle:app=dsh:title=d2Vi\u001b\\' })
  assert.deepEqual(client.frames[5], { t: 'osc', data: '\u001b]7501;state=idle:id=session-1\u001b\\' })
  assert.equal(client.frames.filter(frame => frame.t === 'welcome').length, 1, 'a switch never re-welcomes')
  assert.equal(host.listenerCount, 2, 'the previous session listeners were released')

  client.write({ t: 'line', text: 'after the switch' })
  await until(() => host.steered.length === 1, 'the steer')
  assert.equal(host.steered[0]?.session, 'session-2')
  host.dispose()
})

test('a failed attach echoes the reason and keeps the current session', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.failResume.add('session-gone')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  client.write({ t: 'line', text: '/attach session-gone' })
  await until(() => client.frames.length === 2, 'the refusal')
  assert.deepEqual(client.frames[1], { t: 'echo', text: 'attach failed: no such session' })

  client.write({ t: 'line', text: 'still here' })
  await until(() => host.steered.length === 1, 'the steer')
  assert.equal(host.steered[0]?.session, 'session-1')
  host.dispose()
})

test('/new creates a session in the current cwd, attaches it, and does not re-welcome', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  client.write({ t: 'line', text: '/new' })
  await until(() => client.frames.length === 4, 'the new root and the old session as its child')
  const created = host.created[0]
  assert.ok(created !== undefined && created.startsWith('session-'))
  assert.equal(host.agents.find(agent => agent.id === created)?.session.header.cwd, '/repo')
  assert.deepEqual(client.frames[1], { t: 'osc', data: '\u001b]7501;state=idle:app=dsh:title=cmVwbw==\u001b\\' })
  assert.deepEqual(client.frames[2], { t: 'echo', text: '[turn 0] idle' })
  assert.deepEqual(client.frames[3], { t: 'osc', data: '\u001b]7501;state=idle:id=session-1\u001b\\' })
  assert.equal(client.frames.filter(frame => frame.t === 'welcome').length, 1)

  client.write({ t: 'line', text: '/status' })
  await until(() => client.frames.length === 5, 'the status line')
  assert.deepEqual(client.frames[4], {
    t: 'echo',
    text: `session=${created ?? ''} state=idle turn=0 asks=-`,
  })
  host.dispose()
})

test('a non-attached live session is a child record that never moves the root turn', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.add('session-2', '/repo/web')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')
  await until(() => client.frames.length === 2, 'the seeded child record')
  assert.deepEqual(client.frames[1], { t: 'osc', data: '\u001b]7501;state=idle:id=session-2\u001b\\' })

  host.emit('session-2', { type: 'turn/start', data: { turn: 1 } })
  await until(() => client.frames.length === 3, 'the child turn start')
  assert.deepEqual(client.frames[2], { t: 'osc', data: '\u001b]7501;state=working:id=session-2\u001b\\' })

  host.emit('session-2', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await until(() => client.frames.length === 4, 'the child turn end')
  assert.deepEqual(client.frames[3], { t: 'osc', data: '\u001b]7501;state=done:id=session-2\u001b\\' })

  client.write({ t: 'line', text: '/status' })
  await until(() => client.frames.length === 5, 'the root status')
  assert.deepEqual(client.frames[4], { t: 'echo', text: 'session=session-1 state=idle turn=0 asks=-' })
  host.dispose()
})

test('an in-process subagent reports sub/<session> and a switch clears every child record', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.add('session-child', '/repo')
  host.add('session-3', '/repo/b')
  host.subagentRoots = new Map([['session-child', 'session-1']])
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')
  await until(() => client.frames.length === 3, 'both child records')
  assert.deepEqual(client.frames[1], { t: 'osc', data: '\u001b]7501;state=idle:id=sub/session-child\u001b\\' })
  assert.deepEqual(client.frames[2], { t: 'osc', data: '\u001b]7501;state=idle:id=session-3\u001b\\' })

  host.emit('session-child', { type: 'turn/start', data: { turn: 1 } })
  await until(() => client.frames.length === 4, 'the subagent turn start')
  assert.deepEqual(client.frames[3], { t: 'osc', data: '\u001b]7501;state=working:id=sub/session-child\u001b\\' })

  client.write({ t: 'line', text: '/attach session-3' })
  await until(() => client.frames.length === 10, 'the switch and its child records')
  assert.deepEqual(client.frames[4], { t: 'osc', data: '\u001b]7501;state=clear:id=sub/session-child\u001b\\' })
  assert.deepEqual(client.frames[5], { t: 'osc', data: '\u001b]7501;state=clear:id=session-3\u001b\\' })
  assert.deepEqual(client.frames[6], { t: 'osc', data: '\u001b]7501;state=idle:app=dsh:title=Yg==\u001b\\' })
  host.dispose()
})

test('the state route reports one entry per live bridge and no entry without one', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir, programStatus: false }))
  assert.deepEqual(host.server.paths, ['/dsh-supervision/state', '/dsh-supervision/reclaim'])

  const empty = await host.server.call('/dsh-supervision/state', 'GET', {})
  assert.deepEqual(empty.json, { proto: 1, sessions: {} })

  const client = await attached(host, dir, 'session-1')
  const sessions = sessionsOf((await host.server.call('/dsh-supervision/state', 'GET', {})).json)
  assert.deepEqual(Object.keys(sessions), ['session-1'])
  const entry = sessions['session-1']
  assert.ok(entry !== undefined)
  assert.equal(entry.bridged, true)
  assert.equal(entry.terminal, process.env['HC_TERMINAL_NAME'] ?? 'dsh-sup')
  assert.equal(entry.pid, process.pid)
  assert.equal(typeof entry.since, 'number')
  assert.deepEqual(entry.asks, [])

  client.socket.end()
  await until(() => host.listenerCount === 0, 'the bridge to drop')
  const after = await host.server.call('/dsh-supervision/state', 'GET', {})
  assert.deepEqual(after.json, { proto: 1, sessions: {} })
  host.dispose()
})

test('reclaim hands the session back, tells the forwarder why, and is idempotent', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')
  assert.equal(host.listenerCount, 2)

  const body = JSON.stringify({ session: 'session-1' })
  const first = await host.server.call('/dsh-supervision/reclaim', 'POST', { 'content-type': 'application/json' }, body)
  assert.equal(first.statusCode, 200)
  assert.deepEqual(first.json, { reclaimed: true })

  // The forwarder reads the goodbye and its socket is closed behind it.
  await until(() => client.frames.some(frame => frame.t === 'bye'), 'the goodbye frame')
  assert.deepEqual(client.frames.at(-1), { t: 'bye', reason: 'reclaimed' })
  await client.closed()

  // Cleanup ran with the hand-back: listeners are gone and the state is empty.
  assert.equal(host.listenerCount, 0)
  assert.deepEqual((await host.server.call('/dsh-supervision/state', 'GET', {})).json, { proto: 1, sessions: {} })

  const second = await host.server.call('/dsh-supervision/reclaim', 'POST', { 'content-type': 'application/json' }, body)
  assert.equal(second.statusCode, 409)
  assert.deepEqual(second.json, { reclaimed: false })
  host.dispose()
})

test('reclaim answers 415 without a JSON content type and 400 for a bad body', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir, programStatus: false }))
  const client = await attached(host, dir, 'session-1')
  const state = await host.server.call('/dsh-supervision/state', 'GET', {})

  const wrongType = await host.server.call(
    '/dsh-supervision/reclaim',
    'POST',
    { 'content-type': 'text/plain' },
    '{"session":"session-1"}',
  )
  assert.equal(wrongType.statusCode, 415)
  const badBody = await host.server.call('/dsh-supervision/reclaim', 'POST', { 'content-type': 'application/json' }, '{}')
  assert.equal(badBody.statusCode, 400)

  // Neither attempt touched the bridge.
  assert.equal(host.listenerCount, 2)
  assert.deepEqual((await host.server.call('/dsh-supervision/state', 'GET', {})).json, state.json)
  client.socket.end()
  host.dispose()
})

test('a host without a webserver mounts no routes and keeps its socket', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.attachServer = false
  apply(host.ctx, config({ socketDir: dir }))
  assert.deepEqual(host.server.paths, [])
  assert.ok(existsSync(await listening(dir)))
  host.dispose()
})
