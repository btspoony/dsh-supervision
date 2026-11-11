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
  /** Rendered bytes: whole OSC records and echo lines. */
  write(text: string): void
  /** Complete input lines from the owning keyboard, already split. */
  lines(): AsyncIterable<string>
  /** Raw mode while a bridge is bound; the previous mode otherwise. */
  setRaw(raw: boolean): void
  /** Release the terminal and restore its prior state; idempotent. */
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

  constructor(io: TtyIO) {
    this.#io = io
    const self = this
    this.#bridge = {
      get session(): string | undefined {
        return self.#session
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
    await handlers.hello(
      { t: 'hello', proto: PROTO, pid: process.pid, new: { cwd: process.cwd() } },
      this.#bridge,
    )
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
    this.#handlers?.bye(session)
    this.#write({ t: 'bye', reason: 'reclaimed' })
    return true
  }

  async close(): Promise<void> {
    this.#closed = true
    const session = this.#session
    if (session !== undefined) {
      this.#release()
      this.#handlers?.bye(session)
      this.#write({ t: 'bye', reason: 'plugin-disposed' })
    }
    this.#io.close()
  }

  /** Binds `session` here; the seam's single-owner rule. */
  #bind(session: string): boolean {
    // A hello that settles after disposal must not bind: nothing can answer it.
    if (this.#closed) return false
    const previous = this.#session
    this.#session = session
    this.#io.setRaw(true)
    // A switch releases the old session, exactly as the socket transport does.
    if (previous !== undefined && previous !== session) this.#handlers?.bye(previous)
    return true
  }

  /** Holds no session from now on: the terminal goes back to cooked mode. */
  #release(): void {
    this.#session = undefined
    this.#io.setRaw(false)
  }

  /** Renders one frame to the terminal; frames with no tty rendering are dropped. */
  #write(frame: OutFrame): void {
    const bytes = renderFrame(frame)
    if (bytes !== undefined) this.#io.write(bytes)
  }

  /** Reads lines one at a time, so an in-flight hello holds the lines behind it. */
  async #consume(): Promise<void> {
    try {
      for await (const line of this.#io.lines()) {
        if (this.#closed) break
        try {
          await this.#handle(line)
        } catch (error) {
          // Reported as the socket transport reports it; the bridge is finished
          // and the operator retries from the same keyboard.
          this.#write({ t: 'error', code: 'internal', message: String(error) })
          this.#release()
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
