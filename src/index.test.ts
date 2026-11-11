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
import type {
  ApprovalListener,
  ApprovalRequest,
  Config,
  PluginContext,
  SessionEvent,
  UserMessage,
} from './index.js'
import type { ApprovalOutcome } from './approval.js'
import type { TtyIO } from './tty-transport.js'
import { PROTO, readRegistry } from 'dsh-supervision-protocol'
import type { InFrame, OutFrame } from 'dsh-supervision-protocol'

const roots: string[] = []
/** Every client this file opened; a dangling socket would keep the runner alive. */
const clients: Client[] = []
/**
 * The suite drives the socket path unless a case opts into the tty, so a real
 * terminal id in the process running the tests must not choose for it.
 */
const outerTerminalId = process.env['DSH_SUP_TERMINAL_ID']
const outerHcTerminalId = process.env['HC_TERMINAL_ID']
delete process.env['DSH_SUP_TERMINAL_ID']
delete process.env['HC_TERMINAL_ID']

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-supervision-plugin-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const client of clients) client.socket.destroy()
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  if (outerTerminalId !== undefined) process.env['DSH_SUP_TERMINAL_ID'] = outerTerminalId
  if (outerHcTerminalId !== undefined) process.env['HC_TERMINAL_ID'] = outerHcTerminalId
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
  /** Creates still to fail with DSH's no-factory refusal, for the boot race. */
  failCreate = 0
  /** Every steer the plugin delivered, with the session it went to. */
  readonly steered: { readonly session: string; readonly message: UserMessage }[] = []
  /** Every cancel the plugin delivered, with the session it went to. */
  readonly cancelled: string[] = []
  /** Stands in for `ctx.get('subagents')`; undefined mimics a host without one. */
  subagentRoots: Map<string, string> | undefined
  /** Sessions whose resume must fail, for the attach-failure branch. */
  readonly failResume = new Set<string>()
  /** The options each approval listener registered with, for the prepend check. */
  readonly approvalOptions: { readonly prepend?: boolean }[] = []
  /** The fake webserver; `attachServer: false` mimics a CLI-only host. */
  readonly server = new FakeServer()
  attachServer = true
  readonly #sessionListeners = new Set<(session: { id: string }, event: SessionEvent) => void>()
  readonly #statusListeners = new Set<(payload: { agent: FakeAgent; status: 'idle' | 'running' }) => void>()
  /** DSH's answerer chain for `approval/request`, in dispatch order. */
  readonly #approvalListeners: ApprovalListener[] = []
  #disposer: (() => void) | undefined

  /** The context `apply` receives; a CLI-only host mounts no webserver. */
  get ctx(): PluginContext {
    return {
      agents: {
        get: (id: string) => this.agents.find(agent => agent.id === id),
        list: () => this.agents,
        create: async ({ sessionId, meta }) => {
          if (this.failCreate > 0) {
            this.failCreate -= 1
            throw new Error('no agent factory registered (load an agent-loop plugin)')
          }
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
      on: ((name: string, listener: never, options?: { readonly prepend?: boolean }) => {
        if (name === 'approval/request') {
          this.#approvalListeners.push(listener)
          this.approvalOptions.push(options ?? {})
          return () => {
            const index = this.#approvalListeners.indexOf(listener)
            if (index >= 0) this.#approvalListeners.splice(index, 1)
          }
        }
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

  /**
   * Dispatch one approval question the way the host's waterfall does.
   * @param request - the pending question.
   * @returns the first answer, or `unavailable` when no answerer claims it.
   */
  async ask(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const step = async (index: number): Promise<ApprovalOutcome> => {
      const listener = this.#approvalListeners[index]
      return listener === undefined ? 'unavailable' : listener(request, () => step(index + 1))
    }
    return step(0)
  }

  /** @returns how many approval listeners the plugin holds. */
  get approvalCount(): number {
    return this.#approvalListeners.length
  }

  /** @returns how many session and status listeners the plugin holds. */
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

/** A terminal the plugin reports on, with no real tty anywhere. */
class FakeTty implements TtyIO {
  readonly out: string[] = []
  readonly raw: boolean[] = []
  closes = 0
  #wake: (() => void) | undefined
  #ended = false

  write(text: string): boolean {
    this.out.push(text)
    return true
  }

  setRaw(raw: boolean): void {
    this.raw.push(raw)
  }

  close(): void {
    this.closes += 1
    this.#ended = true
    this.#wake?.()
  }

  async *lines(): AsyncGenerator<string> {
    // No keystrokes: the read loop parks until the transport closes.
    while (!this.#ended) await new Promise<void>(resolve => { this.#wake = resolve })
  }
}

/**
 * Run `body` with the terminal id variables set to the given values.
 * @param ids - `dshSup` sets `DSH_SUP_TERMINAL_ID`, `hc` sets `HC_TERMINAL_ID`;
 *   an omitted key leaves that variable absent for the duration.
 * @param body - the assertions.
 */
async function withTerminal(
  ids: { readonly dshSup?: string; readonly hc?: string },
  body: () => Promise<void>,
): Promise<void> {
  const restore = [
    ['DSH_SUP_TERMINAL_ID', process.env['DSH_SUP_TERMINAL_ID']],
    ['HC_TERMINAL_ID', process.env['HC_TERMINAL_ID']],
  ] as const
  const set = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  set('DSH_SUP_TERMINAL_ID', ids.dshSup)
  set('HC_TERMINAL_ID', ids.hc)
  try {
    await body()
  } finally {
    for (const [name, value] of restore) set(name, value)
  }
}

test('a herdr-core terminal id mounts the tty and the socket surface together', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const tty = new FakeTty()
  await withTerminal({ hc: 'hc-tty' }, async () => {
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    // The synthesized first hello creates a session and binds it to the tty.
    await until(() => tty.raw.at(-1) === true, 'the tty bridge to attach')
    // Both surfaces: the tty renders, and the socket answers discovery.
    assert.ok(existsSync(await listening(dir)))
    assert.equal(host.created.length, 1)
    assert.ok(tty.out.length > 0)

    // Routes answer for a tty bridge through the same seam.
    const sessions = sessionsOf((await host.server.call('/dsh-supervision/state', 'GET', {})).json)
    assert.deepEqual(Object.keys(sessions), host.created)
    const reclaim = await host.server.call(
      '/dsh-supervision/reclaim',
      'POST',
      { 'content-type': 'application/json' },
      JSON.stringify({ session: host.created[0] }),
    )
    assert.equal(reclaim.statusCode, 200)

    host.dispose()
    // Disposal releases the terminal and closes it.
    assert.equal(tty.raw.at(-1), false)
    assert.equal(tty.closes, 1)
  })
})

test('DSH_SUP_TERMINAL_ID mounts the tty and keeps the socket surface', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const tty = new FakeTty()
  await withTerminal({ dshSup: 'sup-tty' }, async () => {
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    // The synthesized first hello creates a session and binds it to the tty.
    await until(() => tty.raw.at(-1) === true, 'the tty bridge to attach')
    assert.ok(existsSync(await listening(dir)))
    host.dispose()
  })
})

test('the plugin terminal id outranks the fallback, and an empty value falls through', async () => {
  // The fallback is empty, and the plugin's own id still selects the tty.
  await withTerminal({ dshSup: 'sup-tty', hc: '' }, async () => {
    const dir = tempDir()
    const host = new FakeHost()
    const tty = new FakeTty()
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    await until(() => tty.raw.at(-1) === true, 'the tty bridge to attach')
    assert.ok(existsSync(await listening(dir)))
    host.dispose()
  })
  // An empty plugin id falls through to the fallback instead of mounting nothing.
  await withTerminal({ dshSup: '', hc: 'hc-tty' }, async () => {
    const dir = tempDir()
    const host = new FakeHost()
    const tty = new FakeTty()
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    await until(() => tty.raw.at(-1) === true, 'the tty bridge to attach')
    assert.ok(existsSync(await listening(dir)))
    host.dispose()
  })
})

test('without a terminal id the socket transport is used and no tty is opened', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  let opened = 0
  await withTerminal({}, async () => {
    apply(host.ctx, config({ socketDir: dir }), () => {
      opened += 1
      return { ok: false, reason: 'must not be read' }
    })
    assert.ok(existsSync(await listening(dir)))
    assert.equal(opened, 0)
    host.dispose()
  })
})

test('a tty that cannot be opened says why on stderr and keeps the socket surface', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const written: string[] = []
  const original = process.stderr.write
  await withTerminal({ hc: 'hc-tty' }, async () => {
    process.stderr.write = ((chunk: string) => { written.push(chunk); return true }) as typeof process.stderr.write
    try {
      apply(host.ctx, config({ socketDir: dir }), () => ({ ok: false, reason: 'no tty: nowhere to report' }))
    } finally {
      process.stderr.write = original
    }
    assert.deepEqual(written, ['dsh-supervision: no tty transport: no tty: nowhere to report\n'])
    // Only the tty surface is dropped: the socket and its routes still mount.
    assert.ok(existsSync(await listening(dir)))
    assert.deepEqual(host.server.paths, ['/dsh-supervision/state', '/dsh-supervision/reclaim'])
    host.dispose()
  })
})

test('a socket attach to the session the tty already holds is refused as busy', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const tty = new FakeTty()
  await withTerminal({ hc: 'hc-tty' }, async () => {
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    await until(() => tty.raw.at(-1) === true, 'the tty bridge to attach')
    const client = new Client(await listening(dir))
    await client.ready()
    client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: host.created[0] ?? '' })
    const [refusal] = await client.take(1)
    assert.equal(refusal?.t, 'error')
    assert.equal(refusal?.t === 'error' ? refusal.code : '', 'busy')
    // The refusal never overwrote the tty's bridge: the session is still held.
    assert.equal(tty.raw.at(-1), true)
    host.dispose()
  })
})

test('the tty first session retries while the agent factory is still missing', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const tty = new FakeTty()
  host.failCreate = 2
  await withTerminal({ hc: 'hc-tty' }, async () => {
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    // The retries sleep on a real timer, so poll with one instead of setImmediate.
    for (let attempt = 0; attempt < 100 && host.created.length === 0; attempt += 1) {
      await new Promise<void>(resolve => { setTimeout(resolve, 25) })
    }
    assert.equal(host.created.length, 1)
    await until(() => tty.raw.at(-1) === true, 'the tty bridge to attach')
    host.dispose()
  })
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

test('a title change alone reaches the wire, so session-title is observable', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir, titleFrom: 'session-title' }))
  const client = await attached(host, dir, 'session-1')

  // The mode derives no title from the cwd, so the session's own title is the
  // only source and nothing but this event can change the record.
  host.emit('session-1', { type: 'session/title', data: { title: 'renamed' } })
  await until(() => client.frames.length === 2, 'the title report')
  assert.deepEqual(client.frames[1], {
    t: 'osc',
    data: '\u001b]7501;state=idle:app=dsh:title=cmVuYW1lZA==\u001b\\',
  })
  assert.deepEqual(client.frames.map(frame => frame.t), ['welcome', 'osc'], 'a title is not an echo line')
  host.dispose()
})

test('a title change is not re-sent when nothing else changed', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir, titleFrom: 'session-title' }))
  const client = await attached(host, dir, 'session-1')

  host.emit('session-1', { type: 'session/title', data: { title: 'renamed' } })
  await until(() => client.frames.length === 2, 'the title report')
  host.emit('session-1', { type: 'session/title', data: { title: 'renamed' } })
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(client.frames.length, 2, 'the same record is not a second report')
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
  assert.equal(host.approvalCount, 1, 'a live bridge is the only reason the ask listener exists')
  client.socket.end()
  for (let attempt = 0; attempt < 200 && host.listenerCount > 0; attempt += 1) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  assert.equal(host.listenerCount, 0)
  assert.equal(host.approvalCount, 0)
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

test('/new refuses a relative argument instead of creating elsewhere', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  client.write({ t: 'line', text: '/new sub/dir' })
  await until(() => client.frames.length === 2, 'the refusal')
  assert.deepEqual(client.frames[1], { t: 'echo', text: 'new failed: sub/dir is not an absolute path' })
  assert.deepEqual(host.created, [], 'nothing is created in a directory nobody named')
  assert.equal(host.agents.length, 1)
  host.dispose()
})

test('/new creates a session in an absolute cwd', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  client.write({ t: 'line', text: '/new /repo/api' })
  await until(() => client.frames.length === 4, 'the switch')
  const created = host.created[0]
  assert.ok(created !== undefined)
  assert.equal(host.agents.find(agent => agent.id === created)?.session.header.cwd, '/repo/api')
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

/** The ask id an echo line names. */
function askIdOf(text: string): string {
  const matched = /\[ask ([0-9a-f]{6})\]/.exec(text)
  assert.ok(matched?.[1] !== undefined, `no ask id in: ${text}`)
  return matched?.[1] ?? ''
}

/** The text of an echo frame, `''` for any other frame. */
function echoText(frame: OutFrame | undefined): string {
  return frame !== undefined && frame.t === 'echo' ? frame.text : ''
}

/** The payload of an osc frame, `''` for any other frame. */
function oscData(frame: OutFrame | undefined): string {
  return frame !== undefined && frame.t === 'osc' ? frame.data : ''
}

/** The `msg` of one OSC 7501 report, base64-decoded. */
function reportedMsg(data: string): string {
  const matched = /msg=([^:\u001b]+)/.exec(data)
  return matched?.[1] === undefined ? '' : Buffer.from(matched[1], 'base64').toString('utf8')
}

test('a bridged ask parks as blocked, is decided by id, and a bare /y decides the next one', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const agent = host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))

  // No bridge yet: no listener, so the browser's own answerer still answers.
  assert.equal(host.approvalCount, 0)
  assert.equal(await host.ask({ agent, toolName: 'bash', reason: 'write' }), 'unavailable')

  const client = await attached(host, dir, 'session-1')
  assert.deepEqual(host.approvalOptions, [{ prepend: true }])

  const first = host.ask({ agent, toolName: 'bash', reason: 'write outside the workspace' })
  await until(() => client.frames.length === 4, 'the parked ask')
  const id = askIdOf(echoText(client.frames[1]))
  assert.deepEqual(client.frames[1], { t: 'echo', text: `[ask ${id}] bash parked (session-1)` })
  assert.match(oscData(client.frames[2]), /^\u001b\]7501;state=blocked:kind=permission:app=dsh:title=cmVwbw==:msg=/)
  assert.equal(reportedMsg(oscData(client.frames[2])), `bash write outside the workspace [ask ${id}]`)
  assert.deepEqual(client.frames[3], { t: 'echo', text: '[turn 0] blocked' })

  client.write({ t: 'line', text: `/approve ${id}` })
  assert.equal(await first, 'allowed-once')
  await until(() => client.frames.length === 7, 'the decision')
  assert.deepEqual(client.frames.slice(4), [
    { t: 'echo', text: `[ask ${id}] bash → allowed-once (source=supervisor)` },
    { t: 'osc', data: '\u001b]7501;state=idle:app=dsh:title=cmVwbw==\u001b\\' },
    { t: 'echo', text: '[turn 0] idle' },
  ])

  const second = host.ask({ agent, toolName: 'edit' })
  await until(() => client.frames.length === 10, 'the second ask')
  const other = askIdOf(echoText(client.frames[7]))
  assert.equal(reportedMsg(oscData(client.frames[8])), `edit [ask ${other}]`)

  client.write({ t: 'line', text: '/y' })
  assert.equal(await second, 'allowed-once')
  await until(() => client.frames.length === 13, 'the bare decision')
  assert.deepEqual(client.frames[12], { t: 'echo', text: '[turn 0] idle' })

  client.write({ t: 'line', text: '/approve zzz' })
  await until(() => client.frames.length === 14, 'the unknown id')
  assert.deepEqual(client.frames[13], { t: 'echo', text: 'no ask zzz' })
  host.dispose()
})

test('two parked asks are named by /status, and bare /y refuses to guess', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const agent = host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  const first = host.ask({ agent, toolName: 'bash', reason: 'one' })
  await until(() => client.frames.length === 4, 'the first ask')
  const second = host.ask({ agent, toolName: 'edit', reason: 'two' })
  await until(() => client.frames.length === 5, 'the second ask')
  const ids = [askIdOf(echoText(client.frames[1])), askIdOf(echoText(client.frames[4]))]
  assert.notEqual(ids[0], ids[1])

  client.write({ t: 'line', text: '/status' })
  await until(() => client.frames.length === 6, 'the status line')
  assert.deepEqual(client.frames[5], {
    t: 'echo',
    text: `session=session-1 state=blocked turn=0 asks=${ids.join(',')}`,
  })

  client.write({ t: 'line', text: '/y' })
  await until(() => client.frames.length === 7, 'the refusal')
  assert.deepEqual(client.frames[6], { t: 'echo', text: '2 asks pending; name one' })

  // The older ask still names the blocked root, so settling the newer one
  // changes nothing on the wire but the audit line.
  client.write({ t: 'line', text: `/approve ${ids[1] ?? ''}` })
  assert.equal(await second, 'allowed-once')
  await until(() => client.frames.length === 8, 'the newer decision')
  assert.deepEqual(client.frames[7], {
    t: 'echo',
    text: `[ask ${ids[1] ?? ''}] edit → allowed-once (source=supervisor)`,
  })

  client.write({ t: 'line', text: `/reject ${ids[0] ?? ''}` })
  assert.equal(await first, 'rejected')
  await until(() => client.frames.length === 11, 'the older decision')
  assert.deepEqual(client.frames.slice(8), [
    { t: 'echo', text: `[ask ${ids[0] ?? ''}] bash → rejected (source=supervisor)` },
    { t: 'osc', data: '\u001b]7501;state=idle:app=dsh:title=cmVwbw==\u001b\\' },
    { t: 'echo', text: '[turn 0] idle' },
  ])
  host.dispose()
})

test('only the bridged tree claims an ask', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  const elsewhere = host.add('session-other', '/repo/other')
  const child = host.add('session-child', '/repo')
  host.subagentRoots = new Map([['session-child', 'session-1']])
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')
  await until(() => client.frames.length === 3, 'both seeded child records')

  assert.equal(await host.ask({ agent: elsewhere, toolName: 'bash' }), 'unavailable')
  assert.deepEqual(client.frames.length, 3, 'another tree keeps its own answerer')

  const claimed = host.ask({ agent: child, toolName: 'probe', reason: 'tree' })
  await until(() => client.frames.length === 6, 'the tree ask')
  const id = askIdOf(echoText(client.frames[3]))
  assert.equal(reportedMsg(oscData(client.frames[4])), `probe tree [ask ${id}]`)

  client.write({ t: 'line', text: '/y' })
  assert.equal(await claimed, 'allowed-once')
  host.dispose()
})

test('an asker that withdraws its ask settles it cancelled and clears the root', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const agent = host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  const controller = new AbortController()
  const answered = host.ask({ agent, toolName: 'bash', reason: 'write', signal: controller.signal })
  await until(() => client.frames.length === 4, 'the parked ask')
  const id = askIdOf(echoText(client.frames[1]))

  controller.abort()
  assert.equal(await answered, 'cancelled')
  await until(() => client.frames.length === 7, 'the withdrawal')
  assert.deepEqual(client.frames.slice(4), [
    { t: 'echo', text: `[ask ${id}] bash → cancelled (source=attached)` },
    { t: 'osc', data: '\u001b]7501;state=idle:app=dsh:title=cmVwbw==\u001b\\' },
    { t: 'echo', text: '[turn 0] idle' },
  ])
  host.dispose()
})

test('a bridge that goes away settles its parked ask cancelled', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const agent = host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  const answered = host.ask({ agent, toolName: 'bash' })
  await until(() => client.frames.length === 4, 'the parked ask')
  client.socket.end()
  assert.equal(await answered, 'cancelled')
  host.dispose()
})

test('disposing the plugin settles a parked ask cancelled', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const agent = host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  await attached(host, dir, 'session-1')

  const answered = host.ask({ agent, toolName: 'probe' })
  await until(() => host.approvalCount === 1, 'the approval listener')
  host.dispose()
  assert.equal(await answered, 'cancelled')
})

test('a session switch is refused while an ask is parked', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const agent = host.add('session-1', '/repo')
  host.add('session-2', '/repo/web')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')
  await until(() => client.frames.length === 2, 'the seeded child record')

  const answered = host.ask({ agent, toolName: 'bash' })
  await until(() => client.frames.length === 5, 'the parked ask')
  client.write({ t: 'line', text: '/attach session-2' })
  await until(() => client.frames.length === 6, 'the refusal')
  assert.deepEqual(client.frames[5], { t: 'echo', text: 'refused: 1 approval(s) parked' })

  client.write({ t: 'line', text: '/status' })
  await until(() => client.frames.length === 7, 'the status line')
  assert.match(echoText(client.frames[6]), /^session=session-1 state=blocked/)

  client.write({ t: 'line', text: '/n' })
  assert.equal(await answered, 'rejected')
  host.dispose()
})

test('the state route reports one entry per live bridge and no entry without one', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  // The label reaches the browser from this env var; a literal pins that path.
  // The plugin's own name stays absent, so herdr-core's fallback is what shows.
  const previous = process.env['HC_TERMINAL_NAME']
  const previousPlugin = process.env['DSH_SUP_TERMINAL_NAME']
  process.env['HC_TERMINAL_NAME'] = 'hc-literal'
  delete process.env['DSH_SUP_TERMINAL_NAME']
  try {
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
    assert.equal(entry.terminal, 'hc-literal')
    assert.equal(entry.pid, process.pid)
    assert.equal(typeof entry.since, 'number')
    assert.deepEqual(entry.asks, [])

    client.socket.end()
    await until(() => host.listenerCount === 0, 'the bridge to drop')
    const after = await host.server.call('/dsh-supervision/state', 'GET', {})
    assert.deepEqual(after.json, { proto: 1, sessions: {} })
  } finally {
    if (previous === undefined) delete process.env['HC_TERMINAL_NAME']
    else process.env['HC_TERMINAL_NAME'] = previous
    if (previousPlugin === undefined) delete process.env['DSH_SUP_TERMINAL_NAME']
    else process.env['DSH_SUP_TERMINAL_NAME'] = previousPlugin
    host.dispose()
  }
})

test("DSH_SUP_TERMINAL_NAME outranks herdr-core's terminal label", async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  const previous = process.env['DSH_SUP_TERMINAL_NAME']
  const previousHc = process.env['HC_TERMINAL_NAME']
  process.env['DSH_SUP_TERMINAL_NAME'] = 'sup-literal'
  process.env['HC_TERMINAL_NAME'] = 'hc-literal'
  try {
    apply(host.ctx, config({ socketDir: dir, programStatus: false }))
    const client = await attached(host, dir, 'session-1')
    const sessions = sessionsOf((await host.server.call('/dsh-supervision/state', 'GET', {})).json)
    const entry = sessions['session-1']
    assert.ok(entry !== undefined)
    assert.equal(entry.terminal, 'sup-literal')

    client.socket.end()
    await until(() => host.listenerCount === 0, 'the bridge to drop')
  } finally {
    if (previous === undefined) delete process.env['DSH_SUP_TERMINAL_NAME']
    else process.env['DSH_SUP_TERMINAL_NAME'] = previous
    if (previousHc === undefined) delete process.env['HC_TERMINAL_NAME']
    else process.env['HC_TERMINAL_NAME'] = previousHc
    host.dispose()
  }
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
