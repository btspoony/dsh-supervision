/**
 * The control transport: one Unix socket per `dsh web` process, one bridge per
 * session. The frame codec, the registry format and the OSC encoder live in
 * `dsh-supervision-protocol`; only `SocketTransport` and `Connection` touch
 * `net` and `fs` here.
 */

import { chmodSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import {
  MAX_FRAME,
  PROTO,
  decodeFrame,
  encodeFrame,
  ensureRegistryDir,
  newToken,
  reclaimStale,
  registryPaths,
  supervisionDir,
  writeRegistry,
} from 'dsh-supervision-protocol'
import type {
  ErrorCode,
  HelloFrame,
  InFrame,
  OutFrame,
  RegistryPaths,
  SessionItem,
} from 'dsh-supervision-protocol'

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
  /**
   * Hand one session back to its GUI owner: tell the forwarder why, end its
   * socket, and drop the binding.
   * @returns whether a live bridge held the session.
   */
  reclaim(session: string): boolean
  close(): Promise<void>
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
    let line: string
    try {
      line = encodeFrame(frame)
    } catch {
      // An oversized frame means this connection's peer cannot be served
      // correctly; closing is louder than writing half a record into herdr.
      this.close()
      return
    }
    this.socket.write(line)
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

  reclaim(session: string): boolean {
    const connection = this.#bridged.get(session)
    if (connection === undefined) return false
    // Detach first: the answer the browser polls must agree with the answer this
    // call returns, whether or not the peer has read its goodbye yet.
    this.#bridged.delete(session)
    connection.session = undefined
    // Cleanup runs before the socket ends, so the child-record frames it writes
    // still leave; the forwarder then reads the goodbye and reports `clear`.
    this.#handlers?.bye(session)
    connection.send({ t: 'bye', reason: 'reclaimed' })
    connection.close()
    return true
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
    // A `hello`, `/new` or `/attach` can finish binding after the forwarder died.
    // Binding it then would report the session `bridged` with no owner and
    // refuse every later attach, so a connection the transport no longer owns
    // (or whose socket is already gone) never claims.
    if (!this.#connections.has(connection) || connection.socket.destroyed) return false
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
