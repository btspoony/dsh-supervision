/**
 * The two browser routes, driven through a fake webserver: request shape
 * (method, media type, body cap) and the exact status each outcome gets.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RECLAIM_PATH, STATE_PATH, registerSupervisionRoutes, supervisionState } from './routes.js'
import type { RouteRegistrar, RouteRequest, RouteResponse, SupervisionFacts, SupervisionState } from './routes.js'

/** One fake response: the status, headers and body the handler wrote. */
class FakeResponse implements RouteResponse {
  statusCode = 0
  readonly headers = new Map<string, string>()
  body = ''

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value)
  }

  end(body?: string): void {
    this.body = body ?? ''
  }

  /** @returns the parsed JSON body, for shape assertions. */
  get json(): unknown {
    return JSON.parse(this.body) as unknown
  }
}

/** One fake request: the method, headers and the body chunks it streams. */
class FakeRequest implements RouteRequest {
  readonly method: string
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  readonly #chunks: readonly Buffer[]

  constructor(method: string, headers: Record<string, string>, body = '') {
    this.method = method
    this.headers = headers
    this.#chunks = [Buffer.from(body, 'utf8')]
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    yield* this.#chunks
  }
}

/** A fake webserver that keeps its routes, so a test can call one directly. */
class FakeServer implements RouteRegistrar {
  readonly #handlers = new Map<string, (req: RouteRequest, res: RouteResponse) => void | Promise<void>>()

  /** The paths currently registered, in registration order. */
  get paths(): readonly string[] {
    return [...this.#handlers.keys()]
  }

  register(route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (req: RouteRequest, res: RouteResponse) => void | Promise<void>
  }): () => void {
    this.#handlers.set(route.path, route.handler)
    return () => { this.#handlers.delete(route.path) }
  }

  /** Call the route registered at `path`. */
  async call(path: string, req: RouteRequest): Promise<FakeResponse> {
    const handler = this.#handlers.get(path)
    assert.ok(handler !== undefined, `no route at ${path}`)
    const res = new FakeResponse()
    await handler(req, res)
    return res
  }
}

/** Facts for one bridged session. */
function facts(session: string): Map<string, SupervisionFacts> {
  return new Map([[session, { pid: 51234, since: 1762, asks: ['a1b2c3'] }]])
}

/** A server with both routes registered over a target the test controls. */
function mount(options: { readonly reclaimed?: boolean; readonly facts?: Map<string, SupervisionFacts> } = {}): {
  server: FakeServer
  dispose: () => void
  readonly reclaimedSessions: string[]
} {
  const server = new FakeServer()
  const reclaimedSessions: string[] = []
  const target = {
    snapshot: (): SupervisionState => supervisionState(options.facts ?? new Map(), 'w1'),
    reclaim: (session: string): boolean => {
      reclaimedSessions.push(session)
      return options.reclaimed ?? true
    },
  }
  return { server, dispose: registerSupervisionRoutes(server, target), reclaimedSessions }
}

test('both routes register on their exact paths and the disposer removes them', async () => {
  const { server, dispose, reclaimedSessions } = mount()
  assert.deepEqual(server.paths, [STATE_PATH, RECLAIM_PATH])
  dispose()
  assert.deepEqual(server.paths, [])
  assert.deepEqual(reclaimedSessions, [])
})

test('state answers one bridged session with its terminal, pid, since and asks', async () => {
  const { server, dispose } = mount({ facts: facts('session-a') })
  const res = await server.call(STATE_PATH, new FakeRequest('GET', {}))
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.deepEqual(res.json, {
    proto: 1,
    sessions: {
      'session-a': { bridged: true, terminal: 'w1', pid: 51234, since: 1762, asks: ['a1b2c3'] },
    },
  })
  dispose()
})

test('state answers an empty map rather than 404 when nothing is bridged', async () => {
  const { server, dispose } = mount({ facts: new Map() })
  const res = await server.call(STATE_PATH, new FakeRequest('GET', {}))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json, { proto: 1, sessions: {} })
  dispose()
})

test('state refuses a method it does not serve', async () => {
  const { server, dispose } = mount()
  const res = await server.call(STATE_PATH, new FakeRequest('POST', {}, '{}'))
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.get('allow'), 'GET')
  dispose()
})

test('reclaim accepts a JSON content type with parameters and any case', async () => {
  const { server, dispose, reclaimedSessions } = mount({ reclaimed: true })
  for (const contentType of ['application/json', 'Application/JSON; charset=utf-8', 'application/json;charset=UTF-8']) {
    const res = await server.call(
      RECLAIM_PATH,
      new FakeRequest('POST', { 'content-type': contentType }, '{"session":"session-a"}'),
    )
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json, { reclaimed: true })
  }
  assert.deepEqual(reclaimedSessions, ['session-a', 'session-a', 'session-a'])
  dispose()
})

test('reclaim refuses a non-JSON content type before it reads the body', async () => {
  const { server, dispose, reclaimedSessions } = mount()
  for (const contentType of ['text/plain', '', 'application/x-www-form-urlencoded']) {
    const res = await server.call(
      RECLAIM_PATH,
      new FakeRequest('POST', { 'content-type': contentType }, '{"session":"session-a"}'),
    )
    assert.equal(res.statusCode, 415)
  }
  const missing = await server.call(RECLAIM_PATH, new FakeRequest('POST', {}, '{"session":"session-a"}'))
  assert.equal(missing.statusCode, 415)
  assert.deepEqual(reclaimedSessions, [])
  dispose()
})

test('reclaim answers 400 for a body that names no session', async () => {
  const { server, dispose, reclaimedSessions } = mount()
  for (const body of ['', 'not json', '{}', '{"session":42}', '{"session":""}', '["session-a"]', 'null']) {
    const res = await server.call(RECLAIM_PATH, new FakeRequest('POST', { 'content-type': 'application/json' }, body))
    assert.equal(res.statusCode, 400, `body ${JSON.stringify(body)}`)
  }
  assert.deepEqual(reclaimedSessions, [])
  dispose()
})

test('reclaim answers 400 past the 4 KiB cap', async () => {
  const { server, dispose, reclaimedSessions } = mount()
  const body = JSON.stringify({ session: 'session-a', pad: 'x'.repeat(5000) })
  const res = await server.call(RECLAIM_PATH, new FakeRequest('POST', { 'content-type': 'application/json' }, body))
  assert.equal(res.statusCode, 400)
  assert.deepEqual(reclaimedSessions, [])
  dispose()
})

test('reclaim answers 409 idempotently when no bridge holds the session', async () => {
  const { server, dispose, reclaimedSessions } = mount({ reclaimed: false })
  const body = '{"session":"session-a"}'
  const first = await server.call(RECLAIM_PATH, new FakeRequest('POST', { 'content-type': 'application/json' }, body))
  const second = await server.call(RECLAIM_PATH, new FakeRequest('POST', { 'content-type': 'application/json' }, body))
  assert.equal(first.statusCode, 409)
  assert.deepEqual(first.json, { reclaimed: false })
  assert.equal(second.statusCode, 409)
  assert.deepEqual(reclaimedSessions, ['session-a', 'session-a'])
  dispose()
})

test('reclaim refuses a method it does not serve', async () => {
  const { server, dispose, reclaimedSessions } = mount()
  const res = await server.call(RECLAIM_PATH, new FakeRequest('GET', {}))
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.get('allow'), 'POST')
  assert.deepEqual(reclaimedSessions, [])
  dispose()
})
