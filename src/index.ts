/**
 * The Cordis plugin: it owns the control socket, one root report per bridged
 * session, and the activation gate that keeps a GUI-only `dsh web` untouched.
 *
 * The DSH host is not a dependency of this package (the host loads the plugin,
 * not the reverse), so the few services it touches are declared structurally
 * below. That declaration is the whole host seam.
 */

import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { PROTO, clearProgramStatus, programStatus } from 'dsh-supervision-protocol'
import type { ErrorCode, HelloFrame, SessionItem } from 'dsh-supervision-protocol'
import { createRootState, reduceRootState, rootWord } from './state.js'
import type { RootState, StateEvent } from './state.js'
import { parseLine } from './stdin.js'
import { SocketTransport } from './transport.js'
import type { Bridge, Transport } from './transport.js'

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

/** One bridged session: its connection, its agent, and the report derived from its facts. */
interface BridgeState {
  readonly bridge: Bridge
  readonly agent: AgentLike
  root: RootState
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

/** @returns the host's subagent service, when one is mounted. */
function subagentsOf(value: unknown): SubagentsLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('rootOf' in value) || typeof value.rootOf !== 'function') return undefined
  return value as SubagentsLike
}

/**
 * Mount the plugin in two layers.
 *
 * Discovery always opens the socket and writes the registry entry: a forwarder
 * can only exist by connecting to it, so this layer cannot wait on one, and it
 * touches nothing on the agent. The effect layer — session listeners, OSC,
 * echo, stdin — opens per bridge, which is exactly "a forwarder is connected";
 * transport A (`HC_TERMINAL_ID`, the process itself inside an hc terminal)
 * reaches the same per-session layer without a socket, in §5.1. A GUI-only
 * `dsh web` therefore exposes an inert socket and nothing else.
 * @param ctx - the host context.
 * @param config - the validated plugin row.
 */
export function apply(ctx: PluginContext, config: Config): void {
  // `=== false`, not falsiness: a row that skipped validation must not silently
  // disable the plugin, because a disabled plugin is an unreachable socket.
  if (config.enabled === false) return

  const transport = new SocketTransport({
    ...(config.socketDir === undefined ? {} : { dir: config.socketDir }),
  })
  // A start failure (a full socket path, a hostile umask on the directory) must
  // not take the host process down: an unhandled rejection kills `dsh web`, and
  // the supervised session then loses its whole GUI, not just its supervisor.
  void transport.start(handlersFor(ctx, config)).catch(() => transport.close())

  ctx.effect(() => () => {
    void transport.close()
  })
}

/**
 * Build the transport callbacks. They own the live bridges, so a bridge's facts
 * never leak into another bridge's report.
 * @param ctx - the host context.
 * @param config - the validated plugin row.
 * @returns the handlers `SocketTransport.start` expects.
 */
function handlersFor(ctx: PluginContext, config: Config): Parameters<Transport['start']>[0] {
  const bridged = new Map<string, BridgeState>()
  /** The effect layer's listeners, open while at least one bridge is live. */
  let subscriptions: readonly (() => void)[] | undefined

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

  /** Create a fresh session in the directory the forwarder named. */
  const create = async (cwd: string): Promise<AgentLike> => {
    try {
      return (await ctx.agents.create({ sessionId: `session-${randomUUID()}`, meta: { cwd } })).agent
    } catch (error) {
      throw new BindError(refusalCode(error, 'create-failed'), reasonOf(error))
    }
  }

  /** Send the root report when the record changed, plus the echo mirror. */
  const publish = (state: BridgeState, before: RootState): void => {
    const { root } = state
    // Identity, not equality: the reducer keeps the record when nothing changed,
    // which is what stops a repeated word from becoming a second report.
    if (config.programStatus && root.current !== before.current) {
      const data = programStatus(root.current)
      if (data !== '') state.bridge.send({ t: 'osc', data })
    }
    // A title change alone is not worth a line in the supervisor's transcript.
    if (config.echo && (root.turn !== before.turn || root.current.state !== before.current.state)) {
      state.bridge.send({ t: 'echo', text: `[turn ${String(root.turn)}] ${root.current.state}` })
    }
  }

  /** Send one root report immediately, for a bridge that just switched session. */
  const announce = (bridge: Bridge, root: RootState): void => {
    if (config.programStatus) {
      const data = programStatus(root.current)
      if (data !== '') bridge.send({ t: 'osc', data })
    }
    if (config.echo) bridge.send({ t: 'echo', text: `[turn ${String(root.turn)}] ${root.current.state}` })
  }

  /** Fold one fact from the attached session into its root record. */
  const feed = (state: BridgeState, event: StateEvent): void => {
    const before = state.root
    state.root = reduceRootState(state.root, event)
    publish(state, before)
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

  /** Whether `agent` belongs to another agent's tree, per the host's subagent service. */
  const isSubagent = (agent: AgentLike): boolean => {
    const service = subagentsOf(ctx.get?.('subagents'))
    if (service === undefined) return false
    try {
      return service.rootOf(agent) !== agent
    } catch {
      // An agent outside any tree is its own root.
      return false
    }
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

  /** Open the effect layer's one subscription pair, and keep its disposers. */
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
    subscriptions = [offSession, offStatus]
  }

  /** Drop one session's records and, with the last bridge, its listeners. */
  const release = (session: string): void => {
    const state = bridged.get(session)
    bridged.delete(session)
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
  const establish = (agent: AgentLike, bridge: Bridge, greet: 'welcome' | 'root'): void => {
    const session = agent.session.id
    const previous = bridge.session
    // The claim is what makes a session single-owner and it precedes every
    // frame, so a racing second forwarder is refused rather than half-bound.
    if (!bridge.claim(session)) return
    // The transport releases the old session on a switch; repeating it here
    // keeps this function idempotent and independent of that ordering detail.
    if (previous !== undefined) release(previous)

    const root = createRootState(config.app, titleFor(agent, process.cwd()))
    const state: BridgeState = { bridge, agent, root, children: new Map() }
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
      announce(bridge, root)
    }
    // A child report alone sets `reported`, so children follow the root word.
    seedChildren(state)
  }

  return {
    async hello(frame: HelloFrame, bridge: Bridge): Promise<void> {
      let agent: AgentLike
      try {
        agent = 'attach' in frame
          ? await bind(frame.attach)
          : await create('new' in frame ? frame.new.cwd : process.cwd())
      } catch (error) {
        bridge.send({
          t: 'error',
          code: error instanceof BindError ? error.code : 'internal',
          message: reasonOf(error),
        })
        bridge.close()
        return
      }

      establish(agent, bridge, 'welcome')
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
        case 'status':
          bridge.send({
            t: 'echo',
            text: `session=${state.agent.session.id} state=${state.root.current.state}`
              + ` turn=${String(state.root.turn)} asks=-`,
          })
          return
        case 'new': {
          // A relative argument resolves in the forwarder, never in the web process.
          const cwd = command.cwd !== undefined && isAbsolute(command.cwd)
            ? command.cwd
            : state.agent.session.header?.cwd ?? process.cwd()
          void create(cwd).then(
            agent => { establish(agent, bridge, 'root') },
            (error: unknown) => { bridge.send({ t: 'echo', text: `new failed: ${reasonOf(error)}` }) },
          )
          return
        }
        case 'attach':
          void bind(command.session).then(
            agent => { establish(agent, bridge, 'root') },
            (error: unknown) => { bridge.send({ t: 'echo', text: `attach failed: ${reasonOf(error)}` }) },
          )
          return
        case 'approve':
        case 'reject':
        case 'yes':
        case 'no':
          // The approval bridge is P2; until it exists there is nothing to settle.
          bridge.send({ t: 'echo', text: 'no approval pending' })
          return
        case 'unknown':
          bridge.send({ t: 'echo', text: `unknown command /${command.verb}` })
          return
      }
    },

    list(cwd: string | undefined, isBridged: (session: string) => boolean): readonly SessionItem[] {
      return ctx.agents.list()
        .map(agent => ({
          id: agent.session.id,
          cwd: agent.session.header?.cwd ?? '',
          live: true,
          bridged: isBridged(agent.session.id),
        }))
        .filter(item => cwd === undefined || item.cwd === cwd)
    },

    bye(session: string): void {
      release(session)
    },
  }
}
