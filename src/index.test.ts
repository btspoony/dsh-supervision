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
import { after, mock, test } from 'node:test'
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
import { HISTORY_ITEMS } from './mirror.js'
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
  session: { id: string; header: { id?: string; cwd?: string; parentSession?: string; origin?: string } }
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
  /** All create calls, including refused ones, for budget assertions. */
  createCalls = 0
  /** The model selection each create named, so a model-less turn is caught. */
  readonly createdModels: ({ readonly provider: string; readonly model: string } | undefined)[] = []
  /** The preset each create mounted, so a tool-less session is caught. */
  readonly mountedPresets: string[] = []
  /** Every steer the plugin delivered, with the session it went to. */
  readonly steered: { readonly session: string; readonly message: UserMessage }[] = []
  /** Every cancel the plugin delivered, with the session it went to. */
  readonly cancelled: string[] = []
  /** Stands in for `ctx.get('subagents')`; undefined mimics a host without one. */
  subagentRoots: Map<string, string> | undefined
  /** When set, `subagents.rootOf` throws with this message. */
  subagentRootError: string | undefined = undefined
  /** Stands in for `ctx.get('agentDefaultModel')`; undefined mimics a host without one. */
  defaultModel: { readonly provider: string; readonly model: string } | undefined
  /** Stands in for `ctx.get('agentPresets')`; undefined mimics a host without one. */
  defaultPreset: string | undefined = 'ptc'
  /** Registry reads still to answer absent, for the boot race. */
  presetsDelay = 0
  /** Every read of `agentPresets`, for the boot-window assertions. */
  presetReads = 0
  /** The directory whose workspace the fake registry resolves, if any. */
  workspacePath: string | undefined
  /** Registry reads still to answer absent, for the boot race. */
  workspaceDelay = 0
  /** Sessions attached to that workspace, for UI-visibility coverage. */
  readonly attachedSessions: string[] = []
  /** Sessions the fake registry unarchived. */
  readonly unarchivedSessions: string[] = []
  /** The registry's archive set, as the sidebar would see it. */
  archived: string[] = []
  /** What `sessionQuery` answers, when the host mounts it; `undefined` hides it. */
  sessionRecords: { header: { id: string; cwd?: string }; live: boolean }[] | undefined = undefined
  /** What `sessionQuery.readSession` replays; `undefined` hides the reader. */
  history: SessionEvent[] | undefined = []
  /** Every session id the log reader was asked for, in call order. */
  readonly historyReads: string[] = []
  /** When set, the log read rejects with this reason. */
  historyError: string | undefined = undefined
  /** When set, `readSession` holds its answer until this resolves. */
  historyWait: Promise<void> | undefined = undefined
  /** Sessions the projection cache marks blank (no turn yet). */
  blankSessions: string[] = []
  /** What the sidebar's `sessionController.list` answers, when mounted. */
  controllerItems: { sessionId: string; cwd?: string; blank: boolean; agentAvailable: boolean }[] | undefined = undefined
  /** Workspace memberships the registry reports, when it can list them. */
  workspaceRecords: { path: string; sessionIds: string[] }[] | undefined = undefined
  /** Rows `ctx.skills.list` answers; `undefined` hides the skill service. */
  catalogSkills: { name: string; description: string }[] | undefined = undefined
  /** Omits `ctx.skills.list`: a host that mounts only the body lookup. */
  skillsWithoutList = false
  /** Omits `ctx.skills.get`: a host that mounts only the menu half. */
  skillsWithoutGet = false
  /** Omits `ctx.skills.registerProvider`: a read-only registry. */
  skillsWithoutRegister = false
  /** Bodies `ctx.skills.get` answers, keyed by the skill name. */
  readonly skillBodies = new Map<string, { description: string; content: string }>()
  /** When set, `ctx.skills.list` rejects with this message. */
  skillsListError: string | undefined = undefined
  /** When set, `ctx.skills.registerProvider` throws with this message. */
  skillRegisterError: string | undefined = undefined
  /** When set, `ctx.skills.list` holds its answer until this resolves. */
  catalogWait: Promise<void> | undefined = undefined
  /** How many times `ctx.skills.list` was entered, pinned read or not. */
  catalogLists = 0
  /** Every skill name `ctx.skills.get` was asked for, in call order. */
  readonly skillGets: string[] = []
  /** When set, `ctx.skills.get` holds its answer until this resolves. */
  skillGetWait: Promise<void> | undefined = undefined
  /** Rows `ctx.jobs.list` answers; `undefined` hides the job service. */
  jobRows: { id: string; label?: string; owner?: string; status: string }[] | undefined = []
  /** Job-event listeners the plugin subscribed, one per bridge. */
  readonly jobListeners = new Set<() => void>()
  /** When set, `ctx.jobs.list` throws with this message. */
  jobsListError: string | undefined = undefined
  /** The `code` that thrown failure carries, when the host sets one. */
  jobsListErrorCode: string | undefined = undefined
  /** Sessions whose resume must fail, for the attach-failure branch. */
  readonly failResume = new Set<string>()
  /** The options each approval listener registered with, for the prepend check. */
  readonly approvalOptions: { readonly prepend?: boolean }[] = []
  /** The fake webserver; `attachServer: false` mimics a CLI-only host. */
  readonly server = new FakeServer()
  attachServer = true
  readonly #sessionListeners = new Set<(session: { id: string }, event: SessionEvent) => void>()
  readonly #statusListeners = new Set<(payload: { agent: FakeAgent; status: 'idle' | 'running' }) => void>()
  readonly #subagentListeners = new Set<() => void>()
  /** DSH's answerer chain for `approval/request`, in dispatch order. */
  readonly #approvalListeners: ApprovalListener[] = []
  /** The last effect registered; the fake models the host's disposal like the old one. */
  #disposer: (() => void) | undefined

  /** The context `apply` receives; a CLI-only host mounts no webserver. */
  get ctx(): PluginContext {
    return {
      agents: {
        get: (id: string) => this.agents.find(agent => agent.id === id),
        list: () => this.agents,
        create: async ({ sessionId, meta, agentOptions, setup }) => {
          this.createCalls += 1
          if (this.failCreate > 0) {
            this.failCreate -= 1
            throw new Error('no agent factory registered (load an agent-loop plugin)')
          }
          this.created.push(sessionId)
          this.createdModels.push(agentOptions)
          await setup?.({})
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
        if (name === 'agentDefaultModel') {
          return this.defaultModel === undefined ? undefined : { currentSelection: () => this.defaultModel }
        }
        if (name === 'workspaceRegistry') {
          if (this.workspaceDelay > 0) {
            this.workspaceDelay -= 1
            return undefined
          }
          return {
            resolveByPath: async (path: string) => this.workspacePath === undefined || path !== this.workspacePath
              ? undefined
              : { attachSession: async (id: string) => { this.attachedSessions.push(id) } },
            unarchiveSession: async (id: string) => { this.unarchivedSessions.push(id) },
            archivedSessionIds: this.archived,
            ...(this.workspaceRecords === undefined ? {} : { list: () => this.workspaceRecords ?? [] }),
          }
        }
        if (name === 'sessionController') {
          return this.controllerItems === undefined
            ? undefined
            : { list: async () => ({ items: this.controllerItems ?? [] }) }
        }
        if (name === 'sessionQuery') {
          const listSessions = this.sessionRecords === undefined
            ? undefined
            : async () => this.sessionRecords ?? []
          const readSession = this.history === undefined
            ? undefined
            : async (id: string): Promise<{ readonly events: readonly SessionEvent[] }> => {
              this.historyReads.push(id)
              if (this.historyWait !== undefined) await this.historyWait
              if (this.historyError !== undefined) throw new Error(this.historyError)
              return { events: this.history ?? [] }
            }
          if (listSessions === undefined && readSession === undefined) return undefined
          return {
            ...(listSessions === undefined ? {} : { listSessions }),
            ...(readSession === undefined ? {} : { readSession }),
          }
        }
        if (name === 'skills') {
          if (this.catalogSkills === undefined && this.skillBodies.size === 0) return undefined
          return {
            ...(this.skillsWithoutRegister ? {} : {
              registerProvider: () => {
                if (this.skillRegisterError !== undefined) throw new Error(this.skillRegisterError)
                return () => {}
              },
            }),
            ...(this.skillsWithoutList ? {} : {
              list: async () => {
                this.catalogLists += 1
                if (this.catalogWait !== undefined) await this.catalogWait
                if (this.skillsListError !== undefined) throw new Error(this.skillsListError)
                return this.catalogSkills ?? []
              },
            }),
            ...(this.skillsWithoutGet ? {} : {
              get: async (skill: string) => {
                this.skillGets.push(skill)
                if (this.skillGetWait !== undefined) await this.skillGetWait
                const body = this.skillBodies.get(skill)
                return body === undefined
                  ? undefined
                  : { name: skill, description: body.description, content: body.content }
              },
            }),
          }
        }
        if (name === 'jobs') {
          return this.jobRows === undefined
            ? undefined
            : {
                list: () => {
                  if (this.jobsListError !== undefined) {
                    const failure: Error & { code?: string } = new Error(this.jobsListError)
                    if (this.jobsListErrorCode !== undefined) failure.code = this.jobsListErrorCode
                    throw failure
                  }
                  return this.jobRows ?? []
                },
                events: {
                  subscribe: (_filter: { owner: string }, listener: () => void) => {
                    this.jobListeners.add(listener)
                    return () => { this.jobListeners.delete(listener) }
                  },
                },
              }
        }
        if (name === 'sessionProjections') return { summaryKeys: () => ['sessionListMetadata'] }
        if (name === 'sessionProjectionCache') {
          return {
            cachedSnapshot: (header: { id: string }) => ({
              values: { sessionListMetadata: { blank: this.blankSessions.includes(header.id) } },
            }),
          }
        }
        if (name === 'agentPresets') {
          this.presetReads += 1
          if (this.defaultPreset === undefined) return undefined
          if (this.presetsDelay > 0) {
            this.presetsDelay -= 1
            return undefined
          }
          return {
            resolve: async () => ({ id: this.defaultPreset ?? '' }),
            mount: async () => { this.mountedPresets.push(this.defaultPreset ?? '') },
          }
        }
        if (name !== 'subagents' || this.subagentRoots === undefined) return undefined
        return {
          rootOf: (agent: FakeAgent) => {
            if (this.subagentRootError !== undefined) throw new Error(this.subagentRootError)
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
        if (name === 'subagent/start' || name === 'subagent/end') {
          this.#subagentListeners.add(listener)
          return () => { this.#subagentListeners.delete(listener) }
        }
        const set = name === 'session/event' ? this.#sessionListeners : this.#statusListeners
        set.add(listener)
        return () => { set.delete(listener) }
      }) as PluginContext['on'],
      effect: setup => { this.#disposer = setup() },
    }
  }

  /** Register an agent without going through `apply`. */
  add(id: string, cwd: string, lineage: { parentSession?: string; origin?: string } = {}): FakeAgent {
    const agent: FakeAgent = {
      id,
      status: 'idle',
      session: { id, header: { id, cwd, ...lineage } },
      steer: message => { this.steered.push({ session: id, message }) },
      cancel: cause => { this.cancelled.push(`${id}:${cause.kind}`) },
    }
    this.agents.push(agent)
    return agent
  }

  /** Drop an agent from the listing, as the host does when its session is disposed. */
  remove(id: string): void {
    const index = this.agents.findIndex(agent => agent.id === id)
    if (index >= 0) this.agents.splice(index, 1)
  }

  emit(session: string, event: SessionEvent): void {
    for (const listener of this.#sessionListeners) listener({ id: session }, event)
  }

  /** Fire one job event, as the host's job service would. */
  emitJob(): void {
    for (const listener of this.jobListeners) listener()
  }

  /** Fire one subagent start/end, as the host's subagent service would. */
  emitSubagent(): void {
    for (const listener of this.#subagentListeners) listener()
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
    while (this.conversation.length < count) await new Promise<void>(resolve => { this.#wake = resolve })
    return this.conversation.slice(0, count)
  }

  /** Resolve once the peer closed the connection. */
  async closed(): Promise<void> {
    await new Promise<void>(resolve => {
      if (this.socket.destroyed) { resolve(); return }
      this.socket.once('close', () => { resolve() })
    })
  }

  /**
   * The conversation frames received so far. The catalog menu is a separate
   * channel with its own assertions, so transcript tests never count it.
   */
  get frames(): readonly OutFrame[] {
    return this.conversation
  }

  /** The conversation: every frame except the catalog menu. */
  get conversation(): readonly OutFrame[] {
    return this.#frames.filter(frame => frame.t !== 'catalog')
  }

  /** Every frame exactly as received, catalog included. */
  get allFrames(): readonly OutFrame[] {
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
  closes = 0
  readonly #pending: string[] = []
  #wake: (() => void) | undefined
  #ended = false

  write(text: string): boolean {
    this.out.push(text)
    return true
  }

  close(): void {
    this.closes += 1
    this.#ended = true
    this.#wake?.()
  }

  /** Type one operator line into this terminal. */
  feed(line: string): void {
    this.#pending.push(line)
    this.#wake?.()
  }

  async *lines(): AsyncGenerator<string> {
    // No keystrokes unless fed: the read loop parks until one arrives or the
    // transport closes.
    for (;;) {
      const line = this.#pending.shift()
      if (line !== undefined) {
        yield line
        continue
      }
      if (this.#ended) return
      await new Promise<void>(resolve => { this.#wake = resolve })
    }
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
    await untilBridged(host)
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
    assert.deepEqual(
      sessionsOf((await host.server.call('/dsh-supervision/state', 'GET', {})).json),
      {},
      'the tty bridge was released',
    )
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
    await untilBridged(host)
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
    await untilBridged(host)
    assert.ok(existsSync(await listening(dir)))
    host.dispose()
  })
  // An empty plugin id falls through to the fallback instead of mounting nothing.
  await withTerminal({ dshSup: '', hc: 'hc-tty' }, async () => {
    const dir = tempDir()
    const host = new FakeHost()
    const tty = new FakeTty()
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    await untilBridged(host)
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
    await untilBridged(host)
    const client = new Client(await listening(dir))
    await client.ready()
    client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: host.created[0] ?? '' })
    const [refusal] = await client.take(1)
    assert.equal(refusal?.t, 'error')
    assert.equal(refusal?.t === 'error' ? refusal.code : '', 'busy')
    // The refusal never overwrote the tty's bridge: the session is still held.
    assert.deepEqual(
      Object.keys(sessionsOf((await host.server.call('/dsh-supervision/state', 'GET', {})).json)),
      [host.created[0] ?? ''],
      'the tty bridge survived',
    )
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
    await untilBridged(host)
    host.dispose()
  })
})

test('a created session carries the default model and mounts the default preset', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.defaultModel = { provider: 'FallbacksChain', model: 'Auto' }
  host.defaultPreset = 'ptc'
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, new: { cwd: '/repo' } })
  await client.take(1)
  assert.deepEqual(host.createdModels, [{ provider: 'FallbacksChain', model: 'Auto' }])
  assert.deepEqual(host.mountedPresets, ['ptc'])
  host.dispose()
})

test('the tty boot create waits for a late preset registry and mounts it', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const tty = new FakeTty()
  host.defaultModel = { provider: 'FallbacksChain', model: 'Auto' }
  host.defaultPreset = 'ptc'
  // The profile registers the registry after the tty's first hello runs.
  host.presetsDelay = 3
  await withTerminal({ hc: 'hc-tty' }, async () => {
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    for (let attempt = 0; attempt < 400 && host.mountedPresets.length === 0; attempt += 1) {
      await new Promise<void>(resolve => { setTimeout(resolve, 25) })
    }
    assert.deepEqual(host.mountedPresets, ['ptc'], 'the boot session mounts its tools')
    assert.deepEqual(
      Object.keys(sessionsOf((await host.server.call('/dsh-supervision/state', 'GET', {})).json)),
      [host.created[0] ?? ''],
      'the tty bridge is bound',
    )
    host.dispose()
  })
})

test('a preset-less boot spends one 30 s window, then creates a plain session', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const tty = new FakeTty()
  host.defaultModel = { provider: 'FallbacksChain', model: 'Auto' }
  // No preset registry ever mounts: a supported host shape.
  host.defaultPreset = undefined
  await withTerminal({ hc: 'hc-tty' }, async () => {
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    for (let attempt = 0; attempt < 1700 && host.created.length === 0; attempt += 1) {
      await new Promise<void>(resolve => { setTimeout(resolve, 25) })
    }
    assert.equal(host.created.length, 1)
    // The boot window is read-bounded, not timing-bounded: ~60 polls of 500 ms.
    assert.ok(host.presetReads >= 60 && host.presetReads <= 63, `preset reads: ${String(host.presetReads)}`)
    assert.deepEqual(host.mountedPresets, [])
    host.dispose()
  })
})

test('a late preset registry still mounts on a host without the model service', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const tty = new FakeTty()
  host.defaultPreset = 'ptc'
  host.presetsDelay = 3
  // No defaultModel: the preset wait must not depend on it.
  await withTerminal({ hc: 'hc-tty' }, async () => {
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    for (let attempt = 0; attempt < 400 && host.mountedPresets.length === 0; attempt += 1) {
      await new Promise<void>(resolve => { setTimeout(resolve, 25) })
    }
    assert.deepEqual(host.mountedPresets, ['ptc'])
    host.dispose()
  })
})

test('the factory keeps retrying after the preset wait inside the same window', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const tty = new FakeTty()
  host.defaultModel = { provider: 'FallbacksChain', model: 'Auto' }
  host.defaultPreset = 'ptc'
  host.presetsDelay = 2
  host.failCreate = 3
  await withTerminal({ hc: 'hc-tty' }, async () => {
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    for (let attempt = 0; attempt < 600 && host.mountedPresets.length === 0; attempt += 1) {
      await new Promise<void>(resolve => { setTimeout(resolve, 25) })
    }
    assert.deepEqual(host.mountedPresets, ['ptc'])
    // Three refused creates plus the one that mounted: the preset wait did not
    // consume the factory's attempts, and the factory retry did not skip the mount.
    // Each create attempt re-reads the registry, so reads = two waits + four creates.
    assert.equal(host.createCalls, 4)
    assert.equal(host.presetReads, 6)
    host.dispose()
  })
})

test('a created session is attached to its workspace and unarchived', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.workspacePath = '/repo'
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, new: { cwd: '/repo' } })
  await client.take(1)
  assert.deepEqual(host.attachedSessions, host.created, 'the UI lists a session only through its workspace')
  assert.deepEqual(host.unarchivedSessions, host.created)
  host.dispose()
})

test('the tty boot session attaches once the workspace registry settles', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const tty = new FakeTty()
  // The tty's first session is created in the process directory.
  host.workspacePath = process.cwd()
  // The registry is registered after the boot create has already run.
  host.workspaceDelay = 4
  await withTerminal({ hc: 'hc-tty' }, async () => {
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    for (let attempt = 0; attempt < 400 && host.attachedSessions.length === 0; attempt += 1) {
      await new Promise<void>(resolve => { setTimeout(resolve, 25) })
    }
    assert.deepEqual(host.attachedSessions, host.created)
    assert.deepEqual(host.unarchivedSessions, host.created)
    host.dispose()
  })
})

test('a session created outside any workspace still answers', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.workspacePath = '/somewhere-else'
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, new: { cwd: '/repo' } })
  const [welcome] = await client.take(1)
  assert.equal(welcome?.t, 'welcome')
  assert.deepEqual(host.attachedSessions, [])
  host.dispose()
})

test('an archived session is not offered by list, unless a bridge holds it', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-live', '/repo')
  host.add('session-gone', '/repo')
  host.add('session-held', '/repo')
  host.archived = ['session-gone', 'session-held']
  apply(host.ctx, config({ socketDir: dir }))

  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'list' })
  const [before] = await client.take(1)
  const beforeItems = before?.t === 'sessions' ? before.items : []
  assert.deepEqual(beforeItems.map(item => item.id), ['session-live'], 'no row for an archived id')

  // A live bridge is what the operator is holding; hiding it would erase the
  // only surface that shows the session is steered from here.
  const owner = await attached(host, dir, 'session-held')
  client.write({ t: 'list' })
  // The second listing is this client's second frame; `attached` uses its own client.
  await until(() => client.frames.length >= 2, 'the second listing')
  const after = client.frames.at(-1)
  const afterItems = after?.t === 'sessions' ? after.items : []
  assert.deepEqual(
    afterItems.map(item => item.id).sort(),
    ['session-held', 'session-live'],
    'a bridged archived session stays visible',
  )
  assert.equal(afterItems.find(item => item.id === 'session-held')?.bridged, true)
  owner.socket.end()
  host.dispose()
})

test('list includes cold sessions and hides blank ones', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.sessionRecords = [
    { header: { id: 'session-live', cwd: '/repo' }, live: true },
    { header: { id: 'session-cold', cwd: '/repo' }, live: false },
    { header: { id: 'session-blank', cwd: '/repo' }, live: true },
    { header: { id: 'session-headless' }, live: true },
  ]
  host.blankSessions = ['session-blank']
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()

  client.write({ t: 'list' })
  const [first] = await client.take(1)
  const items = first?.t === 'sessions' ? first.items : []
  assert.deepEqual(
    items.map(item => [item.id, item.live]),
    [['session-live', true], ['session-cold', false]],
    'a cold persisted session is listed; a blank or cwd-less one is not',
  )

  // A live bridge does not resurrect a blank row: the sidebar would still hide
  // it, so the operator could never open what the listing named.
  const owner = await attached(host, dir, 'session-blank')
  client.write({ t: 'list' })
  await until(() => client.frames.length >= 2, 'the second listing')
  const second = client.frames.at(-1)
  const after = second?.t === 'sessions' ? second.items : []
  assert.deepEqual(
    after.map(item => item.id).sort(),
    ['session-cold', 'session-live'],
    'a blank session stays hidden even while bridged',
  )
  owner.socket.end()
  host.dispose()
})

test('list answers from the sidebar controller and drops blank or unowned sessions', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  // The sidebar's own summary: one live row, one cold row, one blank row, and
  // one session no Workspace owns (a subagent log in the same persistence).
  host.controllerItems = [
    { sessionId: 'session-live', cwd: '/repo', blank: false, agentAvailable: true },
    { sessionId: 'session-cold', cwd: '/repo', blank: false, agentAvailable: false },
    { sessionId: 'session-blank-ctl', cwd: '/repo', blank: true, agentAvailable: true },
    { sessionId: 'session-unowned', cwd: '/repo', blank: false, agentAvailable: false },
    { sessionId: 'session-headless', blank: false, agentAvailable: false },
  ]
  host.workspaceRecords = [{ path: '/repo', sessionIds: ['session-live', 'session-cold', 'session-blank-ctl', 'session-headless'] }]
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()

  client.write({ t: 'list' })
  const [first] = await client.take(1)
  const items = first?.t === 'sessions' ? first.items : []
  assert.deepEqual(
    items.map(item => [item.id, item.live]),
    [['session-live', true], ['session-cold', false]],
    'cold sessions are listed; blank, unowned and cwd-less ones are not',
  )
  host.dispose()
})

test('a bridged session no Workspace owns is still listed', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.controllerItems = [
    { sessionId: 'session-owned', cwd: '/repo', blank: false, agentAvailable: true },
    { sessionId: 'session-stray', cwd: '/tmp/no-workspace', blank: false, agentAvailable: true },
  ]
  host.workspaceRecords = [{ path: '/repo', sessionIds: ['session-owned'] }]
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()

  client.write({ t: 'list' })
  const [first] = await client.take(1)
  const before = first?.t === 'sessions' ? first.items : []
  assert.deepEqual(before.map(item => item.id), ['session-owned'], 'an unowned session is not offered')

  // A session created in a directory with no Workspace is real and unowned; the
  // bridge holding it is the one row the operator must still find.
  const owner = await attached(host, dir, 'session-stray')
  client.write({ t: 'list' })
  await until(() => client.frames.length >= 2, 'the second listing')
  const second = client.frames.at(-1)
  const after = second?.t === 'sessions' ? second.items : []
  assert.equal(after.find(item => item.id === 'session-stray')?.bridged, true)
  owner.socket.end()
  host.dispose()
})

test('the live-agent fallback hides a blank session, bridged or not', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  // No controller and no query: the partial-host shape the fallback exists for.
  host.add('session-empty', '/repo')
  host.blankSessions = ['session-empty']
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()

  client.write({ t: 'list' })
  const [answer] = await client.take(1)
  const items = answer?.t === 'sessions' ? answer.items : []
  assert.deepEqual(items, [], 'a live session with no turn stays out of the listing')

  // Bridging it does not change the answer: the sidebar hides it too, so the
  // listing must not offer an id the operator cannot open.
  const owner = await attached(host, dir, 'session-empty')
  client.write({ t: 'list' })
  await until(() => client.frames.length >= 2, 'the second listing')
  const second = client.frames.at(-1)
  const after = second?.t === 'sessions' ? second.items : []
  assert.deepEqual(after, [], 'a bridged blank session stays out of the listing')
  owner.socket.end()
  host.dispose()
})

test('a host without a default model service still creates a session', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, new: { cwd: '/repo' } })
  await client.take(1)
  assert.deepEqual(host.createdModels, [undefined])
  host.dispose()
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

test('the welcome restates the echo config the forwarder seeds its turn from', async () => {
  for (const echo of [true, false]) {
    const dir = tempDir()
    const host = new FakeHost()
    host.add('session-1', '/repo')
    apply(host.ctx, config({ socketDir: dir, echo }))
    try {
      const client = await attached(host, dir, 'session-1')
      const [welcome] = await client.take(1)
      assert.equal(welcome?.t, 'welcome')
      assert.equal(welcome !== undefined && welcome.t === 'welcome' ? welcome.echo : undefined, echo)
    } finally {
      host.dispose()
    }
  }
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

test('the attached session mirrors its conversation; a child session emits none', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.add('session-child', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  host.emit('session-1', {
    type: 'user/message',
    time: 100,
    data: { turn: 1, content: [{ type: 'text', text: 'implement the mirror' }], source: { kind: 'user' } },
  })
  host.emit('session-1', {
    type: 'assistant/message',
    time: 200,
    data: {
      turn: 1,
      message: { content: [{ type: 'reasoning', text: 'one step per block' }, { type: 'text', text: 'On it.' }] },
      usage: { inputTokens: 12, outputTokens: 3 },
    },
  })
  host.emit('session-1', {
    type: 'tool/call',
    time: 300,
    data: { turn: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
  })
  host.emit('session-1', {
    type: 'tool/result',
    time: 312,
    data: { turn: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] } },
  })
  // A synthetic injection and a child's conversation must not reach this wire.
  host.emit('session-1', {
    type: 'user/message',
    data: { turn: 1, content: [{ type: 'text', text: 'clock tick' }], source: { kind: 'time-context' } },
  })
  host.emit('session-child', {
    type: 'user/message',
    data: { turn: 1, content: [{ type: 'text', text: 'child prompt' }], source: { kind: 'user' } },
  })

  try {
    await until(() => client.frames.filter(frame => frame.t === 'mirror').length === 4, 'the four mirror frames')
    assert.deepEqual(client.frames.filter(frame => frame.t === 'mirror'), [
      { t: 'mirror', item: { k: 'user', text: 'implement the mirror' } },
      {
        t: 'mirror',
        item: {
          k: 'assistant',
          text: 'On it.',
          reasoning: 'one step per block',
          usage: { inputTokens: 12, outputTokens: 3 },
          turn: 1,
        },
      },
      { t: 'mirror', item: { k: 'tool', callId: 'c1', name: 'bash', args: '{"command":"ls"}', state: 'start', turn: 1 } },
      {
        t: 'mirror',
        item: { k: 'tool', callId: 'c1', name: 'bash', args: '{"command":"ls"}', state: 'ok', detail: 'a.txt', ms: 12, turn: 1 },
      },
    ])
    // Nothing else reaches the wire: not the synthetic message, not the child.
    const settled = client.frames.length
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(client.frames.length, settled, 'a synthetic message and a child session emit no mirror')
  } finally {
    host.dispose()
  }
})

test('an attach replays the persisted log oldest first behind welcome', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.history = [
    {
      type: 'user/message',
      time: 100,
      data: { turn: 1, content: [{ type: 'text', text: 'earlier question' }], source: { kind: 'user' } },
    },
    {
      type: 'assistant/message',
      time: 200,
      data: { turn: 1, message: { content: [{ type: 'text', text: 'earlier answer' }] } },
    },
  ]
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    await until(() => client.frames.length >= 3, 'the replay behind welcome')
    assert.deepEqual(host.historyReads, ['session-1'], 'the attach arm read the log')
    assert.deepEqual(client.frames.map(frame => frame.t), ['welcome', 'mirror', 'mirror'])
    assert.deepEqual(
      client.frames.flatMap(frame => frame.t === 'mirror' ? [frame.item] : []),
      [
        { k: 'user', text: 'earlier question' },
        { k: 'assistant', text: 'earlier answer', turn: 1 },
      ],
    )
  } finally {
    host.dispose()
  }
})

test('a long log replays its newest items and one echo says how many were kept', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.history = Array.from({ length: HISTORY_ITEMS + 2 }, (_, index): SessionEvent => ({
    type: 'user/message',
    time: index + 1,
    data: { turn: 1, content: [{ type: 'text', text: 'm' + String(index) }], source: { kind: 'user' } },
  }))
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    await until(() => client.frames.length >= HISTORY_ITEMS + 2, 'the bounded replay and its echo')
    const items = client.frames.flatMap(frame => frame.t === 'mirror' ? [frame.item] : [])
    assert.equal(items.length, HISTORY_ITEMS, 'only the newest items are replayed')
    assert.deepEqual(items[0], { k: 'user', text: 'm2' }, 'the oldest kept item starts the replay')
    assert.deepEqual(items.at(-1), { k: 'user', text: 'm' + String(HISTORY_ITEMS + 1) })
    assert.deepEqual(client.frames.at(-1), { t: 'echo', text: 'history: showing last ' + String(HISTORY_ITEMS) + ' items' })
  } finally {
    host.dispose()
  }
})

test('a tool call in the replayed log resolves with its state and ms', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.history = [
    {
      type: 'tool/call',
      time: 1_000,
      data: { turn: 2, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    },
    {
      type: 'tool/result',
      time: 1_012,
      data: { turn: 2, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] } },
    },
  ]
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    await until(() => client.frames.length >= 3, 'the tool pair')
    const tools = client.frames.flatMap(frame => frame.t === 'mirror' && frame.item.k === 'tool' ? [frame.item] : [])
    assert.deepEqual(tools, [
      { k: 'tool', callId: 'c1', name: 'bash', args: '{"command":"ls"}', state: 'start', turn: 2 },
      { k: 'tool', callId: 'c1', name: 'bash', args: '{"command":"ls"}', state: 'ok', detail: 'a.txt', ms: 12, turn: 2 },
    ])
  } finally {
    host.dispose()
  }
})

test('an unreadable log still attaches and echoes why history is missing', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.history = [{ type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'lost' }], source: { kind: 'user' } } }]
  host.historyError = 'session log is locked'
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    await until(() => client.frames.length >= 2, 'the unavailable echo')
    assert.deepEqual(client.frames[1], { t: 'echo', text: 'history unavailable: session log is locked' })
    client.write({ t: 'line', text: 'still steers' })
    await until(() => host.steered.length === 1, 'a usable bridge after the failed read')
  } finally {
    host.dispose()
  }
})

test('a host with no log reader attaches and echoes that history is unavailable', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.history = undefined
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    await until(() => client.frames.length >= 2, 'the unavailable echo')
    assert.deepEqual(client.frames[1], { t: 'echo', text: 'history unavailable: no session query' })
  } finally {
    host.dispose()
  }
})

test('a new session replays nothing even when the host could read a log', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.history = [{ type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'irrelevant' }], source: { kind: 'user' } } }]
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, new: { cwd: '/repo/api' } })
  const [welcome] = await client.take(1)

  try {
    assert.equal(welcome?.t, 'welcome')
    // The new arm never arms a window and never calls the reader; an empty
    // list after welcome is final because welcome precedes any read for attach.
    assert.deepEqual(host.historyReads, [], 'the new arm never reads a log')
    assert.deepEqual(client.frames.filter(frame => frame.t === 'mirror'), [])
  } finally {
    host.dispose()
  }
})

test('a live event during the history read lands after the replay exactly once', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  let release: () => void = () => {}
  host.historyWait = new Promise<void>(resolve => { release = resolve })
  host.history = [
    { type: 'user/message', seq: 1, time: 100, data: { turn: 1, content: [{ type: 'text', text: 'snapshot one' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 200, data: { turn: 1, message: { content: [{ type: 'text', text: 'snapshot two' }] } } },
  ]
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })
  const [welcome] = await client.take(1)

  try {
    assert.equal(welcome?.t, 'welcome', 'the handshake does not wait on the log')
    // One event the snapshot already holds, one appended after it.
    host.emit('session-1', {
      type: 'assistant/message',
      seq: 2,
      time: 200,
      data: { turn: 1, message: { content: [{ type: 'text', text: 'snapshot two' }] } },
    })
    host.emit('session-1', {
      type: 'user/message',
      seq: 3,
      time: 300,
      data: { turn: 1, content: [{ type: 'text', text: 'live later' }], source: { kind: 'user' } },
    })
    release()
    await until(() => client.frames.length >= 4, 'the replay and the flushed live event')
    assert.deepEqual(client.frames.flatMap(frame => frame.t === 'mirror' ? [frame.item] : []), [
      { k: 'user', text: 'snapshot one' },
      { k: 'assistant', text: 'snapshot two', turn: 1 },
      { k: 'user', text: 'live later' },
    ])
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(client.frames.length, 4, 'the duplicate seq is not a second item')
  } finally {
    host.dispose()
  }
})

test('a log read that never answers cannot hold the attach', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.historyWait = new Promise<void>(() => {})
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  const started = Date.now()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })
  const [welcome] = await client.take(1)

  try {
    assert.equal(welcome?.t, 'welcome', 'the attach does not wait for a hung read')
    const [echo] = (await client.take(2)).slice(1)
    assert.deepEqual(echo, { t: 'echo', text: 'history unavailable: timed out' })
    assert.ok(Date.now() - started < 5_000, 'the echo arrives inside the handshake budget')
    host.emit('session-1', {
      type: 'user/message',
      time: 500,
      data: { turn: 1, content: [{ type: 'text', text: 'live after timeout' }], source: { kind: 'user' } },
    })
    const [live] = (await client.take(3)).slice(2)
    assert.deepEqual(live, { t: 'mirror', item: { k: 'user', text: 'live after timeout' } })
  } finally {
    host.dispose()
  }
})


test('a timed-out read flushes what arrived while it hung and keeps the bridge', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.historyWait = new Promise<void>(() => {})
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  // Simulated clock: the 4 s deadline fires without spending 4 s, and the
  // production timing is untouched.
  mock.timers.enable({ apis: ['setTimeout'] })
  const started = Date.now()

  try {
    client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })
    await client.take(1)
    // Buffered while the read is still hanging: the deadline's flush must not
    // lose it.
    host.emit('session-1', {
      type: 'user/message',
      seq: 1,
      time: 100,
      data: { turn: 1, content: [{ type: 'text', text: 'buffered live' }], source: { kind: 'user' } },
    })
    mock.timers.tick(4_000)
    await until(() => client.frames.length >= 3, 'the timeout echo and the buffered item')
    assert.deepEqual(client.frames.slice(1), [
      { t: 'echo', text: 'history unavailable: timed out' },
      { t: 'mirror', item: { k: 'user', text: 'buffered live' } },
    ])
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(client.frames.length, 3, 'the buffered item lands exactly once')
    assert.ok(Date.now() - started < 4_000, 'the deadline was simulated, not waited out')
    client.write({ t: 'line', text: 'still steers' })
    await until(() => host.steered.length === 1, 'a usable bridge after the timeout')
  } finally {
    mock.timers.reset()
    host.dispose()
  }
})
test('a tool result produced during the read pairs with the snapshot call', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  let release: () => void = () => {}
  host.historyWait = new Promise<void>(resolve => { release = resolve })
  host.history = [
    { type: 'tool/call', seq: 1, time: 1_000, data: { turn: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
  ]
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })
  await client.take(1)

  try {
    // The result arrives during the read; mapping it before the snapshot's
    // call table existed would drop it as unpaired.
    host.emit('session-1', {
      type: 'tool/result',
      seq: 2,
      time: 1_012,
      data: { turn: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] } },
    })
    release()
    await until(() => client.frames.length >= 3, 'the replayed call and its flushed result')
    assert.deepEqual(client.frames.flatMap(frame => frame.t === 'mirror' ? [frame.item] : []), [
      { k: 'tool', callId: 'c1', name: 'bash', args: '{"command":"ls"}', state: 'start', turn: 1 },
      { k: 'tool', callId: 'c1', name: 'bash', args: '{"command":"ls"}', state: 'ok', detail: 'a.txt', ms: 12, turn: 1 },
    ])
  } finally {
    host.dispose()
  }
})
type CatalogFrame = Extract<OutFrame, { t: 'catalog' }>

/** The catalog frames a client received, in arrival order. */
function catalogs(client: Client): readonly CatalogFrame[] {
  return client.allFrames.filter((frame): frame is CatalogFrame => frame.t === 'catalog')
}

/** The one text block a steered user message carries. */
function steeredText(message: UserMessage): string {
  return message.content.map(block => block.text).join('\n')
}

test('a catalog frame follows welcome once and precedes the replayed history', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.catalogSkills = [{ name: 'use-dsh-sup', description: 'drive the terminal' }]
  host.history = [
    { type: 'user/message', seq: 1, time: 1, data: { turn: 1, content: [{ type: 'text', text: 'earlier' }], source: { kind: 'user' } } },
  ]
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })

  try {
    await until(() => client.allFrames.length >= 3, 'the catalog and the replay')
    assert.deepEqual(client.allFrames.map(frame => frame.t), ['welcome', 'catalog', 'mirror'])
    const [catalog] = catalogs(client)
    // The wire field stays for the forwarder's parser; the plugin never fills it.
    assert.deepEqual(catalog, {
      t: 'catalog',
      skills: [{ name: 'use-dsh-sup', description: 'drive the terminal' }],
      commands: [],
    })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(catalogs(client).length, 1, 'one catalog per bind')
  } finally {
    host.dispose()
  }
})

test('welcome waits for the catalog, so the menu is there when stdin pumps', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.catalogSkills = [{ name: 'use-dsh-sup', description: 'drive the terminal' }]
  // The read never answers on its own: only the mocked budget frees `welcome`,
  // so no real-time window can decide this test.
  host.catalogWait = new Promise<void>(() => {})
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  mock.timers.enable({ apis: ['setTimeout'] })

  try {
    client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })
    // The forwarder pumps stdin on `welcome`, so a menu still being read would be
    // open to a `/` pressed on the readiness signal.
    await until(() => host.catalogLists === 1, 'the catalog read to start')
    assert.equal(client.allFrames.length, 0, 'no frame while the catalog is being read')
    mock.timers.tick(249)
    assert.equal(client.allFrames.length, 0, 'no frame before the budget expires')
    mock.timers.tick(1)
    await until(() => client.allFrames.length >= 2, 'the welcome and its catalog')
    assert.deepEqual(client.allFrames.map(frame => frame.t), ['welcome', 'catalog'])
  } finally {
    mock.timers.reset()
    host.dispose()
  }
})

test('a refused hello never waits for the catalog', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.add('session-2', '/repo/web')
  // A mounted skill service, so a read of the catalog would have something to wait on.
  host.catalogSkills = [{ name: 'use-dsh-sup', description: 'drive the terminal' }]
  apply(host.ctx, config({ socketDir: dir }))
  const held = await attached(host, dir, 'session-1')
  const mover = await attached(host, dir, 'session-2')

  try {
    // From here a catalog read could only finish by the mocked budget, so an echo
    // that arrives proves the refusal ran before any read.
    host.catalogWait = new Promise<void>(() => {})
    const reads = host.catalogLists
    mock.timers.enable({ apis: ['setTimeout'] })
    mover.write({ t: 'line', text: '/attach session-1' })
    await until(() => mover.frames.some(frame => frame.t === 'echo'), 'the refusal echo')
    assert.deepEqual(
      mover.frames.flatMap(frame => frame.t === 'echo' ? [frame.text] : []),
      ['attach failed: session session-1 is already bridged'],
    )
    assert.equal(host.catalogLists, reads, 'a refused hello reads no catalog')
    assert.equal(held.frames.filter(frame => frame.t === 'welcome').length, 1, 'the held bridge is untouched')
  } finally {
    mock.timers.reset()
    host.dispose()
  }
})

test('a bind a later one on the same connection replaced stays silent', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.catalogSkills = [{ name: 'use-dsh-sup', description: 'drive the terminal' }]
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')
  let release: () => void = () => {}
  host.catalogWait = new Promise<void>(resolve => { release = resolve })
  mock.timers.enable({ apis: ['setTimeout'] })

  try {
    // `/attach` is fire-and-forget, so its bind is still inside the catalog
    // prefetch when the hello behind it binds the same session on the same
    // connection. The older bind must vanish without answering.
    client.write({ t: 'line', text: '/attach session-1' })
    await until(() => host.catalogLists === 2, 'the switch read to start')
    client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })
    await until(() => host.catalogLists === 3, 'the hello read to start')
    release()
    await until(() => client.allFrames.filter(frame => frame.t === 'welcome').length === 2, 'the newer welcome')
    await new Promise<void>(resolve => { setImmediate(resolve) })

    assert.deepEqual(client.allFrames.filter(frame => frame.t === 'error'), [], 'a superseded bind never reports busy')
    assert.deepEqual(client.allFrames.filter(frame => frame.t === 'echo'), [], 'a superseded bind writes no failure echo')
    assert.deepEqual(client.allFrames.slice(-2).map(frame => frame.t), ['welcome', 'catalog'], 'the newer bind welcomes')
    assert.equal(client.socket.destroyed, false, 'the connection the newer bind owns stays open')
    client.write({ t: 'line', text: 'still steers' })
    await until(() => host.steered.length === 1, 'a usable bridge after the superseded bind')
  } finally {
    mock.timers.reset()
    host.dispose()
  }
})

test('a claimed session reports nothing before its root word', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.add('session-2', '/repo/web')
  host.catalogSkills = [{ name: 'use-dsh-sup', description: 'drive the terminal' }]
  apply(host.ctx, config({ socketDir: dir }))
  // Bridge A opens the process-global listeners; bridge B is claimed while its
  // own menu is still being read.
  await attached(host, dir, 'session-1')
  let release: () => void = () => {}
  host.catalogWait = new Promise<void>(resolve => { release = resolve })
  mock.timers.enable({ apis: ['setTimeout'] })
  const b = new Client(await listening(dir))
  await b.ready()

  try {
    b.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-2' })
    await until(() => host.catalogLists === 2, 'the second bridge read to start')
    // A live event for B lands inside that window: B has no state the listener
    // loop can publish, so nothing may reach the wire before B's root word.
    host.emit('session-2', { type: 'turn/start', data: { turn: 1 } })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(b.allFrames.length, 0, 'no frame before the root word')
    release()
    await until(() => catalogs(b).length === 1, 'the catalog behind the root word')
    assert.deepEqual(b.allFrames.slice(0, 2).map(frame => frame.t), ['welcome', 'catalog'])
  } finally {
    mock.timers.reset()
    host.dispose()
  }
})

/**
 * Race both surfaces into binding `session-1` with the catalog read pinned. The
 * socket's read starts first, so it wins; the tty's `/attach` resumes second and
 * is refused after the read. Runs `body` once both answers have landed.
 */
async function withRacedBind(
  body: (race: {
    readonly host: FakeHost
    readonly tty: FakeTty
    readonly client: Client
    /** What the tty wrote from the moment its `/attach` was fed. */
    readonly lost: readonly string[]
  }) => Promise<void>,
): Promise<void> {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.catalogSkills = [{ name: 'use-dsh-sup', description: 'drive the terminal' }]
  const tty = new FakeTty()
  await withTerminal({ dshSup: 'tty-1' }, async () => {
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    // The synthesized tty hello binds its own session first, so both surfaces exist.
    await untilBridged(host)
    let release: () => void = () => {}
    host.catalogWait = new Promise<void>(resolve => { release = resolve })
    mock.timers.enable({ apis: ['setTimeout'] })
    const client = new Client(await listening(dir))
    await client.ready()
    try {
      client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })
      await until(() => host.catalogLists === 2, 'the socket read to start')
      const before = tty.out.length
      tty.feed('/attach session-1')
      await until(() => host.catalogLists === 3, 'the tty read to start')
      release()
      await until(() => catalogs(client).length === 1, 'the socket catalog')
      await new Promise<void>(resolve => { setImmediate(resolve) })
      // The pinned window is over: later binds read the menu normally.
      host.catalogWait = undefined
      await body({ host, tty, client, lost: tty.out.slice(before) })
    } finally {
      mock.timers.reset()
      host.dispose()
    }
  })
}

test('two surfaces cannot both bind one session across the catalog read', async () => {
  await withRacedBind(async ({ host, client, lost }) => {
    assert.deepEqual(client.allFrames.map(frame => frame.t), ['welcome', 'catalog'], 'one surface wins the session')
    // The released session's child record may still be cleared here; a root word
    // for the lost bind may not, and its refusal is the busy echo.
    assert.deepEqual(lost.filter(line => /state=(idle|working|blocked)/.test(line)), [], 'the loser sends no root word')
    assert.ok(lost.includes('attach failed: session session-1 is already bridged\n'), 'the loser reports busy')
    assert.deepEqual(
      Object.keys(sessionsOf((await host.server.call('/dsh-supervision/state', 'GET', {})).json)),
      ['session-1'],
      'the loser leaves no shadow entry',
    )
  })
})

test('a refused bind cannot steer the surface that won the session', async () => {
  await withRacedBind(async ({ host, tty, client }) => {
    // The loser's claim is gone, so its next line is unbridged instead of a
    // steer into the winner's state.
    tty.feed('steer into the winner')
    await until(() => tty.out.some(line => line.startsWith('no session bridged')), 'the unbridged echo')
    assert.deepEqual(host.steered, [], 'the winner agent receives no steer')

    // The winner keeps its entry and keeps reporting.
    host.emit('session-1', { type: 'turn/start', data: { turn: 1 } })
    await until(() => client.allFrames.length > 2, 'the winner still reports')
  })
})

test('a later /new from the refused surface cannot take the winner entry', async () => {
  await withRacedBind(async ({ host, tty, client }) => {
    assert.deepEqual(
      Object.keys(sessionsOf((await host.server.call('/dsh-supervision/state', 'GET', {})).json)),
      ['session-1'],
      'one owner before the later bind',
    )
    tty.feed('/new')
    await until(() => host.created.length === 2, 'the later bind')
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.deepEqual(
      Object.keys(sessionsOf((await host.server.call('/dsh-supervision/state', 'GET', {})).json)),
      ['session-1', host.created[1] ?? ''],
      'the winner entry survives the later bind',
    )
    host.emit('session-1', { type: 'turn/start', data: { turn: 1 } })
    await until(() => client.allFrames.length > 2, 'the winner still reports')
  })
})

test('a session switch resends the catalog once', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.add('session-2', '/repo/web')
  host.catalogSkills = [{ name: 'use-dsh-sup', description: 'drive the terminal' }]
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    await until(() => catalogs(client).length === 1, 'the first catalog')
    client.write({ t: 'line', text: '/attach session-2' })
    await until(() => catalogs(client).length === 2, 'the catalog after the switch')
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(catalogs(client).length, 2, 'exactly one per switch')
  } finally {
    host.dispose()
  }
})

test('a throwing skill service empties its section and still attaches', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.catalogSkills = []
  host.skillsListError = 'skills down'
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    await until(() => catalogs(client).length === 1, 'the degraded catalog')
    assert.deepEqual(client.allFrames.map(frame => frame.t), ['welcome', 'catalog'], 'welcome, then the empty menu')
    const [catalog] = catalogs(client)
    assert.deepEqual(catalog?.skills, [], 'a throwing service is an empty section')
    assert.deepEqual(catalog?.commands, [], 'a host command is never advertised')
    client.write({ t: 'line', text: 'still steers' })
    await until(() => host.steered.length === 1, 'a usable bridge after the failure')
  } finally {
    host.dispose()
  }
})

test('a skill registry that refuses the provider logs one line and leaves the socket mounted', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.catalogSkills = [{ name: 'use-dsh-sup', description: 'drive the terminal' }]
  host.skillRegisterError = 'registry is closed'
  const written: string[] = []
  const original = process.stderr.write
  process.stderr.write = ((chunk: string) => { written.push(chunk); return true }) as typeof process.stderr.write
  try {
    apply(host.ctx, config({ socketDir: dir }))
  } finally {
    process.stderr.write = original
  }
  assert.deepEqual(written, ['dsh-supervision: skill unavailable: registry is closed\n'])
  // The refusal costs the manual, not the bridge: the operator still attaches.
  const client = await attached(host, dir, 'session-1')
  try {
    client.write({ t: 'line', text: 'still steers' })
    await until(() => host.steered.length === 1, 'a usable bridge after the refusal')
  } finally {
    host.dispose()
  }
})

test('a host that never mounts the skills service says so once, when the window closes', () => {
  const host = new FakeHost()
  host.add('session-1', '/repo')
  const written: string[] = []
  const original = process.stderr.write
  // Simulated from before `apply`: the retry chain is what expires the window.
  mock.timers.enable({ apis: ['setTimeout'] })
  process.stderr.write = ((chunk: string) => { written.push(chunk); return true }) as typeof process.stderr.write
  try {
    apply(host.ctx, config({ socketDir: tempDir() }))
    let ticks = 0
    // Nothing while the window is open: the service may still arrive.
    while (written.length === 0 && ticks < 70) {
      mock.timers.tick(500)
      ticks += 1
    }
    assert.deepEqual(written, [
      'dsh-supervision: skill unavailable: no skill registry accepted a provider within 30000 ms\n',
    ])
    assert.ok(ticks > 50, 'the line waited for the boot window, not the first poll')

    // A retry chain that outlived the window would write a second line here.
    for (let extra = 0; extra < 20; extra += 1) mock.timers.tick(500)
    assert.equal(written.length, 1, 'one line per boot, not one per retry')
  } finally {
    process.stderr.write = original
    mock.timers.reset()
    host.dispose()
  }
})

test('a read-only skill registry keeps the menu, and the closed window blames only the provider', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.catalogSkills = [{ name: 'use-dsh-sup', description: 'drive the terminal' }]
  host.skillBodies.set('use-dsh-sup', { description: 'drive the terminal', content: 'Full manual body\n' })
  // `list` and `get` only: the shape this batch made independently usable.
  host.skillsWithoutRegister = true
  const written: string[] = []
  const original = process.stderr.write
  mock.timers.enable({ apis: ['setTimeout'] })
  process.stderr.write = ((chunk: string) => { written.push(chunk); return true }) as typeof process.stderr.write
  try {
    apply(host.ctx, config({ socketDir: dir }))
    const client = await attached(host, dir, 'session-1')
    try {
      // Both halves answer without a provider, so the line must not say the
      // service is missing: it names the one member the check looked for.
      await until(() => catalogs(client).length === 1, 'the read-only menu')
      client.write({ t: 'line', text: '/skill:use-dsh-sup' })
      await until(() => host.steered.length === 1, 'the body the read-only lookup serves')
      for (let tick = 0; tick < 70; tick += 1) mock.timers.tick(500)
      assert.deepEqual(written, [
        'dsh-supervision: skill unavailable: no skill registry accepted a provider within 30000 ms\n',
      ])
    } finally {
      host.dispose()
    }
  } finally {
    process.stderr.write = original
    mock.timers.reset()
  }
})

test('a disposed plugin stops its boot window before the expiry line can fire', () => {
  const host = new FakeHost()
  host.add('session-1', '/repo')
  const written: string[] = []
  const original = process.stderr.write
  mock.timers.enable({ apis: ['setTimeout'] })
  process.stderr.write = ((chunk: string) => { written.push(chunk); return true }) as typeof process.stderr.write
  try {
    apply(host.ctx, config({ socketDir: tempDir() }))
    // The window is still open when the plugin goes: nothing to supervise.
    for (let tick = 0; tick < 10; tick += 1) mock.timers.tick(500)
    host.dispose()
    // Disposal clears the chain, so the remaining window writes no stderr line.
    for (let tick = 0; tick < 70; tick += 1) mock.timers.tick(500)
    assert.deepEqual(written, [], 'a disposed plugin reports nothing')
  } finally {
    process.stderr.write = original
    mock.timers.reset()
    host.dispose()
  }
})

test('a hanging catalog service cannot hold the attach', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.catalogSkills = [{ name: 'slow', description: 'never listed' }]
  host.catalogWait = new Promise<void>(() => {})
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  // The catalog's 250 ms deadline is created inside the hello handler, so the
  // simulated clock has to be on before the hello is written.
  mock.timers.enable({ apis: ['setTimeout'] })

  try {
    client.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-1' })
    // `welcome` now waits behind the read, so the deadline is what frees it:
    // tick only once the read is pinned, or the timer it arms would miss it.
    await until(() => host.catalogLists === 1, 'the catalog read to start')
    mock.timers.tick(250)
    const [welcome] = await client.take(1)
    assert.equal(welcome?.t, 'welcome', 'the deadline frees the root word')
    await until(() => catalogs(client).length === 1, 'the empty catalog after the deadline')
    assert.deepEqual(client.allFrames.map(frame => frame.t), ['welcome', 'catalog'])
    assert.deepEqual(catalogs(client)[0], { t: 'catalog', skills: [], commands: [] })
    client.write({ t: 'line', text: 'still steers' })
    await until(() => host.steered.length === 1, 'a usable bridge after the timeout')
  } finally {
    mock.timers.reset()
    host.dispose()
  }
})

test('/skill: injects the named skill body as a user message', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.skillBodies.set('use-dsh-sup', { description: 'drive the terminal', content: 'Full manual body\n' })
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    client.write({ t: 'line', text: '/skill:use-dsh-sup' })
    await until(() => host.steered.length === 1, 'the injected body')
    const [steer] = host.steered
    assert.equal(steer?.session, 'session-1')
    assert.equal(steer?.message.role, 'user')
    assert.deepEqual(steer?.message.source, { kind: 'user' })
    assert.equal(
      steer === undefined ? '' : steeredText(steer.message),
      '# Skill: use-dsh-sup\n\ndrive the terminal\n\nFull manual body\n',
    )
    // The space spelling resolves the same skill.
    client.write({ t: 'line', text: '/skill use-dsh-sup' })
    await until(() => host.steered.length === 2, 'the second injection')
    assert.equal(
      host.steered[1] === undefined ? '' : steeredText(host.steered[1].message),
      steeredText(steer.message),
    )
    // Words after the name are the operator's own, carried as a note.
    client.write({ t: 'line', text: '/skill:use-dsh-sup focus on the retry' })
    await until(() => host.steered.length === 3, 'the annotated injection')
    assert.equal(
      host.steered[2] === undefined ? '' : steeredText(host.steered[2].message),
      '# Skill: use-dsh-sup\n\ndrive the terminal\n\nFull manual body\n\n## Operator note\n\nfocus on the retry',
    )
  } finally {
    host.dispose()
  }
})


test('a switch during skills.get never steers into the previous session', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.skillBodies.set('body', { description: 'body skill', content: 'the body' })
  let release: () => void = () => {}
  host.skillGetWait = new Promise<void>(resolve => { release = resolve })
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    client.write({ t: 'line', text: '/skill:body' })
    await until(() => host.skillGets.length === 1, 'the held skill read')
    // The bind moves to a cold session while the read is still open.
    client.write({ t: 'line', text: '/attach session-2' })
    await until(() => host.resumed.includes('session-2'), 'the switch to bind')
    await new Promise<void>(resolve => { setImmediate(resolve) })
    release()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(host.steered.length, 0, 'the stale read never steers')
  } finally {
    host.dispose()
  }
})
test('/skill echoes an unknown name and a skill with no body, and steers neither', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.skillBodies.set('blank', { description: 'nothing to say', content: '   \n' })
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    client.write({ t: 'line', text: '/skill:nope' })
    await until(() => client.frames.length >= 2, 'the unknown-skill echo')
    assert.deepEqual(client.frames[1], { t: 'echo', text: 'skill not found: nope' })
    client.write({ t: 'line', text: '/skill:blank' })
    await until(() => client.frames.length >= 3, 'the empty-body echo')
    assert.deepEqual(client.frames[2], { t: 'echo', text: 'skill blank has no content' })
    assert.equal(host.steered.length, 0, 'a failed skill never reaches the agent')
  } finally {
    host.dispose()
  }
})

test('a host that mounts only the skill menu keeps the catalog and loses only /skill:', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.catalogSkills = [{ name: 'use-dsh-sup', description: 'drive the terminal' }]
  host.skillsWithoutGet = true
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    // The menu half stands on its own: `list` alone still fills the catalog.
    await until(() => catalogs(client).length === 1, 'the catalog the menu half feeds')
    assert.deepEqual(catalogs(client)[0]?.skills, [{ name: 'use-dsh-sup', description: 'drive the terminal' }])
    // The other half degrades by itself, with the same honest echo.
    client.write({ t: 'line', text: '/skill:use-dsh-sup' })
    await until(() => client.frames.length >= 2, 'the injection refusal')
    assert.deepEqual(client.frames[1], { t: 'echo', text: 'skill service unavailable' })
    assert.equal(host.steered.length, 0)
  } finally {
    host.dispose()
  }
})

test('a host that mounts only the skill body lookup keeps /skill: and loses only the menu', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.skillBodies.set('use-dsh-sup', { description: 'drive the terminal', content: 'Full manual body\n' })
  host.skillsWithoutList = true
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    await until(() => catalogs(client).length === 1, 'the menu half that is absent')
    assert.deepEqual(catalogs(client)[0]?.skills, [], 'no list means no menu rows')
    // The body half still answers, so naming a skill by hand keeps working.
    client.write({ t: 'line', text: '/skill:use-dsh-sup' })
    await until(() => host.steered.length === 1, 'the injected body')
    const [steer] = host.steered
    assert.equal(
      steer === undefined ? '' : steeredText(steer.message),
      '# Skill: use-dsh-sup\n\ndrive the terminal\n\nFull manual body\n',
    )
  } finally {
    host.dispose()
  }
})

test('/skill says the service is unavailable when the host mounts none', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    client.write({ t: 'line', text: '/skill:use-dsh-sup' })
    await until(() => client.frames.length >= 2, 'the unavailable echo')
    assert.deepEqual(client.frames[1], { t: 'echo', text: 'skill service unavailable' })
    assert.equal(host.steered.length, 0)
  } finally {
    host.dispose()
  }
})
/** Every echo line the client received, in order. */
function echoesOf(client: Client): readonly string[] {
  return client.conversation.flatMap(frame => frame.t === 'echo' ? [frame.text] : [])
}

/** The decoded fields of the newest root OSC report (the one with no child id). */
function lastRootFields(client: Client): Record<string, string> {
  const frame = client.conversation.filter(
    (candidate): candidate is Extract<OutFrame, { t: 'osc' }> => candidate.t === 'osc' && !candidate.data.includes(':id='),
  ).at(-1)
  const fields: Record<string, string> = {}
  if (frame === undefined) return fields
  const body = frame.data.replace(/^\u001b\]7501;/, '').replace(/\u001b\\$/, '')
  for (const pair of body.split(':')) {
    const index = pair.indexOf('=')
    if (index < 0) continue
    const key = pair.slice(0, index)
    const value = pair.slice(index + 1)
    fields[key] = key === 'msg' || key === 'title' ? Buffer.from(value, 'base64').toString('utf8') : value
  }
  return fields
}

test('a turn that ends with a running subagent keeps the root working and says why', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    host.emit('session-1', { type: 'turn/start', data: { turn: 1 } })
    await until(() => lastRootFields(client).state === 'working', 'the live turn')
    host.add('session-child', '/repo', { parentSession: 'session-1', origin: 'subagent' })
    const child = host.agents.at(-1)
    assert.ok(child !== undefined)
    child.status = 'running'
    host.emit('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(() => lastRootFields(client).msg === '1 subagent', 'working after the turn ended')
    assert.equal(lastRootFields(client).state, 'working')

    // The child settling is the only thing left running; the turn word returns.
    child.status = 'idle'
    host.emitSubagent()
    await until(() => lastRootFields(client).state === 'done', 'done after the child settled')
    assert.equal(lastRootFields(client).msg, undefined)
  } finally {
    host.dispose()
  }
})

test('an owned running job keeps the root working until it settles', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    // A finished turn leaves the word the job has to override.
    host.emit('session-1', { type: 'turn/start', data: { turn: 1 } })
    host.emit('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(() => lastRootFields(client).state === 'done', 'the finished turn')
    host.jobRows = [{ id: 'job-1', label: 'nightly', owner: 'session-1', status: 'running' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'working', 'working for the job')
    assert.equal(lastRootFields(client).msg, '1 job')

    host.jobRows = [{ id: 'job-1', label: 'nightly', owner: 'session-1', status: 'done' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'done', 'done after the job settled')
    assert.equal(lastRootFields(client).msg, undefined)
  } finally {
    host.dispose()
  }
})

test('an activity family that never changes stops counting after its window', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')
  const realNow = Date.now()

  try {
    // A finished turn leaves the word the stale fallback must return to.
    host.emit('session-1', { type: 'turn/start', data: { turn: 1 } })
    host.emit('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(() => lastRootFields(client).state === 'done', 'the finished turn')
    host.add('session-child', '/repo', { parentSession: 'session-1', origin: 'subagent' })
    const child = host.agents.at(-1)
    assert.ok(child !== undefined)
    child.status = 'running'
    host.emitSubagent()
    await until(() => lastRootFields(client).state === 'working', 'working for the child')
    assert.equal(lastRootFields(client).msg, '1 subagent')

    // The child stops changing; past the stale window the root falls back.
    mock.timers.enable({ apis: ['Date'] })
    // A full minute past the window, so the few milliseconds spent setting the
    // clock up can never make the test pass or fail on scheduling noise.
    mock.timers.setTime(realNow + 6 * 60_000)
    host.emitSubagent()
    await until(() => lastRootFields(client).state === 'done', 'the stale fallback')
    assert.equal(lastRootFields(client).msg, 'activity stale: 1 subagent')
    assert.deepEqual(
      client.conversation.find(frame => frame.t === 'echo' && frame.text.startsWith('activity stale:')),
      { t: 'echo', text: 'activity stale: 1 subagent' },
    )
  } finally {
    mock.timers.reset()
    host.dispose()
  }
})

test('a host without the jobs service reports the turn word exactly as before', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.jobRows = undefined
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    assert.equal(host.jobListeners.size, 0, 'nothing to subscribe')
    host.emit('session-1', { type: 'turn/start', data: { turn: 1 } })
    await until(() => lastRootFields(client).state === 'working', 'the live turn')
    host.emit('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(() => lastRootFields(client).state === 'done', 'the turn word')
    assert.equal(lastRootFields(client).msg, undefined)
    assert.equal(
      echoesOf(client).some(text => text.startsWith('activity unavailable')),
      false,
      'a host that never mounts jobs stays silent',
    )
  } finally {
    host.dispose()
  }
})

test('a failing jobs scan keeps the known job and counts no fabricated leave', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'running' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'working', 'working for the job')

    // A failing scan keeps the last-known job: the root must not fall to done and
    // count a leave that herdr-core never saw.
    host.jobsListError = 'jobs down'
    host.emitJob()
    await until(() => echoesOf(client).includes('activity unavailable: jobs down'), 'the degradation echo')
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(lastRootFields(client).state, 'working', 'the known job keeps the word')
    assert.equal(lastRootFields(client).msg, '1 job')

    // A second failing scan neither repeats the line nor moves the counter.
    host.emitJob()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(echoesOf(client).filter(text => text === 'activity unavailable: jobs down').length, 1)

    host.jobsListError = undefined
    host.emitJob()
    await until(() => echoesOf(client).includes('activity recovered'), 'the recovery echo')
    assert.equal(lastRootFields(client).state, 'working')

    // The real settle is the only leave the supervisor sees; no turn ran here,
    // so the turn word it returns to is idle.
    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'done' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'idle', 'the drained word')
    assert.deepEqual(echoesOf(client), [
      '[turn 0] working',
      'activity unavailable: jobs down',
      'activity recovered',
      '[turn 1] idle',
    ])
  } finally {
    host.dispose()
  }
})

test('a changed jobs-scan cause is announced again and the fresh cause is what sticks', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'running' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'working', 'working for the job')

    host.jobsListError = 'jobs down'
    host.emitJob()
    await until(() => echoesOf(client).includes('activity unavailable: jobs down'), 'the first cause')

    // A different failure is a new episode: keeping the first line would report
    // a cause that no longer holds.
    host.jobsListError = 'registry closed'
    host.emitJob()
    await until(() => echoesOf(client).includes('activity unavailable: registry closed'), 'the second cause')

    // The stored cause is the fresh one: a repeat of it must stay silent, which
    // it cannot if the first cause were still the one compared against.
    host.emitJob()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(
      echoesOf(client).filter(text => text.startsWith('activity unavailable:')).length,
      2,
      'two episodes, one line each',
    )
    assert.equal(lastRootFields(client).state, 'working', 'the known job still keeps the word')
  } finally {
    host.dispose()
  }
})

test('a cause that only renames its duration is one episode, not one line per poll', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'running' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'working', 'working for the job')

    host.jobsListError = 'scan timed out after 1200 ms'
    host.emitJob()
    await until(() => echoesOf(client).includes('activity unavailable: scan timed out after 1200 ms'), 'the first cause')

    // The same timeout, reported with a different duration: the 2 s poll must
    // not turn one episode into one line per scan.
    host.jobsListError = 'scan timed out after 1500 ms'
    host.emitJob()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(
      echoesOf(client).filter(text => text.startsWith('activity unavailable:')).length,
      1,
      'a renumbered duration is the same episode',
    )

    // A different cause is still news.
    host.jobsListError = 'registry closed'
    host.emitJob()
    await until(() => echoesOf(client).includes('activity unavailable: registry closed'), 'the changed cause')
  } finally {
    host.dispose()
  }
})

test('a coded failure is the episode, not the message it happens to carry', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'running' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'working', 'working for the job')

    host.jobsListError = 'lock held by session-9'
    host.jobsListErrorCode = 'ELOCKED'
    host.emitJob()
    await until(() => echoesOf(client).includes('activity unavailable: lock held by session-9'), 'the first cause')

    // Same code, another id in the message: one episode, and the full message
    // the operator already read is not replaced by a second one.
    host.jobsListError = 'lock held by session-12'
    host.emitJob()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(
      echoesOf(client).filter(text => text.startsWith('activity unavailable:')).length,
      1,
      'the code decides, not the id in the message',
    )

    // A different code under the same message is a new episode.
    host.jobsListErrorCode = 'EBUSY'
    host.emitJob()
    await until(
      () => echoesOf(client).filter(text => text.startsWith('activity unavailable:')).length === 2,
      'the changed code',
    )
  } finally {
    host.dispose()
  }
})

test('a vanished jobs service keeps the last-known activity', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'running' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'working', 'working for the job')

    host.jobRows = undefined
    host.emitJob()
    await until(() => echoesOf(client).includes('activity unavailable: no jobs service'), 'the degradation echo')
    assert.equal(lastRootFields(client).state, 'working')
    assert.equal(lastRootFields(client).msg, '1 job')

    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'running' }]
    host.emitJob()
    await until(() => echoesOf(client).includes('activity recovered'), 'the recovery echo')
    assert.equal(lastRootFields(client).state, 'working')
  } finally {
    host.dispose()
  }
})

test('disposing the plugin clears an activity poll it started', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.add('session-child', '/repo', { parentSession: 'session-1', origin: 'subagent' })
  const child = host.agents.at(-1)
  assert.ok(child !== undefined)
  child.status = 'running'
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')
  await until(() => lastRootFields(client).state === 'working', 'working for the child')

  const realClear = globalThis.clearInterval
  let cleared = 0
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    cleared += 1
    realClear(timer)
  }) as typeof globalThis.clearInterval
  try {
    host.dispose()
  } finally {
    globalThis.clearInterval = realClear
  }
  assert.ok(cleared > 0, 'the activity poll was cleared')
})
test('an activity poll stops when the last family drains and restarts lazily', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'running' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'working', 'working for the job')

    const realClear = globalThis.clearInterval
    let cleared = 0
    globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
      cleared += 1
      realClear(timer)
    }) as typeof globalThis.clearInterval
    try {
      host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'done' }]
      host.emitJob()
      await until(() => lastRootFields(client).state === 'idle', 'the drained word')
    } finally {
      globalThis.clearInterval = realClear
    }
    assert.ok(cleared > 0, 'the poll stopped with the family')

    // A later family opens a fresh poll; the bridge is still watched.
    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'running' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'working', 'the restarted activity')
    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'done' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'idle', 'the second drain')
  } finally {
    host.dispose()
  }
})

test('a switch announces the composed activity word, not a transient idle', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  // Cold, so the switch exercises the resume path and a fresh establish.
  host.add('child-2', '/repo', { parentSession: 'session-2', origin: 'subagent' })
  const child = host.agents.at(-1)
  assert.ok(child !== undefined)
  child.status = 'running'
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    const before = client.conversation.length
    client.write({ t: 'line', text: '/attach session-2' })
    await until(() => host.resumed.includes('session-2'), 'the switch to bind')
    await until(() => client.conversation.slice(before).some(frame => frame.t === 'echo'), 'the announce echo')
    const echoes = client.conversation.slice(before).flatMap(frame => frame.t === 'echo' ? [frame.text] : [])
    assert.equal(echoes[0], '[turn 0] working', 'the first announced word is composed')
    assert.equal(echoes.includes('[turn 0] idle'), false, 'no transient idle frame')
  } finally {
    host.dispose()
  }
})

test('a turn held by activity does not advance the turn; releasing it does once', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    host.add('session-child', '/repo', { parentSession: 'session-1', origin: 'subagent' })
    const child = host.agents.at(-1)
    assert.ok(child !== undefined)
    child.status = 'running'
    host.emit('session-1', { type: 'turn/start', data: { turn: 1 } })
    await until(() => lastRootFields(client).state === 'working', 'the live turn')

    // The turn ends, but the child holds the composed word on `working`:
    // herdr-core would see no leave, so the turn counter must not move either.
    host.emit('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(() => lastRootFields(client).msg === '1 subagent', 'the held working word')
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(
      client.conversation.some(frame => frame.t === 'echo' && frame.text === '[turn 1] working'),
      false,
      'a held turn is not a leave',
    )

    // The child settling is the one real leave, and it counts exactly once.
    child.status = 'idle'
    host.emitSubagent()
    await until(() => lastRootFields(client).state === 'done', 'the drained word')
    const done = client.conversation.flatMap(frame => frame.t === 'echo' ? [frame.text] : [])
      .filter(text => text.endsWith(' done'))
    assert.deepEqual(done, ['[turn 1] done'])
  } finally {
    host.dispose()
  }
})
test('a blocked turn held by activity counts its leave once and the drain adds nothing', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    host.add('session-child', '/repo', { parentSession: 'session-1', origin: 'subagent' })
    const child = host.agents.at(-1)
    assert.ok(child !== undefined)
    child.status = 'running'
    host.emit('session-1', { type: 'turn/start', data: { turn: 1 } })
    await until(() => lastRootFields(client).state === 'working', 'the live turn')

    // blocked outranks working, so this is a real leave even while the child runs.
    host.emit('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } })
    await until(() => lastRootFields(client).state === 'blocked', 'the blocked word')
    assert.deepEqual(echoesOf(client), ['[turn 0] working', '[turn 1] blocked'])

    // Draining the family later reports the same blocked word: no second count.
    child.status = 'idle'
    host.emitSubagent()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(lastRootFields(client).state, 'blocked')
    assert.deepEqual(echoesOf(client), ['[turn 0] working', '[turn 1] blocked'])
  } finally {
    host.dispose()
  }
})

test('a job that starts before the turn ends leaves once when it settles', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'running' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'working', 'working for the job')
    host.emit('session-1', { type: 'turn/start', data: { turn: 1 } })
    host.emit('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.deepEqual(echoesOf(client), ['[turn 0] working'], 'the held turn leaves nothing')

    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'done' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'done', 'the drained word')
    assert.deepEqual(echoesOf(client), ['[turn 0] working', '[turn 1] done'])
  } finally {
    host.dispose()
  }
})

test('a job that starts after the turn ends counts one leave of its own', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')

  try {
    host.emit('session-1', { type: 'turn/start', data: { turn: 1 } })
    host.emit('session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(() => lastRootFields(client).state === 'done', 'the finished turn')
    assert.deepEqual(echoesOf(client), ['[turn 0] working', '[turn 1] done'])

    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'running' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'working', 'working for the job')
    assert.deepEqual(echoesOf(client), ['[turn 0] working', '[turn 1] done', '[turn 1] working'])

    host.jobRows = [{ id: 'job-1', owner: 'session-1', status: 'done' }]
    host.emitJob()
    await until(() => lastRootFields(client).state === 'done', 'the drained word')
    assert.deepEqual(echoesOf(client), [
      '[turn 0] working',
      '[turn 1] done',
      '[turn 1] working',
      '[turn 2] done',
    ])
  } finally {
    host.dispose()
  }
})
test('releasing a bridge clears its poll and job subscription without touching the other bridge', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.add('session-b', '/repo/other')
  host.add('child-1', '/repo', { parentSession: 'session-1', origin: 'subagent' })
  const child = host.agents.at(-1)
  assert.ok(child !== undefined)
  child.status = 'running'
  apply(host.ctx, config({ socketDir: dir }))
  const one = await attached(host, dir, 'session-1')
  const two = await attached(host, dir, 'session-b')

  try {
    await until(() => lastRootFields(one).state === 'working', 'activity on the first bridge')
    assert.equal(host.jobListeners.size, 2, 'one job subscription per bridge')

    const realClear = globalThis.clearInterval
    let cleared = 0
    globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
      cleared += 1
      realClear(timer)
    }) as typeof globalThis.clearInterval
    try {
      one.socket.end()
      await until(() => host.jobListeners.size === 1, 'the released bridge unsubscribed')
    } finally {
      globalThis.clearInterval = realClear
    }
    assert.ok(cleared > 0, 'the released bridge cleared its poll')

    host.emit('session-b', { type: 'turn/start', data: { turn: 1 } })
    await until(() => lastRootFields(two).state === 'working', 'the surviving bridge still reports')
    assert.equal(host.jobListeners.size, 1, 'no subscription came back')
  } finally {
    host.dispose()
  }
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
  assert.deepEqual(host.historyReads, ['session-1'], 'the refused hello never arms or reads a log')
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

/**
 * Resolve once the state route reports `count` bridged sessions — the product
 * fact a bind produces, unlike a create that resolves earlier.
 * @param host - the fake host carrying the routes.
 * @param count - how many bridges to wait for.
 */
async function untilBridged(host: FakeHost, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const sessions = sessionsOf((await host.server.call('/dsh-supervision/state', 'GET', {})).json)
    if (Object.keys(sessions).length === count) return
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
  throw new Error(`timed out waiting for ${String(count)} bridged session(s)`)
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

test('a child record whose session left the listing is retired, not kept forever', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.add('session-2', '/repo/web')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')
  await until(() => client.frames.length === 2, 'the seeded child record')

  try {
    // The host disposing a session is what removes it from the listing; the
    // subagent/end edge is where a scan next runs.
    host.remove('session-2')
    host.emitSubagent()
    await until(
      () => client.frames.some(frame => oscData(frame) === '\u001b]7501;state=clear:id=session-2\u001b\\'),
      'the retired child record',
    )

    // A retired session cannot come back through a late event of its own.
    const settled = client.frames.length
    host.emit('session-2', { type: 'turn/start', data: { turn: 1 } })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(client.frames.length, settled, 'no record is re-created for a session the host forgot')
  } finally {
    host.dispose()
  }
})

test('a child record for a session still listed survives the scan', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.add('session-2', '/repo/web')
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')
  await until(() => client.frames.length === 2, 'the seeded child record')

  try {
    host.emitSubagent()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(
      client.frames.filter(frame => oscData(frame).includes('id=session-2')).length,
      1,
      'a listed session keeps its record',
    )
  } finally {
    host.dispose()
  }
})

test('a lineage lookup that throws retires no live subagent record', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-1', '/repo')
  host.add('session-child', '/repo')
  host.subagentRoots = new Map([['session-child', 'session-1']])
  apply(host.ctx, config({ socketDir: dir }))
  const client = await attached(host, dir, 'session-1')
  await until(() => client.frames.length === 2, 'the seeded subagent record')

  try {
    // The record was stored as `sub/<id>` because lineage proved it earlier. A
    // scan whose `rootOf` throws proves nothing, so the record key — not a fresh
    // lookup — decides: the live row must survive.
    host.subagentRootError = 'no lineage'
    host.emitSubagent()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    assert.equal(
      client.frames.filter(frame => oscData(frame).includes('id=sub/session-child')).length,
      1,
      'the live subagent keeps its record',
    )
    assert.equal(
      client.frames.some(frame => oscData(frame).startsWith('\u001b]7501;state=clear:id=sub/session-child')),
      false,
      'an unproven lineage clears nothing',
    )

    // Only the session leaving the listing is staleness the seam proves.
    host.remove('session-child')
    host.emitSubagent()
    await until(
      () => client.frames.some(frame => oscData(frame) === '\u001b]7501;state=clear:id=sub/session-child\u001b\\'),
      'the retired subagent record',
    )
  } finally {
    host.dispose()
  }
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

test('/attach to a session the other surface holds is refused and keeps the socket bridge', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const tty = new FakeTty()
  host.add('session-b', '/repo/b')
  await withTerminal({ hc: 'hc-tty' }, async () => {
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    await untilBridged(host)
    const held = host.created[0] ?? ''
    const client = await attached(host, dir, 'session-b')

    client.write({ t: 'line', text: `/attach ${held}` })
    await until(() => client.frames.some(frame => frame.t === 'echo'), 'the refusal echo')
    assert.deepEqual(client.frames.find(frame => frame.t === 'echo'), {
      t: 'echo',
      text: `attach failed: session ${held} is already bridged`,
    })

    // The socket bridge still owns session-b, and the tty still owns its own.
    client.write({ t: 'line', text: 'still session-b' })
    await until(() => host.steered.length === 1, 'the steer')
    assert.equal(host.steered[0]?.session, 'session-b')
    assert.deepEqual(
      Object.keys(sessionsOf((await host.server.call('/dsh-supervision/state', 'GET', {})).json)).sort(),
      [host.created[0] ?? '', 'session-b'].sort(),
      'the tty bridge survived',
    )
    host.dispose()
  })
})

test('two hellos racing for one session leave exactly one bridge', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.add('session-race', '/repo')
  apply(host.ctx, config({ socketDir: dir }))
  const first = new Client(await listening(dir))
  const second = new Client(await listening(dir))
  await Promise.all([first.ready(), second.ready()])
  first.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-race' })
  second.write({ t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-race' })

  await until(() => first.frames.length > 0 && second.frames.length > 0, 'both answers')
  const answers = [first.frames[0], second.frames[0]]
  assert.equal(answers.filter(frame => frame?.t === 'welcome').length, 1)
  assert.equal(answers.filter(frame => frame?.t === 'error' && frame.code === 'busy').length, 1)
  host.dispose()
})

test('reclaiming a tty-held session leaves the socket bridge untouched', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  const tty = new FakeTty()
  host.add('session-b', '/repo/b')
  await withTerminal({ hc: 'hc-tty' }, async () => {
    apply(host.ctx, config({ socketDir: dir }), () => ({ ok: true, io: tty }))
    await untilBridged(host)
    const held = host.created[0] ?? ''
    await attached(host, dir, 'session-b')

    const reclaim = await host.server.call(
      '/dsh-supervision/reclaim',
      'POST',
      { 'content-type': 'application/json' },
      JSON.stringify({ session: held }),
    )
    assert.equal(reclaim.statusCode, 200)
    assert.deepEqual(
      Object.keys(sessionsOf((await host.server.call('/dsh-supervision/state', 'GET', {})).json)),
      ['session-b'],
      'the tty bridge was released',
    )
    const sessions = sessionsOf((await host.server.call('/dsh-supervision/state', 'GET', {})).json)
    assert.deepEqual(Object.keys(sessions), ['session-b'], 'the socket bridge survived')
    host.dispose()
  })
})

test('a forwarder create fails fast when the agent factory is missing', async () => {
  const dir = tempDir()
  const host = new FakeHost()
  host.failCreate = 1
  apply(host.ctx, config({ socketDir: dir }))
  const client = new Client(await listening(dir))
  await client.ready()
  client.write({ t: 'hello', proto: PROTO, pid: process.pid, new: { cwd: '/repo/api' } })

  const answer = await Promise.race([
    client.take(1),
    new Promise<'timeout'>(resolve => { setTimeout(() => { resolve('timeout') }, 1000) }),
  ])
  assert.notEqual(answer, 'timeout', 'a forwarder must not wait out the tty boot budget')
  const [frame] = answer as readonly OutFrame[]
  assert.equal(frame?.t, 'error')
  assert.equal(frame?.t === 'error' ? frame.code : '', 'create-failed')
  host.dispose()
})
