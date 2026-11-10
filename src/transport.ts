/**
 * The control transport: one Unix socket per `dsh web` process, one bridge per
 * session, NDJSON frames. The frame codec and the registry format are pure and
 * exported so tests and `dsh-sup` share the same rules; only `SocketTransport`
 * touches `net` and `fs`.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import type { ProgramState } from './osc.js'

/** One frame, newline included, never larger than this. */
export const MAX_FRAME = 64 * 1024
/** The only protocol version either side speaks. */
export const PROTO = 1

export type ErrorCode =
  | 'busy'
  | 'unknown-session'
  | 'create-failed'
  | 'locked'
  | 'protocol'
  | 'internal'

export interface SessionItem {
  readonly id: string
  readonly cwd: string
  readonly live: boolean
  readonly bridged: boolean
}

export type HelloFrame =
  | { readonly t: 'hello'; readonly proto: number; readonly pid: number; readonly attach: string }
  | { readonly t: 'hello'; readonly proto: number; readonly pid: number; readonly new: { readonly cwd: string } }
  | { readonly t: 'hello'; readonly proto: number; readonly pid: number }

export type InFrame =
  | HelloFrame
  | { readonly t: 'line'; readonly text: string }
  | { readonly t: 'list'; readonly cwd?: string }
  | { readonly t: 'bye' }

export type Welcome = {
  readonly t: 'welcome'
  readonly proto: number
  readonly session: string
  readonly title: string
  readonly state: ProgramState
  readonly turn: number
}

export type OutFrame =
  | Welcome
  | { readonly t: 'osc'; readonly data: string }
  | { readonly t: 'echo'; readonly text: string }
  | { readonly t: 'sessions'; readonly items: readonly SessionItem[] }
  | { readonly t: 'error'; readonly code: ErrorCode; readonly message: string }
  | { readonly t: 'bye'; readonly reason: string }

/** A frame was rejected before it could reach a peer. */
export class ProtocolError extends Error {
  readonly code: ErrorCode
  /** @param code - the protocol error the forwarder maps to an exit code. */
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
  }
}

/** One accepted forwarder connection. */
export interface Bridge {
  /** The session this connection drives; absent until it claims one. */
  readonly session: string | undefined
  /**
   * Bind a session to this connection. A session has exactly one bridge: when
   * another connection already holds it, this connection is refused with
   * `busy` and closed, so the caller never has to reproduce that rule.
   * @returns true when the session is now bound here.
   */
  claim(session: string): boolean
  send(frame: OutFrame): void
  close(): void
}

export interface TransportHandlers {
  /** Bind a `hello` to a session: attach, resume, or create. */
  hello(frame: HelloFrame, bridge: Bridge): Promise<void>
  /** A stdin line from a bound forwarder. */
  line(text: string, bridge: Bridge): void
  /** The attachable sessions for a `list`; never binds anything. */
  list(cwd: string | undefined, bridged: (session: string) => boolean): readonly SessionItem[]
  /** The bridge holding `session` is gone: it said goodbye, dropped, or moved. */
  bye(session: string): void
}

export interface Transport {
  start(handlers: TransportHandlers): Promise<void>
  send(frame: OutFrame, session?: string): void
  close(): Promise<void>
}

/**
 * The registry directory: `$DSH_HOME/supervision`, `~/.dsh` when unset.
 * @returns an absolute path; nothing is created here.
 */
export function supervisionDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'supervision')
}

/** Registry entry as written to `<pid>-<8hex>.json`. */
export interface RegistryEntry {
  readonly proto: number
  readonly pid: number
  readonly socket: string
  readonly startedAt: number
  readonly dshVersion: string
}

/** The two paths one plugin instance owns. */
export interface RegistryPaths {
  readonly socket: string
  readonly json: string
}

/**
 * The paths for one instance. The session id never appears in a path: a Unix
 * socket path is capped near 103 bytes and an id would overflow it.
 * @param dir - the supervision directory.
 * @param pid - the owning process.
 * @param token - 8 hex characters, unique per instance in that process.
 */
export function registryPaths(dir: string, pid: number, token: string): RegistryPaths {
  const stem = join(dir, `${String(pid)}-${token}`)
  return { socket: `${stem}.sock`, json: `${stem}.json` }
}

/** @returns 8 random hex characters, the per-instance collision breaker. */
export function newToken(): string {
  return randomBytes(4).toString('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Prove a registry entry's shape. `JSON.parse` output is `unknown` until this
 * returns; a half-written or hand-edited file must never reach the transport.
 * @param value - parsed JSON.
 * @returns true when every field has the type the protocol promises.
 */
export function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (!isRecord(value)) return false
  const { proto, pid, socket, startedAt, dshVersion } = value
  return proto === PROTO
    && typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
    && typeof socket === 'string' && socket !== ''
    && typeof startedAt === 'number' && Number.isFinite(startedAt)
    && typeof dshVersion === 'string'
}

/**
 * Create the supervision directory with `0700`.
 * @param dir - absolute path.
 */
export function ensureRegistryDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdirSync's mode is masked by the umask and ignored on an existing directory.
  chmodSync(dir, 0o700)
}

/**
 * @param pid - the process to test.
 * @returns true when the process exists.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM is a live process owned by someone else. It cannot happen for a
    // same-user socket, but mistaking it for a corpse would unlink a live one.
    return isRecord(error) && error['code'] === 'EPERM'
  }
}

/**
 * Read every registry entry in a directory.
 * @param dir - the supervision directory.
 * @returns the valid entries, in directory order.
 */
export function readRegistry(dir: string): readonly RegistryEntry[] {
  const entries: RegistryEntry[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (isRegistryEntry(parsed)) entries.push(parsed)
    } catch {
      // A concurrent writer is mid-rename or the file is corrupt. Skipping it
      // keeps the healthy entries visible; the next scan reclaims the bad one.
      continue
    }
  }
  return entries
}

/**
 * Remove entries whose process is gone or whose socket is missing, together
 * with their files. An entry is only worth keeping when both halves are live.
 * @param dir - the supervision directory.
 * @returns the pids whose entries were removed.
 */
export function reclaimStale(dir: string): readonly number[] {
  const removed: number[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // Unparseable: nothing can prove it alive, so it is stale by definition.
      unlinkEntry(path, dir, name)
      continue
    }
    if (isRegistryEntry(parsed)) {
      if (isAlive(parsed.pid) && existsSync(parsed.socket)) continue
      removed.push(parsed.pid)
    }
    unlinkEntry(path, dir, name)
  }
  return removed
}

function unlinkEntry(path: string, dir: string, name: string): void {
  rmSync(path, { force: true })
  rmSync(join(dir, name.replace(/\.json$/, '.sock')), { force: true })
}

/**
 * Write one registry entry with `0600`.
 * @param paths - the entry's two paths.
 * @param entry - the entry to write.
 */
export function writeRegistry(paths: RegistryPaths, entry: RegistryEntry): void {
  writeFileSync(paths.json, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  // writeFileSync's mode is masked by the umask; the socket is the trust boundary.
  chmodSync(paths.json, 0o600)
}

/**
 * Encode one outbound frame.
 * @param frame - the frame to send.
 * @returns the frame plus its newline.
 * @throws ProtocolError `protocol` when the frame exceeds {@link MAX_FRAME}.
 */
export function encodeFrame(frame: OutFrame): string {
  const line = `${JSON.stringify(frame)}\n`
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) {
    throw new ProtocolError('protocol', `frame exceeds ${String(MAX_FRAME)} bytes`)
  }
  return line
}

/**
 * Decode one inbound line. Every field is proven here, so handlers never have
 * to re-check a shape that arrived over the socket.
 * @param line - one line without its newline.
 * @returns the frame, or `undefined` when any field is missing or mistyped.
 */
export function decodeFrame(line: string): InFrame | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  switch (parsed['t']) {
    case 'hello': {
      const { proto, pid, attach, new: created } = parsed
      if (typeof proto !== 'number' || typeof pid !== 'number' || !Number.isSafeInteger(pid)) return undefined
      const head = { t: 'hello', proto, pid } as const
      // `attach` and `new` are exclusive; both at once is a malformed frame, not
      // a precedence puzzle. An empty session id or cwd is not a target either.
      if (attach !== undefined && created !== undefined) return undefined
      if (attach !== undefined) {
        return typeof attach === 'string' && attach !== '' ? { ...head, attach } : undefined
      }
      if (created === undefined) return head
      if (!isRecord(created)) return undefined
      const cwd = created['cwd']
      return typeof cwd === 'string' && cwd !== '' ? { ...head, new: { cwd } } : undefined
    }
    case 'line': {
      const text = parsed['text']
      return typeof text === 'string' ? { t: 'line', text } : undefined
    }
    case 'list': {
      const cwd = parsed['cwd']
      if (cwd === undefined) return { t: 'list' }
      return typeof cwd === 'string' ? { t: 'list', cwd } : undefined
    }
    case 'bye':
      return { t: 'bye' }
    default:
      return undefined
  }
}

/**
 * One accepted connection. It is its own `Bridge`, and it serializes dispatch so
 * a `welcome` always leaves before a frame that depends on the binding.
 */
class Connection implements Bridge {
  session: string | undefined
  pending = ''
  /** Orders asynchronous handlers: a slow `hello` must not overtake a `line`. */
  #queue: Promise<void> = Promise.resolve()
  readonly socket: Socket
  readonly #bind: (connection: Connection, session: string) => boolean

  constructor(socket: Socket, bind: (connection: Connection, session: string) => boolean) {
    this.socket = socket
    this.#bind = bind
  }

  claim(session: string): boolean {
    if (this.#bind(this, session)) return true
    this.send({ t: 'error', code: 'busy', message: `session ${session} is already bridged` })
    this.close()
    return false
  }

  send(frame: OutFrame): void {
    try {
      this.socket.write(encodeFrame(frame))
    } catch {
      // An oversized frame means this connection's peer cannot be served
      // correctly; closing is louder than writing half a record into herdr.
      this.close()
    }
  }

  close(): void {
    this.socket.end()
  }

  /** @returns a promise settled after `work`, chained behind earlier work. */
  enqueue(work: () => Promise<void> | void): Promise<void> {
    this.#queue = this.#queue.then(work).catch((error: unknown) => {
      this.send({ t: 'error', code: 'internal', message: String(error) })
      this.close()
    })
    return this.#queue
  }
}

/**
 * The socket transport: it owns the listener, the registry files, and the
 * session→connection binding that makes a session single-owner.
 */
export class SocketTransport implements Transport {
  readonly #dir: string
  readonly #paths: RegistryPaths
  readonly #dshVersion: string
  readonly #bridged = new Map<string, Connection>()
  readonly #connections = new Set<Connection>()
  #server: Server | undefined
  #handlers: TransportHandlers | undefined

  /**
   * Paths and the version string are fixed at construction so `socketPath` is
   * known before `start()` resolves.
   * @param options - `dir` overrides the supervision directory.
   */
  constructor(options: { readonly dir?: string; readonly dshVersion?: string } = {}) {
    this.#dir = options.dir ?? supervisionDir()
    this.#paths = registryPaths(this.#dir, process.pid, newToken())
    this.#dshVersion = options.dshVersion ?? 'unknown'
  }

  /** @returns the socket this instance serves, for `dsh-sup --pid`. */
  get socketPath(): string {
    return this.#paths.socket
  }

  async start(handlers: TransportHandlers): Promise<void> {
    this.#handlers = handlers
    ensureRegistryDir(this.#dir)
    reclaimStale(this.#dir)

    const server = createServer(socket => { this.#accept(socket) })
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.#paths.socket, () => {
        server.off('error', reject)
        resolve()
      })
    })
    chmodSync(this.#paths.socket, 0o600)
    writeRegistry(this.#paths, {
      proto: PROTO,
      pid: process.pid,
      socket: this.#paths.socket,
      startedAt: Date.now(),
      dshVersion: this.#dshVersion,
    })
  }

  send(frame: OutFrame, session?: string): void {
    if (session === undefined) {
      for (const connection of this.#connections) connection.send(frame)
      return
    }
    this.#bridged.get(session)?.send(frame)
  }

  async close(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    // Registered bridges hear about the disposal before their sockets close, so
    // the forwarder can report `clear` instead of seeing a bare EOF. The bridge
    // map empties first: nothing may answer a frame that arrives mid-dispose.
    this.#bridged.clear()
    await Promise.all([...this.#connections].map(connection => new Promise<void>(resolve => {
      if (connection.socket.destroyed) { resolve(); return }
      connection.socket.end(encodeFrame({ t: 'bye', reason: 'plugin-disposed' }), () => {
        connection.socket.destroy()
        resolve()
      })
    })))
    if (server !== undefined) {
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
    this.#connections.clear()
    rmSync(this.#paths.socket, { force: true })
    rmSync(this.#paths.json, { force: true })
  }

  #accept(socket: Socket): void {
    const connection = new Connection(socket, (subject, session) => this.#claim(subject, session))
    this.#connections.add(connection)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { this.#read(connection, chunk) })
    socket.on('error', () => { this.#drop(connection) })
    socket.on('close', () => { this.#drop(connection) })
  }

  #claim(connection: Connection, session: string): boolean {
    const held = this.#bridged.get(session)
    if (held !== undefined && held !== connection) return false
    // A connection that switches sessions releases the old one: leaving it
    // mapped would report it `bridged` forever and keep its listeners alive.
    const previous = connection.session
    connection.session = session
    this.#bridged.set(session, connection)
    if (previous !== undefined && previous !== session) {
      if (this.#bridged.get(previous) === connection) this.#bridged.delete(previous)
      this.#handlers?.bye(previous)
    }
    return true
  }

  #read(connection: Connection, chunk: string): void {
    connection.pending += chunk
    for (;;) {
      const index = connection.pending.indexOf('\n')
      if (index < 0) break
      const line = connection.pending.slice(0, index)
      connection.pending = connection.pending.slice(index + 1)
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) {
        this.#refuse(connection, 'protocol', `frame exceeds ${String(MAX_FRAME)} bytes`)
        return
      }
      const frame = decodeFrame(line)
      if (frame === undefined) {
        this.#refuse(connection, 'protocol', 'malformed frame')
        return
      }
      void connection.enqueue(() => this.#dispatch(connection, frame))
    }
    // A peer that streams without a newline is held to the same cap.
    if (Buffer.byteLength(connection.pending, 'utf8') > MAX_FRAME) {
      this.#refuse(connection, 'protocol', `frame exceeds ${String(MAX_FRAME)} bytes`)
    }
  }

  async #dispatch(connection: Connection, frame: InFrame): Promise<void> {
    const handlers = this.#handlers
    if (handlers === undefined) return

    switch (frame.t) {
      case 'hello':
        if (frame.proto !== PROTO) {
          this.#refuse(connection, 'protocol', `proto ${String(frame.proto)} is not ${String(PROTO)}`)
          return
        }
        await handlers.hello(frame, connection)
        return
      case 'line':
        // An unbound connection has no session to steer. Refusing is louder
        // than dropping, and the forwarder turns it into a non-zero exit.
        if (connection.session === undefined) {
          this.#refuse(connection, 'protocol', 'line before hello')
          return
        }
        handlers.line(frame.text, connection)
        return
      case 'list': {
        const items = handlers.list(frame.cwd, session => this.#bridged.has(session))
        connection.send({ t: 'sessions', items })
        return
      }
      case 'bye':
        connection.close()
        return
    }
  }

  #refuse(connection: Connection, code: ErrorCode, message: string): void {
    connection.socket.end(encodeFrame({ t: 'error', code, message }))
  }

  #drop(connection: Connection): void {
    if (!this.#connections.delete(connection)) return
    const { session } = connection
    if (session === undefined) return
    if (this.#bridged.get(session) === connection) this.#bridged.delete(session)
    connection.session = undefined
    this.#handlers?.bye(session)
  }
}
