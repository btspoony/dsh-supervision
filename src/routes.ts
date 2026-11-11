/**
 * The browser-facing HTTP surface: a read-only supervision snapshot and the one
 * action that hands a session back to the person looking at it in the GUI.
 *
 * Two callbacks carry all authority — the live bridge map and the transport —
 * so nothing here reads the filesystem, and the handlers stay testable against
 * a fake server with plain request/response objects.
 */

/** One bridged session, as the browser reads it. */
export interface SupervisionEntry {
  readonly bridged: true
  /** The supervisor's terminal, or the forwarder's own label when unknown. */
  readonly terminal: string
  readonly pid: number
  /** When this bridge took the session, in epoch milliseconds. */
  readonly since: number
  /** The parked approval ids the supervisor must answer, oldest first. */
  readonly asks: readonly string[]
}

/** The `GET` payload; `proto` lets a newer client ignore a shape it cannot read. */
export interface SupervisionState {
  readonly proto: 1
  readonly sessions: Readonly<Record<string, SupervisionEntry>>
}

/** What the routes may do: read the snapshot, hand one session back. */
export interface SupervisionTarget {
  snapshot(): SupervisionState
  /** @returns whether a live bridge was handed back. */
  reclaim(session: string): boolean
}

/** The per-session facts the snapshot reports, as a bridge records them. */
export interface SupervisionFacts {
  readonly pid: number
  /** When this bridge took the session, in epoch milliseconds. */
  readonly since: number
  /** The parked approval ids the supervisor must answer, oldest first. */
  readonly asks: readonly string[]
}

/**
 * Build the `GET` payload from the live bridge facts.
 * @param facts - one entry per live bridge; empty when nothing is bridged.
 * @param terminal - the supervisor's terminal, or the forwarder's own label.
 * @returns the payload, with every session reported as bridged.
 */
export function supervisionState(
  facts: ReadonlyMap<string, SupervisionFacts>,
  terminal: string,
): SupervisionState {
  const sessions: Record<string, SupervisionEntry> = {}
  for (const [session, entry] of facts) {
    sessions[session] = {
      bridged: true,
      terminal,
      pid: entry.pid,
      since: entry.since,
      asks: entry.asks,
    }
  }
  return { proto: 1, sessions }
}

/** The snapshot route. */
export const STATE_PATH = '/dsh-supervision/state'
/** The reclaim route. */
export const RECLAIM_PATH = '/dsh-supervision/reclaim'

/** The body cap for `reclaim`: the whole payload is one session id. */
const MAX_BODY = 4 * 1024

/** One request, reduced to what these routes read (node's `IncomingMessage` satisfies it). */
export interface RouteRequest extends AsyncIterable<Buffer> {
  readonly method?: string | undefined
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
}

/** One response, reduced to what these routes write (`ServerResponse` satisfies it). */
export interface RouteResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** The one `ctx.webserver` member these routes need. */
export interface RouteRegistrar {
  register(route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (req: RouteRequest, res: RouteResponse) => void | Promise<void>
  }): () => void
}

/** Write one JSON answer; snapshots and outcomes are live facts, so nothing is cached. */
function sendJson(res: RouteResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** The media-type essence of a header value: lowercased, parameters dropped. */
function essenceOf(value: string | readonly string[] | undefined): string {
  const text = typeof value === 'string' ? value : value?.[0] ?? ''
  return text.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

/** @returns the body text, or undefined once it exceeds the cap. */
async function readBody(req: RouteRequest): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  // http server streams without setEncoding always yield Buffer chunks.
  for await (const chunk of req) {
    size += chunk.byteLength
    // shortcut: an over-cap body is not drained, the response ends instead; the
    // one caller posts 32 bytes, so add a drain when a route accepts uploads.
    if (size > MAX_BODY) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** @returns the session id a `reclaim` body names, or undefined when it names none. */
function sessionOf(text: string): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Swallows the parse error: a non-JSON body is exactly the undefined case.
    return undefined
  }
  if (typeof body !== 'object' || body === null) return undefined
  const session: unknown = Reflect.get(body, 'session')
  return typeof session === 'string' && session !== '' ? session : undefined
}

/**
 * Register both routes on the host's webserver.
 * @param server - the `ctx.webserver` service.
 * @param target - the live bridge map, through two callbacks.
 * @returns the disposer removing both routes.
 */
export function registerSupervisionRoutes(server: RouteRegistrar, target: SupervisionTarget): () => void {
  const disposeState = server.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      sendJson(res, 200, target.snapshot())
    },
  })
  const disposeReclaim = server.register({
    kind: 'exact',
    path: RECLAIM_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      // A cross-origin simple form post sends text/plain, so requiring the JSON
      // essence keeps the one mutating route out of reach of a foreign page.
      if (essenceOf(req.headers['content-type']) !== 'application/json') {
        sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      const text = await readBody(req)
      const session = text === undefined ? undefined : sessionOf(text)
      if (session === undefined) {
        sendJson(res, 400, { code: 'bad-request', message: 'body must be {"session":"<id>"} under 4 KiB' })
        return
      }
      // Idempotent by design: a racing second call, or a bridge that already
      // exited, is an answer (409), never an error.
      const reclaimed = target.reclaim(session)
      sendJson(res, reclaimed ? 200 : 409, { reclaimed })
    },
  })
  return () => {
    disposeState()
    disposeReclaim()
  }
}
