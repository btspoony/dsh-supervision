/**
 * TtyTransport behaviour over a fake terminal: the synthesized first session,
 * the refusal that keeps the transport mounted, unbridged re-entry, line
 * serialization behind an in-flight hello, reclaim and close. No real tty, so
 * the suite runs anywhere.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { PROTO } from 'dsh-supervision-protocol'
import type { HelloFrame } from 'dsh-supervision-protocol'
import { lineFeed, openTtyIO, stdoutWriter } from './tty.js'
import type { LineSource, TtyStdin } from './tty.js'
import { TtyTransport } from './tty-transport.js'
import type { TtyIO } from './tty-transport.js'
import type { Bridge, TransportHandlers } from './transport.js'

/** One macrotask turn: long enough for the transport's line loop to run. */
function settle(): Promise<void> {
  return new Promise<void>(resolve => { setImmediate(resolve) })
}

/** Waits until `predicate` holds; the transport settles at its own pace. */
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return
    await settle()
  }
  throw new Error('condition never held')
}

/** A latch the test opens by hand; ES2022 has no `Promise.withResolvers`. */
class Latch {
  #open = false
  readonly #waiters: (() => void)[] = []

  open(): void {
    this.#open = true
    for (const wake of this.#waiters.splice(0)) wake()
  }

  wait(): Promise<void> {
    if (this.#open) return Promise.resolve()
    return new Promise<void>(resolve => { this.#waiters.push(resolve) })
  }
}

/** A terminal that records what it received and replays lines a test pushes. */
class FakeTty implements TtyIO {
  readonly out: string[] = []
  closes = 0
  /** When set, every write throws: a pty the process can no longer reach. */
  broken = false
  #queue: string[] = []
  #wake: (() => void) | undefined
  #ended = false

  write(text: string): boolean {
    if (this.broken) throw new Error('EIO: terminal is gone')
    this.out.push(text)
    return true
  }

  close(): void {
    this.closes += 1
    this.#ended = true
    this.#wake?.()
  }

  /** Types one complete line, as the owning keyboard would. */
  type(line: string): void {
    this.#queue.push(line)
    this.#wake?.()
  }

  async *lines(): AsyncGenerator<string> {
    for (;;) {
      const line = this.#queue.shift()
      if (line !== undefined) {
        yield line
        continue
      }
      if (this.#ended) return
      await new Promise<void>(resolve => { this.#wake = resolve })
      this.#wake = undefined
    }
  }
}

/** A host that creates one session per hello, like `handlersFor` does. */
class Host {
  readonly hellos: HelloFrame[] = []
  readonly lines: { readonly text: string; readonly session: string | undefined }[] = []
  readonly byes: string[] = []
  /** The bridge the transport handed to the last hello. */
  bridge: Bridge | undefined
  /** Why the next hello answers an error and calls `bridge.close()`. */
  refuse: string | undefined
  /** A hello waits on this latch before binding, to prove line serialization. */
  hold: Latch | undefined
  /** Throws from the line handler, as a host callback that failed would. */
  failLine = false
  /** Throws from `bye`, as a host disposer that failed would. */
  failBye = false

  readonly handlers: TransportHandlers = {
    hello: async (frame: HelloFrame, bridge: Bridge): Promise<void> => {
      this.hellos.push(frame)
      this.bridge = bridge
      await this.hold?.wait()
      if (this.refuse !== undefined) {
        bridge.send({ t: 'error', code: 'create-failed', message: this.refuse })
        // The seam's contract: a refused hello finishes its own bridge.
        bridge.close()
        return
      }
      const session = `session-${String(this.hellos.length)}`
      if (!bridge.claim(session)) return
      bridge.send({ t: 'welcome', proto: PROTO, session, title: 'repo', state: 'idle', turn: 0 })
    },
    line: (text: string, bridge: Bridge): void => {
      this.lines.push({ text, session: bridge.session })
      if (this.failLine) throw new Error('steer failed')
    },
    list: () => [],
    bye: (session: string): void => {
      this.byes.push(session)
      if (this.failBye) throw new Error('disposer failed')
    },
  }
}

/** A mounted transport over a fake terminal and a fake host. */
async function mounted(): Promise<{ io: FakeTty; host: Host; transport: TtyTransport }> {
  const io = new FakeTty()
  const host = new Host()
  const transport = new TtyTransport(io)
  await transport.start(host.handlers)
  return { io, host, transport }
}

test('start creates the first session from the bare default hello', async () => {
  const { io, host } = await mounted()
  assert.deepEqual(host.hellos, [{ t: 'hello', proto: PROTO, pid: process.pid, new: { cwd: process.cwd() } }])
  // `welcome` reaches the terminal as the root idle record.
  assert.equal(io.out.length, 1)
  assert.match(io.out[0] ?? '', /state=idle/)
})

test('send renders through renderFrame and drops frames the tty cannot show', async () => {
  const { io, transport } = await mounted()
  io.out.length = 0
  transport.send({ t: 'echo', text: 'hello' })
  transport.send({ t: 'osc', data: '\u001b]7501;state=working\u001b\\' })
  transport.send({ t: 'sessions', items: [] })
  assert.deepEqual(io.out, ['hello\n', '\u001b]7501;state=working\u001b\\'])
})

test('a frame addressed to another session is not written', async () => {
  const { io, transport } = await mounted()
  io.out.length = 0
  transport.send({ t: 'echo', text: 'elsewhere' }, 'session-other')
  assert.deepEqual(io.out, [])
  transport.send({ t: 'echo', text: 'here' }, 'session-1')
  assert.deepEqual(io.out, ['here\n'])
})

test('a refused create renders the error record and stays mounted', async () => {
  const io = new FakeTty()
  const host = new Host()
  host.refuse = 'no model'
  const transport = new TtyTransport(io)
  await transport.start(host.handlers)

  assert.match(io.out.at(-1) ?? '', /state=error/)
  // `msg` rides base64 inside the OSC record, exactly as the forwarder writes it.
  const msg = /:msg=([^:\u001b]+)/.exec(io.out.at(-1) ?? '')?.[1] ?? ''
  assert.equal(Buffer.from(msg, 'base64').toString('utf8'), 'create-failed: no model')
  // The bridge is finished.
  assert.deepEqual(host.byes, [])

  // The operator retries on the same keyboard: the transport never unmounted.
  host.refuse = undefined
  io.type('/new /tmp')
  await until(() => host.hellos.length === 2)
  assert.deepEqual(host.hellos[1], { t: 'hello', proto: PROTO, pid: process.pid, new: { cwd: '/tmp' } })
})

test('an unbridged /new without a cwd sends the bare hello arm', async () => {
  const io = new FakeTty()
  const host = new Host()
  host.refuse = 'no model'
  const transport = new TtyTransport(io)
  await transport.start(host.handlers)

  host.refuse = undefined
  io.type('/new')
  await until(() => host.hellos.length === 2)
  assert.deepEqual(host.hellos[1], { t: 'hello', proto: PROTO, pid: process.pid })
})

test('an unbridged /new with a relative path is refused without a hello', async () => {
  const io = new FakeTty()
  const host = new Host()
  host.refuse = 'no model'
  const transport = new TtyTransport(io)
  await transport.start(host.handlers)
  io.out.length = 0

  io.type('/new relative/dir')
  await until(() => io.out.length === 1)
  assert.equal(host.hellos.length, 1)
  assert.deepEqual(io.out, ['new failed: relative/dir is not an absolute path\n'])
})

test('an unbridged /attach re-enters hello with the attach arm', async () => {
  const io = new FakeTty()
  const host = new Host()
  host.refuse = 'no model'
  const transport = new TtyTransport(io)
  await transport.start(host.handlers)

  host.refuse = undefined
  io.type('/attach session-abc')
  await until(() => host.hellos.length === 2)
  assert.deepEqual(host.hellos[1], { t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-abc' })
})

test('an unbridged stray line gets one guidance echo; a blank line gets none', async () => {
  const io = new FakeTty()
  const host = new Host()
  host.refuse = 'no model'
  const transport = new TtyTransport(io)
  await transport.start(host.handlers)
  io.out.length = 0

  io.type('run the tests')
  await until(() => io.out.length === 1)
  io.type('   ')
  // A blank line is framing: one turn proves nothing follows it.
  await settle()
  assert.deepEqual(io.out, ['no session bridged; /new or /attach\n'])
  assert.deepEqual(host.lines, [])
})

test('reclaim still clears the record when the teardown bye throws', async () => {
  const { io, host, transport } = await mounted()
  io.out.length = 0
  host.failBye = true

  // The host's disposer failed, but the reclaim route must not escape with it
  // and the browser must still be told the supervisor is gone.
  assert.equal(transport.reclaim('session-1'), true)
  assert.deepEqual(host.byes, ['session-1'])
  assert.match(io.out.at(-1) ?? '', /state=clear/)
})

test('a throwing bye does not escape a write that killed the surface', async () => {
  const { io, host, transport } = await mounted()
  host.failBye = true
  io.broken = true

  // A host teardown that throws must not reach the emitter that produced the
  // frame; the bridge is finished either way.
  assert.doesNotThrow(() => { transport.send({ t: 'echo', text: 'boom' }) })
  assert.deepEqual(host.byes, ['session-1'])
})

test('a throwing bye does not escape a bind that switches sessions', async () => {
  const { host } = await mounted()
  host.failBye = true

  // A hello may claim a different session over a bound one; the old session's
  // teardown runs on that switch and must be contained like disposal's.
  assert.doesNotThrow(() => { host.bridge?.claim('session-2') })
  assert.deepEqual(host.byes, ['session-1'])
  assert.equal(host.bridge?.session, 'session-2')
})

test('a dead surface never replays the lines buffered behind an in-flight hello', async () => {
  const io = new FakeTty()
  const host = new Host()
  const hold = new Latch()
  host.hold = hold
  const transport = new TtyTransport(io)
  const started = transport.start(host.handlers)
  await until(() => host.hellos.length === 1)

  // Typed while the first hello is still in flight: they wait in the feed.
  io.type('/attach session-2')
  io.type('/new /tmp')
  // The pty goes away; the next write marks this transport dead for good.
  io.broken = true
  host.bridge?.send({ t: 'echo', text: 'boom' })

  hold.open()
  await started
  await settle()

  // A dead transport can never bind again, so those lines must not drive a
  // second hello: the session it created would have no bridge and no bye.
  assert.equal(host.hellos.length, 1)
  assert.deepEqual(host.lines, [])
})

test('a dead surface with no bound session still closes the feed', async () => {
  const io = new FakeTty()
  const host = new Host()
  host.refuse = 'create failed'
  const transport = new TtyTransport(io)
  await transport.start(host.handlers)
  // The refused hello finished its own bridge: no session is bound here.
  assert.equal(host.bridge?.session, undefined)

  io.broken = true
  // An unbridged stray line answers with an echo, and that write kills the
  // surface. Nothing is bound, but the feed must still die with it: a resumed
  // feed with no reader piles every later line into a queue this permanently
  // dead transport can never drain.
  io.type('stray')
  await until(() => io.closes === 1)

  // A dead transport never binds again, so those lines would create an orphan.
  assert.equal(host.bridge?.claim('session-2'), false)
  io.broken = false
  io.type('/attach session-3')
  await settle()
  assert.equal(host.hellos.length, 1)
  // The pty answers again, but death is permanent: a late frame must not reach
  // a surface whose feed is closed and whose session this transport can no
  // longer rebind.
  const written = io.out.length
  transport.send({ t: 'echo', text: 'late' })
  assert.equal(io.out.length, written)
})

test('a line typed during an in-flight hello waits for the binding', async () => {
  const io = new FakeTty()
  const host = new Host()
  const hold = new Latch()
  host.hold = hold
  const transport = new TtyTransport(io)
  const started = transport.start(host.handlers)

  // Queued before the first hello settles: it must not be handled unbridged.
  io.type('steer after hello')
  await until(() => host.hellos.length === 1)
  assert.deepEqual(host.lines, [])
  hold.open()
  await started
  await until(() => host.lines.length === 1)
  assert.deepEqual(host.lines, [{ text: 'steer after hello', session: 'session-1' }])
})

test('reclaim returns false when the session is not bound', async () => {
  const { io, host, transport } = await mounted()
  assert.equal(transport.reclaim('session-other'), false)
  assert.deepEqual(host.byes, [])
})

test('reclaim drops the binding, says bye, clears the record and stays mounted', async () => {
  const { io, host, transport } = await mounted()
  io.out.length = 0
  assert.equal(transport.reclaim('session-1'), true)
  assert.deepEqual(host.byes, ['session-1'])
  assert.match(io.out.at(-1) ?? '', /state=clear/)

  // Mounted: a re-entry line binds again.
  io.type('/attach session-2')
  await until(() => host.hellos.length === 2)
  assert.deepEqual(host.hellos[1], { t: 'hello', proto: PROTO, pid: process.pid, attach: 'session-2' })
})

test('a claim that settles after close binds nothing', async () => {
  const io = new FakeTty()
  const host = new Host()
  const hold = new Latch()
  host.hold = hold
  const transport = new TtyTransport(io)
  const started = transport.start(host.handlers)
  await until(() => host.hellos.length === 1)

  // The first hello is still in flight, so disposal must win over it.
  await transport.close()
  hold.open()
  await started
  assert.equal(host.bridge?.session, undefined)
  assert.deepEqual(host.byes, [])
})

test('close says bye for the bound session, clears, and releases the terminal', async () => {
  const { io, host, transport } = await mounted()
  io.out.length = 0
  await transport.close()
  assert.deepEqual(host.byes, ['session-1'])
  assert.match(io.out.at(-1) ?? '', /state=clear/)
  assert.equal(io.closes, 1)

  // Nothing is read once closed, even if the terminal still delivers a line.
  io.type('after close')
  await settle()
  assert.deepEqual(host.lines, [])
})

/** stdin's shape for `lineFeed`: only the events and mode calls it uses. */
class FakeStdin extends EventEmitter implements LineSource {
  encoding: BufferEncoding | undefined
  resumed = false
  paused = false
  /** A terminal stdin; `undefined` models a pipe, as the real field does. */
  isTTY: boolean | undefined = true

  setEncoding(encoding: BufferEncoding): this {
    this.encoding = encoding
    return this
  }

  resume(): this {
    this.resumed = true
    return this
  }

  pause(): this {
    this.paused = true
    return this
  }
}

test('lineFeed buffers a line typed before the first read, then replays it in order', async () => {
  const stdin = new FakeStdin()
  const feed = lineFeed(stdin)
  // Arrives during the initial hello, before anyone iterates the feed.
  stdin.emit('data', 'first\n')
  stdin.emit('data', 'second\r\n')
  const seen: string[] = []
  for await (const line of feed.lines()) {
    seen.push(line)
    if (seen.length === 2) break
  }
  assert.deepEqual(seen, ['first', 'second'])
  assert.equal(stdin.encoding, 'utf8')
  assert.equal(stdin.resumed, true)
})

test('lineFeed carries a partial line across chunks', async () => {
  const stdin = new FakeStdin()
  const feed = lineFeed(stdin)
  stdin.emit('data', 'one\r\nthr')
  stdin.emit('data', 'ee\n')
  const seen: string[] = []
  for await (const line of feed.lines()) {
    seen.push(line)
    if (seen.length === 2) break
  }
  // The unterminated tail is held, not delivered: no half line is ever read.
  assert.deepEqual(seen, ['one', 'three'])
})

test('lineFeed ends on end-of-input and stop() detaches the listeners', async () => {
  const stdin = new FakeStdin()
  const feed = lineFeed(stdin)
  stdin.emit('data', 'tail\n')
  stdin.emit('end')
  const seen: string[] = []
  for await (const line of feed.lines()) seen.push(line)
  assert.deepEqual(seen, ['tail'])

  const stopped = new FakeStdin()
  const other = lineFeed(stopped)
  other.stop()
  assert.equal(stopped.paused, true)
  assert.equal(stopped.listenerCount('data'), 0)
  const never: string[] = []
  for await (const line of other.lines()) never.push(line)
  assert.deepEqual(never, [])
})

test('lineFeed drops the buffered queue when stopped', async () => {
  const stdin = new FakeStdin()
  const feed = lineFeed(stdin)
  // Typed during an in-flight hello, then the feed is stopped: these lines have
  // no reader left, and replaying them is how an orphan session gets created.
  stdin.emit('data', '/attach session-2\n/new /tmp\n')
  feed.stop()

  const seen: string[] = []
  for await (const line of feed.lines()) seen.push(line)
  assert.deepEqual(seen, [])
})

test('lineFeed frames a single large paste without a spread over its lines', async () => {
  const stdin = new FakeStdin()
  const feed = lineFeed(stdin)
  // Past the engine's spread-argument ceiling (~124k on this Node build):
  // `push(...split.lines)` throws `RangeError` right here, inside a stdin
  // listener, which would kill the host. The whole chunk must frame instead.
  const count = 130_000
  assert.doesNotThrow(() => { stdin.emit('data', 'pasted\n'.repeat(count)) })

  // The buffered lines still come out in order behind the paste.
  const seen: string[] = []
  for await (const line of feed.lines()) {
    seen.push(line)
    if (seen.length === 3) break
  }
  assert.deepEqual(seen, ['pasted', 'pasted', 'pasted'])
  feed.stop()
})

test('a write that throws ends the bridge instead of reaching the caller', async () => {
  const { io, host, transport } = await mounted()
  io.out.length = 0
  // A pty the process can no longer reach: `EIO` out of a host emitter would
  // take the whole `dsh web` down, so the transport must contain it.
  io.broken = true
  assert.doesNotThrow(() => { transport.send({ t: 'echo', text: 'boom' }) })

  // The bridge is finished through the same teardown a socket drop runs …
  assert.deepEqual(host.byes, ['session-1'])
  // … the dead surface is released, and nothing more is ever written to it.
  assert.equal(io.closes, 1)
  io.broken = false
  assert.doesNotThrow(() => { transport.send({ t: 'echo', text: 'after' }) })
  assert.deepEqual(io.out, [])
  assert.deepEqual(host.byes, ['session-1'])
})

test('a throw from the line handler runs bye for the bound session, then releases', async () => {
  const { io, host } = await mounted()
  io.out.length = 0
  host.failLine = true
  io.type('steer this')
  await until(() => host.byes.length === 1)

  // The handlers' bridge is finished, not just the transport's binding: without
  // `bye` the session's listeners and parked asks outlive it.
  assert.deepEqual(host.byes, ['session-1'])
  // The failure is still reported to the terminal, and that record stands.
  assert.match(io.out.at(-1) ?? '', /state=error/)
})

test('close releases the terminal even when a teardown callback throws', async () => {
  const { io, host, transport } = await mounted()
  host.failBye = true
  // No rejection reaches the host's dispose path.
  await transport.close()
  assert.deepEqual(host.byes, ['session-1'])
  assert.equal(io.closes, 1)
})

test('openTtyIO fails closed when stdin is not a terminal', () => {
  const pipe = new FakeStdin()
  pipe.isTTY = undefined
  const open = openTtyIO(pipe as TtyStdin)
  assert.equal(open.ok, false)
  assert.match(open.ok ? '' : open.reason, /stdin is not a terminal/)
  // Nothing was mounted: a redirected stdin is never read as owner input.
  assert.equal(pipe.listenerCount('data'), 0)
  assert.equal(pipe.resumed, false)

  const no = new FakeStdin()
  no.isTTY = false
  assert.equal(openTtyIO(no as TtyStdin).ok, false)
  assert.equal(no.listenerCount('data'), 0)
})

test('a mounted bridge never puts the terminal into raw mode', async () => {
  // Drive the real transport over a real TtyIO: a regression that reinstates raw
  // mode anywhere in the mount path fails here, not just at openTtyIO.
  const stdin = new FakeStdin()
  const rawCalls: boolean[] = []
  Object.assign(stdin, { setRawMode: (mode: boolean) => { rawCalls.push(mode) } })
  const out: string[] = []
  const open = openTtyIO(stdin as TtyStdin, () => ({
    ok: true,
    writer: { write: (text: string) => { out.push(text); return true }, close: () => {} },
  }))
  assert.equal(open.ok, true)
  if (!open.ok) return

  const host = new Host()
  const transport = new TtyTransport(open.io)
  await transport.start(host.handlers)
  await until(() => host.bridge?.session !== undefined)

  // A line typed while bound reaches the host, and no terminal mode was touched.
  void open.io.lines()
  stdin.emit('data', 'a steer line\n')
  await until(() => host.lines.length === 1)
  assert.deepEqual(host.lines, [{ text: 'a steer line', session: host.bridge?.session }])
  assert.deepEqual(rawCalls, [], 'raw mode is never entered, so ISIG/ECHO/IXON stay on')

  await transport.close()
  assert.equal(stdin.listenerCount('data'), 0, 'the feed is detached on close')
})


test('the stdout fallback reports a vanished surface instead of throwing', () => {
  const listeners: ((error: Error) => void)[] = []
  let wrote = 0
  const stdout = {
    destroyed: false,
    write: () => { wrote += 1; return true },
    on: (event: 'error', listener: (error: Error) => void) => {
      if (event === 'error') listeners.push(listener)
      return stdout
    },
  }
  const writer = stdoutWriter(stdout as never)
  assert.equal(writer.write('first'), true)
  assert.equal(wrote, 1)

  // A vanished pty emits 'error' on stdout; the writer must swallow it and
  // report a dead surface, or Node turns it into an uncaught exception that
  // takes the whole host down.
  assert.equal(listeners.length, 1, 'the writer subscribes to the surface it writes to')
  for (const listener of listeners) listener(new Error('EIO'))
  assert.equal(writer.write('after'), false)
  assert.equal(wrote, 1, 'a dead surface is never written again')
})

test('the stdout fallback treats a throwing write as a dead surface', () => {
  let calls = 0
  const stdout = {
    write: () => { calls += 1; throw new Error('EBADF') },
    on: () => stdout,
  }
  const writer = stdoutWriter(stdout as never)
  assert.equal(writer.write('boom'), false)
  assert.equal(calls, 1)
  assert.equal(writer.write('again'), false, 'the surface stays dead')
})


test('end of terminal input reports and finishes the bridge instead of leaving it bound', async () => {
  const stdin = new FakeStdin()
  const out: string[] = []
  let closed = 0
  const open = openTtyIO(stdin as TtyStdin, () => ({
    ok: true,
    writer: { write: (text: string) => { out.push(text); return true }, close: () => { closed += 1 } },
  }))
  assert.equal(open.ok, true)
  if (!open.ok) return

  const host = new Host()
  const transport = new TtyTransport(open.io)
  await transport.start(host.handlers)
  await until(() => host.bridge?.session !== undefined)

  // Ctrl+D in line mode is EOF on stdin: the keyboard is gone for good.
  stdin.emit('end')
  await until(() => host.byes.length === 1)

  // The operator is told, the session is released, and the feed is detached.
  const last = out.at(-1) ?? ''
  assert.match(last, /state=error/)
  // `msg` rides base64 inside the record, exactly as the forwarder writes it.
  const msg = /:msg=([^:\u001b]+)/.exec(last)?.[1] ?? ''
  assert.match(Buffer.from(msg, 'base64').toString('utf8'), /terminal input ended/)
  assert.equal(host.bridge?.session, undefined)
  assert.equal(closed, 1, 'the dead keyboard is closed')
  assert.equal(stdin.listenerCount('data'), 0, 'the listeners are detached even though end stopped the feed')
})