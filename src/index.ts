/**
 * The Cordis plugin: it owns the control socket, one root report per bridged
 * session, and the activation gate that keeps a GUI-only `dsh web` untouched.
 *
 * The DSH host is not a dependency of this package (the host loads the plugin,
 * not the reverse), so the few services it touches are declared structurally
 * below. That declaration is the whole host seam.
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { PROTO, programStatus } from 'dsh-supervision-protocol'
import type { ErrorCode, HelloFrame, SessionItem } from 'dsh-supervision-protocol'
import { createRootState, reduceRootState } from './state.js'
import type { RootState, StateEvent } from './state.js'
import { SocketTransport } from './transport.js'
import type { Bridge, Transport } from './transport.js'

/** The parts of a DSH Session this plugin reads. */
interface SessionLike {
  readonly id: string
  readonly header?: { readonly cwd?: string }
}

/** The parts of a DSH Agent this plugin reads. */
interface AgentLike {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: SessionLike
}

/** `ctx.agents`, reduced to the calls P0 makes. */
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

/** The Cordis context, reduced to the members P0 uses. */
export interface PluginContext {
  readonly agents: AgentsService
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

/** One bridged session: its connection and the report derived from its facts. */
interface BridgeState {
  readonly bridge: Bridge
  root: RootState
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
  /** Per-session listener disposers, released when that bridge goes away. */
  const listeners = new Map<string, readonly (() => void)[]>()

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

  /** Fold one fact from a bridged session into its root record. */
  const feed = (session: string, event: StateEvent): void => {
    const state = bridged.get(session)
    if (state === undefined) return
    const before = state.root
    state.root = reduceRootState(state.root, event)
    publish(state, before)
  }

  /** Subscribe once per bridged session and keep the disposers for `bye`. */
  const subscribe = (session: string, agent: AgentLike): void => {
    if (listeners.has(session)) return
    const offSession = ctx.on('session/event', (subject, event) => {
      if (subject.id !== session) return
      switch (event.type) {
        case 'turn/start':
          feed(session, { type: 'turn/start', turn: event.data?.turn ?? 0 })
          return
        case 'turn/end':
          feed(session, { type: 'turn/end', turn: event.data?.turn ?? 0, reason: event.data?.reason?.kind ?? '' })
          return
        case 'session/title':
          if (config.titleFrom === 'session-title') feed(session, { type: 'title', title: event.data?.title ?? '' })
          return
        default:
          return
      }
    })
    const offStatus = ctx.on('agent/status', payload => {
      if (payload.agent !== agent) return
      feed(session, { type: 'agent/status', status: payload.status })
    })
    listeners.set(session, [offSession, offStatus])
  }

  /** The root title for a session, from the configured source. */
  const titleFor = (agent: AgentLike, cwd: string): string => {
    // `session-title` arrives later via `session/title`; `none` reports nothing.
    if (config.titleFrom !== 'cwd-basename') return ''
    return basename(agent.session.header?.cwd ?? cwd) || basename(process.cwd())
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

      // The claim is what makes a session single-owner and it precedes the
      // welcome, so a racing second forwarder is refused rather than half-bound.
      if (!bridge.claim(agent.session.id)) return

      const root = createRootState(config.app, titleFor(agent, process.cwd()))
      bridged.set(agent.session.id, { bridge, root })

      // The root word is the forwarder's readiness signal, so it leaves before
      // any subscription could produce a frame behind it.
      bridge.send({
        t: 'welcome',
        proto: PROTO,
        session: agent.session.id,
        title: root.current.title,
        state: root.current.state,
        turn: root.turn,
      })
      subscribe(agent.session.id, agent)
    },

    line(): void {
      // The input grammar is P1. A line with nowhere to go is dropped rather
      // than answered, so the forwarder never mistakes it for a command.
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
      for (const off of listeners.get(session) ?? []) off()
      listeners.delete(session)
      bridged.delete(session)
    },
  }
}
