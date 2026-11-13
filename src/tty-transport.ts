/**
 * The in-process tty transport: a `dsh web` started inside an hc terminal is
 * its own supervisor, so this transport owns exactly one bridge and no socket.
 * It renders `OutFrame`s through `renderFrame` and reads the same `parseLine`
 * grammar the forwarder feeds, so no protocol rule is implemented twice.
 */

import { isAbsolute } from 'node:path'
import { PROTO, renderFrame } from 'dsh-supervision-protocol'
import type { OutFrame } from 'dsh-supervision-protocol'
import { parseLine } from './stdin.js'
import type { Bridge, Transport, TransportHandlers } from './transport.js'

/** The terminal a `TtyTransport` renders to and reads from. */
export interface TtyIO {
  /**
   * Rendered bytes: whole OSC records and echo lines.
   * @returns false when the surface is gone (a pty that threw, a closed fd);
   *   the caller stops reporting rather than letting the write reach the host.
   */
  write(text: string): boolean
  /** Complete input lines from the owning keyboard, already split. */
  lines(): AsyncIterable<string>
  /** Release the terminal; idempotent. */
  close(): void
}

/** No session is bridged: the line was a manual re-entry or a stray keystroke. */
const UNBRIDGED = 'no session bridged; /new or /attach'

/**
 * The tty transport: one bridge, the owner's keyboard. A refused hello and a
 * `reclaim` end the bridge but never the transport, because restarting
 * `dsh web` would lose every session the process hosts.
 */
export class TtyTransport implements Transport {
  readonly #io: TtyIO
  readonly #bridge: Bridge
  #handlers: TransportHandlers | undefined
  #session: string | undefined
  #closed = false
  #dead = false
  /** True while the synthesized first hello runs, so only it may wait for the factory. */
  #booting = false

  constructor(io: TtyIO) {
    this.#io = io
    const self = this
    this.#bridge = {
      get session(): string | undefined {
        return self.#session
      },
      get retryOnNoFactory(): boolean {
        return self.#booting
      },
      claim: session => self.#bind(session),
      send: frame => { self.#write(frame) },
      // This bridge is finished; the transport stays mounted for a re-entry.
      close: () => { self.#release() },
    }
  }

  async start(handlers: TransportHandlers): Promise<void> {
    this.#handlers = handlers
    // The first session is the one a bare `dsh-sup` asks for: create in the
    // hosting process's directory, so a first command needs no session id.
    // Only this call may wait for the agent factory; operator commands fail fast.
    this.#booting = true
    try {
      await handlers.hello(
        { t: 'hello', proto: PROTO, pid: process.pid, new: { cwd: process.cwd() } },
        this.#bridge,
      )
    } finally {
      this.#booting = false
    }
    if (this.#closed) return
    void this.#consume()
  }

  send(frame: OutFrame, session?: string): void {
    // A frame addressed to a session this bridge does not hold has no reader.
    if (session !== undefined && this.#session !== session) return
    this.#write(frame)
  }

  reclaim(session: string): boolean {
    if (this.#session !== session) return false
    // Detach first: the answer the browser polls must agree with the binding
    // immediately, whether or not the clear record has left yet.
    this.#release()
    // Cleanup runs before the clear record, so the child-record frames it writes
    // still leave; the record then tells hc the supervisor is gone.
    this.#teardown(session)
    this.#write({ t: 'bye', reason: 'reclaimed' })
    return true
  }

  async close(): Promise<void> {
    this.#closed = true
    try {
      const session = this.#session
      if (session === undefined) return
      this.#release()
      this.#teardown(session)
      this.#write({ t: 'bye', reason: 'plugin-disposed' })
    } catch {
      // Disposal has no recovery path: the terminal is released below whatever
      // a host teardown callback did, and a rejected close would reach the host
      // as an unhandled rejection.
    } finally {
      // The terminal is released even when a teardown step throws: an attached
      // feed and an open fd would otherwise outlive the plugin.
      this.#io.close()
    }
  }

  /** Binds `session` here; the seam's single-owner rule. */
  #bind(session: string): boolean {
    // A hello that settles after disposal must not bind: nothing can answer it.
    // Neither must one that settles after the terminal died.
    if (this.#closed || this.#dead) return false
    const previous = this.#session
    this.#session = session
    // A switch releases the old session, exactly as the socket transport does.
    if (previous !== undefined && previous !== session) this.#teardown(previous)
    return true
  }

  /**
   * Runs the host's teardown for `session`, contained: a throwing `bye` must
   * never reach the host emitter that called `send`/`reclaim`/the claim, and
   * the caller's remaining steps (the clear record) still run.
   */
  #teardown(session: string): void {
    try {
      this.#handlers?.bye(session)
    } catch {
      // Disposal has no recovery path; the binding is already dropped.
    }
  }

  /** Holds no session from now on. */
  #release(): void {
    this.#session = undefined
  }

  /** Renders one frame to the terminal; frames with no tty rendering are dropped. */
  #write(frame: OutFrame): void {
    // A dead surface has nothing left to say, and a failing write must never
    // reach the host that called `send`.
    if (this.#dead) return
    const bytes = renderFrame(frame)
    if (bytes === undefined) return
    let written: boolean
    try {
      written = this.#io.write(bytes)
    } catch {
      // `EIO`/`EBADF` from a vanished pty is a state, not an exception: letting
      // it propagate would land in a host emitter and take `dsh web` down.
      written = false
    }
    if (written) return
    this.#dead = true
    // The surface is gone whether or not a session is bound: close the feed
    // first, so no line piles up in a queue this permanently dead transport can
    // never read. `close` is idempotent, so disposal's own close stays safe.
    try {
      this.#io.close()
    } catch {
      // Nothing left to release.
    }
    const session = this.#session
    if (this.#closed || session === undefined) return
    // The surface this bridge reported through is gone, so the bridge is
    // finished: release the binding, then run the same `bye` a socket drop
    // does — it drops the session's listeners and fails its parked asks closed.
    // The transport stays mounted, not the bridge.
    this.#release()
    this.#teardown(session)
  }

  /** Reads lines one at a time, so an in-flight hello holds the lines behind it. */
  async #consume(): Promise<void> {
    try {
      for await (const line of this.#io.lines()) {
        // Death is terminal for the loop, exactly as disposal is: a failed write
        // has already finished this bridge, so lines buffered behind an in-flight
        // hello must not be replayed as unbridged input — `hello` would create a
        // session this permanently dead transport can never bind.
        if (this.#closed || this.#dead) break
        try {
          await this.#handle(line)
        } catch (error) {
          // The socket path's teardown, in its order: report the failure, then
          // finish this bridge. `bye` is what drops the session's listeners and
          // child records; releasing alone would orphan them. The transport
          // stays mounted, so the operator retries from the same keyboard.
          const session = this.#session
          this.#write({ t: 'error', code: 'internal', message: String(error) })
          // A failed write above has already finished the bridge.
          if (session !== undefined && this.#session === session) {
            this.#release()
            this.#teardown(session)
          }
        }
      }
    } catch {
      // The terminal itself is gone: there is no surface left to report to.
    }
  }

  async #handle(line: string): Promise<void> {
    const handlers = this.#handlers
    if (handlers === undefined) return
    // Bridged: the forwarder's grammar verbatim, `/new` and `/attach` included.
    if (this.#session !== undefined) {
      handlers.line(line, this.#bridge)
      return
    }
    const command = parseLine(line)
    // A blank line is framing, not a command.
    if (command === undefined) return
    if (command.kind === 'attach') {
      await handlers.hello(
        { t: 'hello', proto: PROTO, pid: process.pid, attach: command.session },
        this.#bridge,
      )
      return
    }
    if (command.kind === 'new') {
      const { cwd } = command
      if (cwd === undefined) {
        // The bare arm creates in `process.cwd()` through the create helper, so
        // the absolute-path rule below cannot be bypassed.
        await handlers.hello({ t: 'hello', proto: PROTO, pid: process.pid }, this.#bridge)
        return
      }
      // Nothing resolves a relative path: accepting one would create the
      // session somewhere else entirely. Same refusal as the bridged path.
      if (!isAbsolute(cwd)) {
        this.#write({ t: 'echo', text: `new failed: ${cwd} is not an absolute path` })
        return
      }
      await handlers.hello({ t: 'hello', proto: PROTO, pid: process.pid, new: { cwd } }, this.#bridge)
      return
    }
    this.#write({ t: 'echo', text: UNBRIDGED })
  }
}
