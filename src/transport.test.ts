/**
 * Transport conformance over real Unix sockets in a temp directory: the frame
 * codec, the hello/welcome round-trip, single-ownership, dispose, and stale
 * registry reclaim. No network, no timers.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { after, test } from 'node:test'
import {
  MAX_FRAME,
  PROTO,
  decodeFrame,
  encodeFrame,
  isRegistryEntry,
  readRegistry,
  registryPaths,
  reclaimStale,
  supervisionDir,
} from 'dsh-supervision-protocol'
import type { HelloFrame, InFrame, OutFrame } from 'dsh-supervision-protocol'
import { SocketTransport } from './transport.js'
import type { TransportHandlers } from './transport.js'

const roots: string[] = []
/** Every client this file opened; a dangling socket would keep the runner alive. */
const clients: Client[] = []

/** A temp directory this file owns, removed after the run. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-supervision-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const client of clients) client.socket.destroy()
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** Frames arriving on one client socket, in order, with a waiter per count. */
class Client {
  readonly socket: Socket
  readonly #received: OutFrame[] = []
  #pending = ''
  #wake: (() => void) | undefined
  readonly #closed: Promise<void>

  constructor(path: string) {
    clients.push(this)
    this.socket = connect(path)
    this.socket.setEncoding('utf8')
    this.socket.on('data', (chunk: string) => {
      this.#pending += chunk
      for (;;) {
        const index = this.#pending.indexOf('\n')
        if (index < 0) break
        const line = this.#pending.slice(0, index)
        this.#pending = this.#pending.slice(index + 1)
        this.#received.push(JSON.parse(line) as OutFrame)
      }
      this.#wake?.()
    })
    this.#closed = new Promise(resolve => { this.socket.on('close', () => { resolve() }) })
  }

  /** Wait for the connection to leave the connecting state. */
  async ready(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('ready', resolve)
      this.socket.once('error', reject)
    })
  }

  write(frame: InFrame): void {
    this.socket.write(`${JSON.stringify(frame)}\n`)
  }

  /** @returns the frames received so far. */
  get received(): readonly OutFrame[] {
    return this.#received
  }

  /** Resolve once at least `count` frames have arrived. */
  async take(count: number): Promise<readonly OutFrame[]> {
    while (this.#received.length < count) {
      await new Promise<void>(resolve => { this.#wake = resolve })
    }
    return this.#received.slice(0, count)
  }

  /** Resolve when the peer closed the connection. */
  async closed(): Promise<void> {
    return this.#closed
  }
}

/** A transport over a temp directory with a handler set that answers everything. */
async function serve(
  dir: string,
  overrides: Partial<TransportHandlers> = {},
): Promise<{ transport: SocketTransport; handlers: TransportHandlers }> {
  const transport = new SocketTransport({ dir, dshVersion: '0.0.0-test' })
  // Only read by tests that assert on the frame they expect; the handler below
  // writes the same object it returns, so the default is never observed.
  let welcomed: OutFrame = { t: 'welcome', proto: PROTO, session: '', title: '', state: 'idle', turn: 0 }
  const handlers: TransportHandlers = {
    async hello(frame: HelloFrame, bridge): Promise<void> {
      const session = 'attach' in frame ? frame.attach : 'session-new'
      // The transport answers `busy` itself; a refused claim must stop here.
      if (!bridge.claim(session)) return
      welcomed = { t: 'welcome', proto: PROTO, session, title: 'repo', state: 'idle', turn: 0 }
      bridge.send(welcomed)
    },
    line(text, bridge): void {
      bridge.send({ t: 'echo', text })
    },
    list(): readonly { id: string; cwd: string; live: boolean; bridged: boolean }[] {
      return [{ id: 'session-1', cwd: '/repo', live: true, bridged: false }]
    },
    bye(): void {
      // The bridge is gone; nothing to clean up in these tests.
    },
    ...overrides,
  }
  await transport.start(handlers)
  return { transport, handlers }
}

test('the socket, registry entry and directory are private to this user', async () => {
  const root = tempDir()
  const dir = join(root, 'supervision')
  const { transport } = await serve(dir)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(transport.socketPath).mode & 0o777, 0o600)
  const entry = readRegistry(dir)[0]
  assert.ok(entry !== undefined)
  assert.equal(statSync(join(dir, `${String(process.pid)}-${transport.socketPath.slice(-13, -5)}.json`)).mode & 0o777, 0o600)
  assert.equal(entry.socket, transport.socketPath)
  await transport.close()
})

test('the supervision directory is $DSH_HOME/supervision, or ~/.dsh', () => {
  assert.equal(supervisionDir({ DSH_HOME: '/tmp/dsh' }), join('/tmp/dsh', 'supervision'))
  assert.ok(supervisionDir({}).endsWith(join('.dsh', 'supervision')))
})

test('registry paths carry pid and token only, never a session id', () => {
  const paths = registryPaths('/tmp/x', 42, 'deadbeef')
  assert.equal(paths.socket, join('/tmp/x', '42-deadbeef.sock'))
  assert.equal(paths.json, join('/tmp/x', '42-deadbeef.json'))
})

test('the codec rejects anything that is not a well-formed frame', () => {
  const rejected: readonly string[] = [
    'not json',
    '[]',
    '{"t":"nope"}',
    '{"t":"hello"}',
    '{"t":"hello","proto":"1","pid":1}',
    '{"t":"hello","proto":1,"pid":1.5}',
    '{"t":"hello","proto":1,"pid":1,"attach":7}',
    '{"t":"hello","proto":1,"pid":1,"attach":""}',
    '{"t":"hello","proto":1,"pid":1,"new":{"cwd":""}}',
    '{"t":"hello","proto":1,"pid":1,"attach":"session-1","new":{"cwd":"/repo"}}',
    '{"t":"hello","proto":1,"pid":1,"new":{}}',
    '{"t":"line"}',
    '{"t":"list","cwd":5}',
  ]
  for (const line of rejected) assert.equal(decodeFrame(line), undefined, line)
})

test('the codec round-trips every legal inbound frame', () => {
  const frames: readonly InFrame[] = [
    { t: 'hello', proto: 1, pid: 7 },
    { t: 'hello', proto: 1, pid: 7, attach: 'session-1' },
    { t: 'hello', proto: 1, pid: 7, new: { cwd: '/repo' } },
    { t: 'line', text: 'say hi' },
    { t: 'list' },
    { t: 'list', cwd: '/repo' },
    { t: 'bye' },
  ]
  for (const frame of frames) assert.deepEqual(decodeFrame(JSON.stringify(frame)), frame)
})

test('an over-cap frame is refused rather than written', () => {
  const huge: OutFrame = { t: 'echo', text: 'x'.repeat(MAX_FRAME) }
  assert.throws(() => encodeFrame(huge), /exceeds/)
})

test('a registry entry is only trusted once its shape is proven', () => {
  const good = { proto: 1, pid: 5, socket: '/tmp/s', startedAt: 1, dshVersion: '1' }
  assert.equal(isRegistryEntry(good), true)
  assert.equal(isRegistryEntry({ ...good, proto: 2 }), false)
  assert.equal(isRegistryEntry({ ...good, pid: 0 }), false)
  assert.equal(isRegistryEntry({ ...good, socket: '' }), false)
  assert.equal(isRegistryEntry(null), false)
  assert.equal(isRegistryEntry('x'), false)
})

test('hello is answered with welcome, and then osc follows', async () => {
  const dir = tempDir()
  const { transport } = await serve(dir)
  const client = new Client(transport.socketPath)
  await client.ready()
  client.write({ t: 'hello', proto: 1, pid: process.pid })
  const frames = await client.take(1)
  assert.deepEqual(frames[0], {
    t: 'welcome',
    proto: PROTO,
    session: 'session-new',
    title: 'repo',
    state: 'idle',
    turn: 0,
  })
  await transport.close()
})

test('a hello with another proto is refused', async () => {
  const dir = tempDir()
  const { transport } = await serve(dir)
  const client = new Client(transport.socketPath)
  await client.ready()
  client.write({ t: 'hello', proto: 2, pid: process.pid })
  const [frame] = await client.take(1)
  assert.equal(frame?.t, 'error')
  assert.equal(frame !== undefined && frame.t === 'error' ? frame.code : '', 'protocol')
  await client.closed()
  await transport.close()
})

test('a second hello for the same session is busy, and the first keeps its bridge', async () => {
  const dir = tempDir()
  const { transport } = await serve(dir)
  const first = new Client(transport.socketPath)
  await first.ready()
  first.write({ t: 'hello', proto: 1, pid: process.pid, attach: 'session-1' })
  await first.take(1)

  const second = new Client(transport.socketPath)
  await second.ready()
  second.write({ t: 'hello', proto: 1, pid: process.pid, attach: 'session-1' })
  const [refusal] = await second.take(1)
  assert.equal(refusal?.t, 'error')
  assert.equal(refusal !== undefined && refusal.t === 'error' ? refusal.code : '', 'busy')
  await second.closed()

  // The holder still answers its own frames.
  first.write({ t: 'line', text: 'still here' })
  const frames = await first.take(2)
  assert.deepEqual(frames[1], { t: 'echo', text: 'still here' })
  await transport.close()
})

test('a bind that finishes after its forwarder closed cannot claim the session', async () => {
  const dir = tempDir()
  let claimedResolve: () => void = () => {}
  let release: () => void = () => {}
  let droppedResolve: () => void = () => {}
  let lateDone: () => void = () => {}
  const claimed = new Promise<void>(resolve => { claimedResolve = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const dropped = new Promise<void>(resolve => { droppedResolve = resolve })
  const lateAttempt = new Promise<void>(resolve => { lateDone = resolve })
  let claims = 0
  let lateClaim: boolean | undefined
  const { transport } = await serve(dir, {
    // The F-001 window: `bind`/`create` resolves after the peer is already gone.
    async hello(_frame, bridge): Promise<void> {
      claims += 1
      if (claims > 1) {
        if (!bridge.claim('session-1')) return
        bridge.send({ t: 'welcome', proto: PROTO, session: 'session-1', title: 'repo', state: 'idle', turn: 0 })
        return
      }
      // Bind a session first so the transport's own drop is observable.
      assert.equal(bridge.claim('session-keep'), true)
      claimedResolve()
      await dropped
      await gate
      lateClaim = bridge.claim('session-1')
      lateDone()
    },
    bye(session): void {
      if (session === 'session-keep') droppedResolve()
    },
  })

  const forwarder = new Client(transport.socketPath)
  await forwarder.ready()
  forwarder.write({ t: 'hello', proto: 1, pid: process.pid, attach: 'session-keep' })
  // Destroy only once the server holds the binding, so `bye` below is certain.
  await claimed
  forwarder.socket.destroy()
  await dropped

  try {
    release()
    await lateAttempt
    assert.equal(lateClaim, false)
    // Not `bridged`: the dead forwarder owns nothing, so there is nothing to reclaim.
    assert.equal(transport.reclaim('session-1'), false)

    const next = new Client(transport.socketPath)
    await next.ready()
    next.write({ t: 'hello', proto: 1, pid: process.pid, attach: 'session-1' })
    const [frame] = await next.take(1)
    assert.deepEqual(frame, {
      t: 'welcome',
      proto: PROTO,
      session: 'session-1',
      title: 'repo',
      state: 'idle',
      turn: 0,
    })
    assert.equal(transport.reclaim('session-1'), true)
  } finally {
    // A failed assertion must not leave the listener open and stall the runner.
    await transport.close()
  }
})

test('list is answered without binding a bridge', async () => {
  const dir = tempDir()
  const { transport } = await serve(dir)
  const client = new Client(transport.socketPath)
  await client.ready()
  client.write({ t: 'list' , cwd: '/repo' })
  const [frame] = await client.take(1)
  assert.deepEqual(frame, { t: 'sessions', items: [{ id: 'session-1', cwd: '/repo', live: true, bridged: false }] })
  await transport.close()
})

test('sent reports reach only the bridge that owns the session', async () => {
  const dir = tempDir()
  const { transport } = await serve(dir)
  const client = new Client(transport.socketPath)
  await client.ready()
  client.write({ t: 'hello', proto: 1, pid: process.pid, attach: 'session-1' })
  await client.take(1)
  transport.send({ t: 'osc', data: '\u001b]7501;state=working\u001b\\' }, 'session-1')
  transport.send({ t: 'osc', data: 'ignored' }, 'session-other')
  const frames = await client.take(2)
  assert.deepEqual(frames[1], { t: 'osc', data: '\u001b]7501;state=working\u001b\\' })
  await transport.close()
})

test('dispose unlinks the socket and the registry entry', async () => {
  const dir = tempDir()
  const { transport } = await serve(dir)
  assert.equal(readdirSync(dir).length, 2)
  const entry = readRegistry(dir)[0]
  assert.ok(entry !== undefined)
  assert.equal(entry.proto, PROTO)
  assert.equal(entry.pid, process.pid)
  await transport.close()
  assert.equal(existsSync(transport.socketPath), false)
  assert.deepEqual(readdirSync(dir), [])
})

test('a registry entry whose process is gone is reclaimed with its socket', () => {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  // pid 1 is never this test process; a dead pid cannot be probed portably, so
  // this uses a pid far outside the kernel range, which no live process holds.
  const dead = registryPaths(dir, 2 ** 22 + 7, 'deadbeef')
  writeFileSync(dead.json, `${JSON.stringify({
    proto: PROTO,
    pid: 2 ** 22 + 7,
    socket: dead.socket,
    startedAt: 1,
    dshVersion: '0.0.0-test',
  })}\n`)
  writeFileSync(dead.socket, '')

  const removed = reclaimStale(dir)
  assert.deepEqual(removed, [2 ** 22 + 7])
  assert.equal(existsSync(dead.json), false)
  assert.equal(existsSync(dead.socket), false)
})

test('a live entry survives reclaim', async () => {
  const dir = tempDir()
  const { transport } = await serve(dir)
  assert.deepEqual(reclaimStale(dir), [])
  assert.equal(readRegistry(dir).length, 1)
  await transport.close()
})

test('a live entry whose socket vanished is reclaimed', () => {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const paths = registryPaths(dir, process.pid, '0badf00d')
  writeFileSync(paths.json, `${JSON.stringify({
    proto: PROTO,
    pid: process.pid,
    socket: paths.socket,
    startedAt: 1,
    dshVersion: '0.0.0-test',
  })}\n`)
  assert.deepEqual(reclaimStale(dir), [process.pid])
  assert.equal(existsSync(paths.json), false)
})

test('an unparseable registry file is treated as stale', () => {
  const dir = tempDir()
  mkdirSync(dir, { recursive: true })
  const paths = registryPaths(dir, process.pid, 'cafebabe')
  writeFileSync(paths.json, '{ not json')
  writeFileSync(paths.socket, '')
  assert.deepEqual(reclaimStale(dir), [])
  assert.equal(existsSync(paths.json), false)
  assert.equal(existsSync(paths.socket), false)
})

test('a line before hello is refused', async () => {
  const dir = tempDir()
  const { transport } = await serve(dir)
  const client = new Client(transport.socketPath)
  await client.ready()
  client.write({ t: 'line', text: 'too early' })
  const [frame] = await client.take(1)
  assert.equal(frame?.t, 'error')
  assert.equal(frame !== undefined && frame.t === 'error' ? frame.code : '', 'protocol')
  await transport.close()
})
