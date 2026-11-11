/**
 * The Cordis plugin: it owns the control socket, one root report per bridged
 * session, the parked approval asks that force that report to `blocked`, and
 * the activation gate that keeps a GUI-only `dsh web` untouched.
 *
 * The DSH host is not a dependency of this package (the host loads the plugin,
 * not the reverse), so the few services it touches are declared structurally
 * below. That declaration is the whole host seam.
 */

import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { PROTO, clearProgramStatus, programStatus } from 'dsh-supervision-protocol'
import type { ErrorCode, HelloFrame, ProgramKind, ProgramState, ProgramStatus, SessionItem } from 'dsh-supervision-protocol'
import { ApprovalQueue } from './approval.js'
import type { ApprovalOutcome, ParkedAsk } from './approval.js'
import { createRootState, reduceRootState, rootWord } from './state.js'
import type { RootState, StateEvent } from './state.js'
import { parseLine } from './stdin.js'
import { registerSupervisionRoutes, supervisionState } from './routes.js'
import type { RouteRegistrar, SupervisionFacts, SupervisionState } from './routes.js'
import { SocketTransport } from './transport.js'
import type { Bridge, Transport, TransportHandlers } from './transport.js'
import { TtyTransport } from './tty-transport.js'
import { openTtyIO } from './tty.js'
import type { TtyOpen } from './tty.js'

/** The parts of a DSH Session this plugin reads. */
interface SessionLike {
  readonly id: string
  readonly header?: { readonly cwd?: string }
}

/** The parts of a DSH user message this plugin builds. */
export interface UserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: { readonly kind: 'user' }
}

/** The parts of a DSH Agent this plugin reads. */
interface AgentLike {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: SessionLike
  steer(message: UserMessage): void
  cancel(cause: { readonly kind: 'user' }): void
}

/** The `ctx.subagents` surface this plugin reads, when the host mounts it. */
interface SubagentsLike {
  rootOf(agent: AgentLike): AgentLike
}

/**
 * The slice of DSH's `ApprovalRequestEvent` this plugin reads
 * (`packages/interaction/user-approval/src/types.ts:80-100`). The event carries
 * no id, which is why the plugin assigns its own.
 */
export interface ApprovalRequest {
  readonly agent: AgentLike
  readonly toolName: string
  readonly reason?: string
  /** Aborts when the asker withdraws the question. */
  readonly signal?: AbortSignal
}

/** The waterfall's `next`: hand the question to the answerers behind this listener. */
type ApprovalNext = () => Promise<ApprovalOutcome>

/** The listener shape of DSH's `approval/request` waterfall. */
export type ApprovalListener = (request: ApprovalRequest, next: ApprovalNext) => Promise<ApprovalOutcome>

/** `ctx.agents`, reduced to the calls this plugin makes. */
export interface AgentsService {
  get(id: string): AgentLike | undefined
  list(): readonly AgentLike[]
  create(options: {
    readonly sessionId: string
    readonly meta: { readonly cwd: string }
  }): Promise<{ readonly agent: AgentLike }>
  resume(options: { readonly resumeSessionId: string }): Promise<{ readonly agent: AgentLike }>
}

/** The slice of one `session/event` payload this plugin consumes. */
export interface SessionEvent {
  readonly type: string
  readonly data?: {
    readonly turn?: number
    readonly reason?: { readonly kind?: string }
    readonly title?: string
  }
}

/** The Cordis context, reduced to the members this plugin uses. */
export interface PluginContext {
  readonly agents: AgentsService
  /** Service lookup; absent on a host context the plugin was never mounted in. */
  get?(name: string): unknown
  on(name: 'session/event', listener: (session: SessionLike, event: SessionEvent) => void): () => void
  on(
    name: 'agent/status',
    listener: (payload: { readonly agent: AgentLike; readonly status: 'idle' | 'running' }) => void,
  ): () => void
  on(
    name: 'approval/request',
    listener: ApprovalListener,
    options: { readonly prepend?: boolean },
  ): () => void
  effect(setup: () => () => void): unknown
}

export interface Config {
  /** Mount anything at all, socket included; off is a hard off switch. */
  readonly enabled: boolean
  /** Emit OSC 7501 reports; off leaves the socket answering `list` only. */
  readonly programStatus: boolean
  /** The program name every report restates. */
  readonly app: string
  /** Mirror each state change as an `echo` line for `hc read`. */
  readonly echo: boolean
  /** Where the root title comes from. */
  readonly titleFrom: 'cwd-basename' | 'session-title' | 'none'
  /** Registry directory; defaults to `$DSH_HOME/supervision`. */
  readonly socketDir: string | undefined
}

/** What an omitted config field falls back to. */
export const DEFAULTS: Config = {
  enabled: true,
  programStatus: true,
  app: 'dsh',
  echo: true,
  titleFrom: 'cwd-basename',
  socketDir: undefined,
}

function reject(message: string): { readonly issues: readonly { readonly message: string }[] } {
  return { issues: [{ message }] }
}

/**
 * Validate a host-supplied config before `apply` reads it.
 * @param value - the raw plugin row from the profile.
 * @returns the config, or the fields that are wrong.
 */
export function validateConfig(
  value: unknown,
): { readonly value: Config } | { readonly issues: readonly { readonly message: string }[] } {
  if (value === undefined) return { value: DEFAULTS }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return reject('dsh-supervision config must be an object')
  }
  const raw: Record<string, unknown> = { ...value }
  const isBool = (field: unknown): field is boolean => typeof field === 'boolean'
  const isText = (field: unknown): field is string => typeof field === 'string'
  const isTitleFrom = (field: unknown): field is Config['titleFrom'] =>
    field === 'cwd-basename' || field === 'session-title' || field === 'none'

  const enabled = raw['enabled'] ?? DEFAULTS.enabled
  const programStatus = raw['programStatus'] ?? DEFAULTS.programStatus
  const echo = raw['echo'] ?? DEFAULTS.echo
  const app = raw['app'] ?? DEFAULTS.app
  const socketDir = raw['socketDir']
  const titleFrom = raw['titleFrom'] ?? DEFAULTS.titleFrom
  if (!isBool(enabled)) return reject('enabled must be a boolean')
  if (!isBool(programStatus)) return reject('programStatus must be a boolean')
  if (!isBool(echo)) return reject('echo must be a boolean')
  if (!isText(app)) return reject('app must be a string')
  if (socketDir !== undefined && !isText(socketDir)) return reject('socketDir must be a string')
  if (!isTitleFrom(titleFrom)) return reject("titleFrom must be 'cwd-basename', 'session-title' or 'none'")
  return { value: { enabled, programStatus, echo, app, titleFrom, socketDir: socketDir ?? undefined } }
}

/** The Cordis `~standard` schema the host resolves the plugin row through. */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-supervision',
    validate: validateConfig,
  },
}

export const name = 'dsh-supervision'
export const inject = ['agents']

/** The root report a bridge last put on the wire. */
interface Shown {
  readonly state: ProgramState
  readonly msg: string
  /** herdr-core holds the title in the same record, so a title change is a new record. */
  readonly title: string
  readonly kind: ProgramKind | undefined
  /** Not compared: an echo line's own trigger, unchanged by a title-only change. */
  readonly turn: number
}

/** One bridged session: its connection, its agent, and the report derived from its facts. */
interface BridgeState {
  readonly bridge: Bridge
  readonly agent: AgentLike
  /** The forwarder process that took this session, as its `hello` reported it. */
  readonly pid: number
  /** When this bridge took the session, in epoch milliseconds. */
  readonly since: number
  root: RootState
  /** The record herdr-core holds for this root, so a repeat is not a second report. */
  shown: Shown
  /** Child records this bridge reported, keyed by the `id=` herdr-core holds. */
  readonly children: Map<string, RootState>
}

/**
 * @param error - the thrown value.
 * @returns its message, for a refusal the forwarder prints verbatim.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The refusal code for a DSH call that threw. Only a filesystem-level lock is
 * recognizable today; every other failure is either a missing session or a
 * failed creation, which the caller names because only it knows the call.
 * @param error - the thrown value.
 * @param fallback - the code this call reports when nothing narrower matches.
 * @returns the code the forwarder maps to an exit status.
 */
function refusalCode(error: unknown, fallback: ErrorCode): ErrorCode {
  const code: unknown = error instanceof Error && 'code' in error ? error.code : undefined
  // shortcut: only POSIX lock errors are detected; a DSH-level writer lock would
  // need its own error class, add one when session persistence defines it.
  return code === 'ELOCKED' || code === 'EBUSY' || code === 'EEXIST' ? 'locked' : fallback
}

/** A DSH call failed in a way the forwarder can act on. */
export class BindError extends Error {
  readonly code: ErrorCode
  /** @param code - the refusal the forwarder maps to an exit code. */
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'BindError'
    this.code = code
  }
}

/**
 * Mirror of DSH `createUserMessage` (`packages/llm/llm/src/message.ts`): an
 * identified, frozen user message with a fresh id.
 * @param text - the operator's line, verbatim.
 * @returns the message `agent.steer` accepts.
 */
function userMessage(text: string): UserMessage {
  const content: readonly { readonly type: 'text'; readonly text: string }[] = [{ type: 'text', text }]
  const message: UserMessage = {
    id: randomUUID(),
    role: 'user',
    content: Object.freeze(content),
    source: { kind: 'user' },
  }
  return Object.freeze(message)
}

/** One `session/event` as a state fact; the title only when the config reads it. */
function factOf(event: SessionEvent, config: Config): StateEvent | undefined {
  switch (event.type) {
    case 'turn/start':
      return { type: 'turn/start', turn: event.data?.turn ?? 0 }
    case 'turn/end':
      return { type: 'turn/end', turn: event.data?.turn ?? 0, reason: event.data?.reason?.kind ?? '' }
    case 'session/title':
      return config.titleFrom === 'session-title' ? { type: 'title', title: event.data?.title ?? '' } : undefined
    default:
      return undefined
  }
}

/** @returns the host's route registrar, when the host serves a browser. */
function registrarOf(value: unknown): RouteRegistrar | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('register' in value) || typeof value.register !== 'function') return undefined
  return value as RouteRegistrar
}

/** @returns the host's subagent service, when one is mounted. */
function subagentsOf(value: unknown): SubagentsLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('rootOf' in value) || typeof value.rootOf !== 'function') return undefined
  return value as SubagentsLike
}

/**
 * The root `msg` one parked ask forces: what stopped the tree, and which id
 * answers it.
 * @param ask - the parked ask.
 * @returns the message the blocked root reports.
 */
function askMsg(ask: ParkedAsk): string {
  // shortcut: a reason past this cap is cut, because the encoder drops an
  // over-long record whole and a silent root would hide the ask; widen the cap
  // together with the protocol's MAX_MSG.
  const reason = ask.reason.length > 200 ? ask.reason.slice(0, 200) : ask.reason
  return `${ask.toolName}${reason === '' ? '' : ` ${reason}`} [ask ${ask.id}]`
}

/** DSH's refusal while the profile boots without an agent factory yet. */
const NO_FACTORY = 'no agent factory registered'
/** 30 s of 500 ms retries: the agent loop registers its factory while a heavy profile boots. */
const NO_FACTORY_ATTEMPTS = 60
const NO_FACTORY_DELAY_MS = 500

/**
 * Mount the plugin in two layers.
 *
 * The discovery layer opens the control socket plus its registry entry for a
 * forwarder to connect to, and — when this process is itself inside a supervised
 * terminal (`DSH_SUP_TERMINAL_ID`, or herdr-core's `HC_TERMINAL_ID`) — also
 * reports on that terminal. A forwarder can only exist by connecting, so the
 * socket layer cannot wait on one, and it touches nothing on the agent. The
 * effect layer — session listeners, OSC, echo, stdin — opens per bridge, which
 * is exactly "a forwarder is connected", and a tty bridge is this process. A
 * GUI-only `dsh web` therefore exposes an inert socket and nothing else.
 * @param ctx - the host context.
 * @param config - the validated plugin row.
 * @param openTty - the terminal opener; a fake stands in for this process's own.
 */
export function apply(ctx: PluginContext, config: Config, openTty: () => TtyOpen = openTtyIO): void {
  // `=== false`, not falsiness: a row that skipped validation must not silently
  // disable the plugin, because a disabled plugin is an unreachable socket.
  if (config.enabled === false) return

  // The socket discovery surface always opens: a forwarder can only exist by
  // connecting, and a process started inside a supervised terminal may still
  // be driven by `dsh-sup` from another one. A tty, when the process owns one,
  // is an additional reporting surface rather than an exclusive mode. `||`, not
  // `??`: an empty value falls through to herdr-core's `HC_TERMINAL_ID`.
  const transports: Transport[] = [
    new SocketTransport({
      ...(config.socketDir === undefined ? {} : { dir: config.socketDir }),
    }),
  ]
  const open = (process.env['DSH_SUP_TERMINAL_ID'] || process.env['HC_TERMINAL_ID']) ? openTty() : undefined
  // A terminal that cannot be opened drops only that surface: a full socket
  // path or a hostile umask must not hide the socket too, and the host keeps
  // its sessions either way.
  if (open !== undefined && !open.ok) {
    process.stderr.write(`dsh-supervision: no tty transport: ${open.reason}\n`)
  } else if (open !== undefined) {
    transports.push(new TtyTransport(open.io))
  }

  const { handlers, dispose, snapshot } = handlersFor(ctx, config)
  // A start failure (a full socket path, a hostile umask on the directory) must
  // not take the host process down: an unhandled rejection kills `dsh web`, and
  // the supervised session then loses its whole GUI, not just its supervisor.
  for (const transport of transports) {
    void transport.start(handlers).catch(() => transport.close())
  }

  // Read reflectively, not through `inject`: a CLI-only host mounts no webserver,
  // and a declared dependency would keep the plugin from loading there at all.
  const server = registrarOf(ctx.get?.('webServer'))
  if (server !== undefined) {
    ctx.effect(() => registerSupervisionRoutes(server, {
      snapshot,
      // Both surfaces share one bridge table, so every surface holding the
      // session must release it; `some` would leave a stale transport binding.
      reclaim: session => {
        let reclaimed = false
        for (const transport of transports) reclaimed = transport.reclaim(session) || reclaimed
        return reclaimed
      },
    }))
  }

  ctx.effect(() => () => {
    // A disposed plugin cannot answer anything: the parked asks fail closed
    // before the sockets go, so no asker waits on a supervisor that is gone.
    dispose()
    for (const transport of transports) void transport.close()
  })
}

/**
 * Build the transport callbacks. They own the live bridges, so a bridge's facts
 * never leak into another bridge's report.
 * @param ctx - the host context.
 * @param config - the validated plugin row.
 * @returns the handlers `SocketTransport.start` expects, the dispose that
 *   fails every parked ask closed, and the browser snapshot.
 */
function handlersFor(
  ctx: PluginContext,
  config: Config,
): {
  readonly handlers: TransportHandlers
  readonly dispose: () => void
  readonly snapshot: () => SupervisionState
} {
  const bridged = new Map<string, BridgeState>()
  /** The effect layer's listeners, open while at least one bridge is live. */
  let subscriptions: readonly (() => void)[] | undefined
  /**
   * The label the browser sees for the supervisor: the host's
   * `DSH_SUP_TERMINAL_NAME`, then herdr-core's `HC_TERMINAL_NAME` as a
   * compatibility fallback, then the forwarder's own `dsh-sup`.
   */
  const terminal = process.env['DSH_SUP_TERMINAL_NAME'] || process.env['HC_TERMINAL_NAME'] || 'dsh-sup'
  /**
   * The forwarder process behind each connection. `hello` is the only frame
   * that carries it, and a `/attach` or `/new` switch keeps the same process.
   */
  const pids = new WeakMap<Bridge, number>()

  /** Attach to a live agent, or resume one from persistence. */
  const bind = async (session: string): Promise<AgentLike> => {
    const live = ctx.agents.get(session)
    if (live !== undefined) return live
    try {
      return (await ctx.agents.resume({ resumeSessionId: session })).agent
    } catch (error) {
      throw new BindError(refusalCode(error, 'unknown-session'), reasonOf(error))
    }
  }

  /**
   * Create a fresh session in the directory the forwarder named.
   * @param cwd - the absolute directory the session is created in.
   * @param retryOnNoFactory - only the tty's synthesized first hello waits for
   *   the booting profile's agent factory; every operator or forwarder path
   *   fails fast with `create-failed` instead.
   */
  const create = async (cwd: string, retryOnNoFactory = false): Promise<AgentLike> => {
    // shortcut: the wait keys off DSH's "no agent factory registered" message;
    // switch to an explicit readiness signal if dsh-agent exposes one.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await ctx.agents.create({ sessionId: `session-${randomUUID()}`, meta: { cwd } })).agent
      } catch (error) {
        const reason = reasonOf(error)
        if (retryOnNoFactory && attempt < NO_FACTORY_ATTEMPTS && reason.includes(NO_FACTORY)) {
          await new Promise<void>(resolve => { setTimeout(resolve, NO_FACTORY_DELAY_MS) })
          continue
        }
        throw new BindError(refusalCode(error, 'create-failed'), reason)
      }
    }
  }

  /** The parked asks of this whole process, one queue for every bridge. */
  const asks = new ApprovalQueue(decision => {
    const state = bridged.get(decision.ask.session)
    // A departed bridge has nobody left to audit to: the ask is cancelled by
    // teardown, not decided.
    if (state === undefined) return
    if (config.echo) {
      state.bridge.send({
        t: 'echo',
        text: `[ask ${decision.ask.id}] ${decision.ask.toolName} → ${decision.outcome} (source=${decision.source})`,
      })
    }
    publish(state)
  })

  /** The asks parked for one bridge, oldest first. */
  const pendingFor = (session: string): readonly ParkedAsk[] =>
    asks.list().filter(ask => ask.session === session)

  /** The root record to report: a parked ask outranks every fact the session reports. */
  const reportOf = (state: BridgeState): ProgramStatus => {
    const [ask] = pendingFor(state.agent.session.id)
    if (ask === undefined) {
      return { state: rootWord(state.root), app: state.root.app, title: state.root.title }
    }
    return {
      state: 'blocked',
      kind: 'permission',
      msg: askMsg(ask),
      app: state.root.app,
      title: state.root.title,
    }
  }

  /** Send the root report when the record changed, plus the echo mirror. */
  const publish = (state: BridgeState): void => {
    const record = reportOf(state)
    const msg = record.msg ?? ''
    const title = record.title ?? ''
    const { shown } = state
    // A record is replaced whole, so any field it carries is part of its
    // identity: a title-only change must reach the wire.
    const changed = record.state !== shown.state || msg !== shown.msg
      || title !== shown.title || record.kind !== shown.kind
    if (config.programStatus && changed) {
      const data = programStatus(record)
      if (data !== '') state.bridge.send({ t: 'osc', data })
    }
    // A title change alone is not worth a line in the supervisor's transcript.
    if (config.echo && (state.root.turn !== shown.turn || record.state !== shown.state)) {
      state.bridge.send({ t: 'echo', text: `[turn ${String(state.root.turn)}] ${record.state}` })
    }
    state.shown = { state: record.state, msg, title, kind: record.kind, turn: state.root.turn }
  }

  /** Send one root report immediately, for a bridge that just switched session. */
  const announce = (state: BridgeState): void => {
    const record = reportOf(state)
    if (config.programStatus) {
      const data = programStatus(record)
      if (data !== '') state.bridge.send({ t: 'osc', data })
    }
    if (config.echo) {
      state.bridge.send({ t: 'echo', text: `[turn ${String(state.root.turn)}] ${record.state}` })
    }
    state.shown = {
      state: record.state,
      msg: record.msg ?? '',
      title: record.title ?? '',
      kind: record.kind,
      turn: state.root.turn,
    }
  }

  /** Fold one fact from the attached session into its root record. */
  const feed = (state: BridgeState, event: StateEvent): void => {
    state.root = reduceRootState(state.root, event)
    publish(state)
  }

  /** Report one child record; herdr-core replaces it whole, so only a changed word is sent. */
  const reportChild = (state: BridgeState, id: string, child: RootState): void => {
    if (!config.programStatus) return
    const data = programStatus({ state: rootWord(child), id })
    if (data !== '') state.bridge.send({ t: 'osc', data })
  }

  /** Fold one fact from a non-attached session into its child record; the root turn never moves. */
  const feedChild = (state: BridgeState, id: string, event: StateEvent): void => {
    const before = state.children.get(id) ?? createRootState(config.app, '')
    const after = reduceRootState(before, event)
    state.children.set(id, after)
    if (rootWord(after) !== rootWord(before)) reportChild(state, id, after)
  }

  /**
   * @param agent - any agent.
   * @returns the live root of its subagent tree, or undefined when the host
   *   cannot name one (an agent outside any tree).
   */
  const rootOf = (agent: AgentLike): AgentLike | undefined => {
    const service = subagentsOf(ctx.get?.('subagents'))
    if (service === undefined) return agent
    try {
      return service.rootOf(agent)
    } catch {
      return undefined
    }
  }

  /**
   * The bridged session an ask belongs to.
   * @param agent - the agent asking.
   * @returns the bridged root's session id when this process supervises its
   *   tree, else undefined; a request from another tree stays with its answerers.
   */
  const claimedSession = (agent: AgentLike): string | undefined => {
    const root = rootOf(agent)
    // `session.id`, not `header.id`: the bridge is claimed by the session the
    // host's `agents.get` answers to (`packages/subagent/subagent/src/manager.ts:503`).
    return root !== undefined && bridged.has(root.session.id) ? root.session.id : undefined
  }

  /** Whether `agent` belongs to another agent's tree, per the host's subagent service. */
  const isSubagent = (agent: AgentLike): boolean => {
    const root = rootOf(agent)
    return root !== undefined && root !== agent
  }

  /** The child record id for a live session that is not the attached one. */
  const childIdOf = (agent: AgentLike): string =>
    isSubagent(agent) ? `sub/${agent.session.id}` : agent.session.id

  /** Report every other live session as a child record. */
  const seedChildren = (state: BridgeState): void => {
    for (const agent of ctx.agents.list()) {
      if (agent.session.id === state.agent.session.id) continue
      const id = childIdOf(agent)
      if (state.children.has(id)) continue
      const child = createRootState(config.app, '')
      state.children.set(id, child)
      reportChild(state, id, child)
    }
  }

  /** Remove every child record this bridge reported. */
  const clearChildren = (state: BridgeState): void => {
    for (const id of state.children.keys()) {
      if (!config.programStatus) continue
      const data = clearProgramStatus(id)
      if (data !== '') state.bridge.send({ t: 'osc', data })
    }
    state.children.clear()
  }

  /**
   * Answer one approval question from a bridged tree, or delegate it.
   * @param request - the pending question.
   * @param next - the answerers behind this listener.
   * @returns the supervisor's decision, or whatever the next answerer decides.
   */
  const answer: ApprovalListener = async (request, next) => {
    const session = claimedSession(request.agent)
    const state = session === undefined ? undefined : bridged.get(session)
    if (session === undefined || state === undefined) return next()
    // The host checks this before dispatch, so a trip here is that race window:
    // an asker that already withdrew must not park an ask nobody can answer.
    if (request.signal?.aborted === true) return 'cancelled'

    const id = asks.park(
      { toolName: request.toolName, ...(request.reason === undefined ? {} : { reason: request.reason }) },
      session,
    )
    const outcome = asks.outcome(id)
    // `park` always leaves a promise; without one there is nothing to wait on,
    // so the question stays with the answerers behind this listener.
    if (outcome === undefined) return next()

    if (config.echo) {
      state.bridge.send({ t: 'echo', text: `[ask ${id}] ${request.toolName} parked (${session})` })
    }
    publish(state)

    // The asker may withdraw its own question; that settles it as a decision
    // the supervisor did not make, and the root must leave `blocked`.
    const withdraw = (): void => { asks.settle(id, 'cancelled', 'attached') }
    request.signal?.addEventListener('abort', withdraw)
    try {
      return await outcome
    } finally {
      request.signal?.removeEventListener('abort', withdraw)
    }
  }

  /** Open the effect layer's listeners, and keep their disposers. */
  const openSubscriptions = (): void => {
    if (subscriptions !== undefined) return
    const offSession = ctx.on('session/event', (subject, event) => {
      const fact = factOf(event, config)
      if (fact === undefined) return
      for (const state of bridged.values()) {
        if (subject.id === state.agent.session.id) {
          feed(state, fact)
          continue
        }
        const agent = ctx.agents.get(subject.id)
        if (agent !== undefined) feedChild(state, childIdOf(agent), fact)
      }
    })
    const offStatus = ctx.on('agent/status', payload => {
      for (const state of bridged.values()) {
        if (payload.agent !== state.agent) continue
        feed(state, { type: 'agent/status', status: payload.status })
      }
    })
    // Prepended, and only alive while a bridge is: without one the browser's
    // own answerer runs untouched, and a claimed ask never reaches it.
    const offApproval = ctx.on('approval/request', answer, { prepend: true })
    subscriptions = [offSession, offStatus, offApproval]
  }

  /** Resolve the asks parked for one bridge; with the last bridge, every ask. */
  const cancelAsks = (session: string): void => {
    if (bridged.size === 0) {
      // Nothing is left to answer anything, so nothing may stay parked.
      asks.clearAll('cancelled')
      return
    }
    for (const ask of pendingFor(session)) asks.settle(ask.id, 'cancelled', 'attached')
  }

  /** Drop one session's records and, with the last bridge, its listeners. */
  const release = (session: string): void => {
    const state = bridged.get(session)
    bridged.delete(session)
    // Fail closed before the records go: an ask belongs to the bridge that
    // raised it, and its asker must not hang on a question nobody will answer.
    cancelAsks(session)
    if (state === undefined) return
    clearChildren(state)
    if (bridged.size > 0 || subscriptions === undefined) return
    for (const off of subscriptions) off()
    subscriptions = undefined
  }

  /** The root title for a session, from the configured source. */
  const titleFor = (agent: AgentLike, cwd: string): string => {
    // `session-title` arrives later via `session/title`; `none` reports nothing.
    if (config.titleFrom !== 'cwd-basename') return ''
    return basename(agent.session.header?.cwd ?? cwd) || basename(process.cwd())
  }

  /**
   * Bind this bridge to `agent`: claim it, drop the previous session's records,
   * and report the new root state.
   * @param agent - the session now under supervision.
   * @param bridge - the connection that drives it.
   * @param greet - `welcome` only for `hello`; the forwarder pumps stdin on it.
   */
  const establish = (agent: AgentLike, bridge: Bridge, greet: 'welcome' | 'root'): boolean => {
    const session = agent.session.id
    // The shared table is the single-owner rule across both surfaces: a claim
    // that only checks its own transport cannot see the other one, and two
    // racing hellos would last-write-wins. Refuse before any state is touched.
    const held = bridged.get(session)
    if (held !== undefined && held.bridge !== bridge) return false
    const previous = bridge.session
    // The claim is what makes a session single-owner and it precedes every
    // frame, so a racing second forwarder is refused rather than half-bound.
    if (!bridge.claim(session)) return false
    // The transport releases the old session on a switch; repeating it here
    // keeps this function idempotent and independent of that ordering detail.
    if (previous !== undefined) release(previous)

    const root = createRootState(config.app, titleFor(agent, process.cwd()))
    const state: BridgeState = {
      bridge,
      agent,
      pid: pids.get(bridge) ?? 0,
      since: Date.now(),
      root,
      shown: { state: root.current.state, msg: '', title: root.current.title, kind: undefined, turn: root.turn },
      children: new Map(),
    }
    bridged.set(session, state)
    openSubscriptions()

    if (greet === 'welcome') {
      // The root word is the forwarder's readiness signal, so it leaves before
      // any subscription could produce a frame behind it.
      bridge.send({
        t: 'welcome',
        proto: PROTO,
        session,
        title: root.current.title,
        state: root.current.state,
        turn: root.turn,
      })
    } else {
      announce(state)
    }
    // A child report alone sets `reported`, so children follow the root word.
    seedChildren(state)
    return true
  }

  /**
   * Refuse a session switch while an ask is parked: the ask belongs to the tree
   * the supervisor is watching, and a switch would orphan it.
   * @param state - the bridge that asked to switch.
   * @returns true when the caller must stop.
   */
  const refuseWhileParked = (state: BridgeState): boolean => {
    const parked = pendingFor(state.agent.session.id)
    if (parked.length === 0) return false
    state.bridge.send({ t: 'echo', text: `refused: ${String(parked.length)} approval(s) parked` })
    return true
  }

  const handlers: TransportHandlers = {
    async hello(frame: HelloFrame, bridge: Bridge): Promise<void> {
      let agent: AgentLike
      pids.set(bridge, frame.pid)
      // One bridge per session across both surfaces: an attach to a session the
      // other surface holds is refused before it could overwrite that state.
      if ('attach' in frame) {
        const held = bridged.get(frame.attach)
        if (held !== undefined && held.bridge !== bridge) {
          bridge.send({
            t: 'error',
            code: 'busy',
            message: `session ${frame.attach} is already bridged`,
          })
          bridge.close()
          return
        }
      }
      try {
        agent = 'attach' in frame
          ? await bind(frame.attach)
          : await create('new' in frame ? frame.new.cwd : process.cwd(), bridge.retryOnNoFactory === true)
      } catch (error) {
        bridge.send({
          t: 'error',
          code: error instanceof BindError ? error.code : 'internal',
          message: reasonOf(error),
        })
        bridge.close()
        return
      }

      // The early attach check above is the fast path; this one catches a hello
      // that raced another bridge into the shared table while it was binding.
      if (!establish(agent, bridge, 'welcome')) {
        bridge.send({
          t: 'error',
          code: 'busy',
          message: `session ${agent.session.id} is already bridged`,
        })
        bridge.close()
      }
    },

    line(text: string, bridge: Bridge): void {
      const state = bridge.session === undefined ? undefined : bridged.get(bridge.session)
      if (state === undefined) return
      const command = parseLine(text)
      // A blank line is framing, not a turn.
      if (command === undefined) return
      switch (command.kind) {
        case 'steer':
          state.agent.steer(userMessage(command.text))
          return
        case 'cancel':
          state.agent.cancel({ kind: 'user' })
          return
        case 'status': {
          const ids = pendingFor(state.agent.session.id).map(ask => ask.id)
          bridge.send({
            t: 'echo',
            text: `session=${state.agent.session.id} state=${reportOf(state).state}`
              + ` turn=${String(state.root.turn)} asks=${ids.length === 0 ? '-' : ids.join(',')}`,
          })
          return
        }
        case 'new': {
          if (refuseWhileParked(state)) return
          // Nothing resolves a relative path: the forwarder pumps the line
          // verbatim, so accepting one would silently create the session
          // somewhere else entirely.
          const cwd = command.cwd ?? state.agent.session.header?.cwd ?? process.cwd()
          if (!isAbsolute(cwd)) {
            bridge.send({ t: 'echo', text: `new failed: ${cwd} is not an absolute path` })
            return
          }
          void create(cwd).then(
            agent => {
              if (!establish(agent, bridge, 'root')) {
                bridge.send({ t: 'echo', text: `new failed: session ${agent.session.id} is already bridged` })
              }
            },
            (error: unknown) => { bridge.send({ t: 'echo', text: `new failed: ${reasonOf(error)}` }) },
          )
          return
        }
        case 'attach':
          if (refuseWhileParked(state)) return
          void bind(command.session).then(
            agent => {
              if (!establish(agent, bridge, 'root')) {
                bridge.send({ t: 'echo', text: `attach failed: session ${agent.session.id} is already bridged` })
              }
            },
            (error: unknown) => { bridge.send({ t: 'echo', text: `attach failed: ${reasonOf(error)}` }) },
          )
          return
        case 'approve':
        case 'reject': {
          const outcome: ApprovalOutcome = command.kind === 'approve' ? 'allowed-once' : 'rejected'
          // A named ask may belong to another bridge in this process; its own
          // supervisor still receives the audit line.
          if (!asks.settle(command.ask, outcome, 'supervisor')) {
            bridge.send({ t: 'echo', text: `no ask ${command.ask}` })
          }
          return
        }
        case 'yes':
        case 'no': {
          const parked = pendingFor(state.agent.session.id)
          const [only] = parked
          if (only === undefined) {
            bridge.send({ t: 'echo', text: 'no approval pending' })
            return
          }
          if (parked.length > 1) {
            bridge.send({ t: 'echo', text: `${String(parked.length)} asks pending; name one` })
            return
          }
          asks.settle(only.id, command.kind === 'yes' ? 'allowed-once' : 'rejected', 'supervisor')
          return
        }
        case 'unknown':
          bridge.send({ t: 'echo', text: `unknown command /${command.verb}` })
          return
      }
    },

    list(cwd: string | undefined): readonly SessionItem[] {
      // The shared bridge table, not one transport's private one: with both
      // surfaces mounted, a session held by the tty is bridged to the socket too.
      return ctx.agents.list()
        .map(agent => ({
          id: agent.session.id,
          cwd: agent.session.header?.cwd ?? '',
          live: true,
          bridged: bridged.has(agent.session.id),
        }))
        .filter(item => cwd === undefined || item.cwd === cwd)
    },

    bye(session: string): void {
      release(session)
    },
  }

  const snapshot = (): SupervisionState => {
    const facts = new Map<string, SupervisionFacts>()
    for (const [session, state] of bridged) {
      // The approval queue owns the parked ids; deriving them here keeps the
      // browser's asks column and `/status` from ever disagreeing.
      facts.set(session, {
        pid: state.pid,
        since: state.since,
        asks: pendingFor(state.agent.session.id).map(ask => ask.id),
      })
    }
    return supervisionState(facts, terminal)
  }

  return {
    handlers,
    /** Fail every parked ask closed and drop what is left, for plugin disposal. */
    dispose: (): void => {
      for (const session of [...bridged.keys()]) release(session)
    },
    snapshot,
  }
}
