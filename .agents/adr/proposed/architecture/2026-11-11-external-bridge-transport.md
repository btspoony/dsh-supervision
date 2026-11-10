# ADR: Supervise a running DSH web process through an external bridge

Status: proposed — the owner wants supervisor control over an already-running
`dsh web`, which a second in-hc process cannot provide
Date: 2026-11-11
Scope: `dsh-supervision` plugin, `dsh-sup` forwarder, herdr-core (`hc`)
integration

## Problem

herdr-core (`hc`) can only supervise a program it started in its own PTY. It
learns state exclusively from OSC 7501 written by that program and delivers
input exclusively to that program's stdin
(`01-herdr-core-contract.md`, verified against `herdr-core` v0.1.20).

DSH has no terminal surface and no OSC emitter. The behaviours a supervisor
needs — observe a turn, steer mid-turn, cancel, answer approvals — exist only
inside a DSH process:

| Path | Steer mid-turn | Answer approvals |
|---|---|---|
| Web GUI | yes (internal API) | yes (browser answerer) |
| SDK server | no (`followup()` only) | yes |
| ACP server | no | yes |
| In-process plugin | **yes** | **yes** |

So the plugin must live in the DSH process. The open question is where that
process lives.

Launching `dsh web` inside hc solves it at the cost of a second process: a
second web tree, a second port (`--port 0` or disabled `webserver` rows), a
second in-memory agent, and no access to the session the owner already has open.
The owner runs one `dsh web` and works in its GUI; the supervisor must control
**that** session, not a copy of it.

Therefore: keep the plugin in the running `dsh web`, and put a small forwarder
in the hc PTY. The forwarder reports OSC and forwards stdin; the plugin does
everything else. hc sees a well-behaved program, which is all its contract asks.

## Proposal

### Naming

| Artifact | Chosen | Rationale |
|---|---|---|
| Package | `dsh-supervision` | Names the capability, not the transport; survives a future non-hc surface |
| Forwarder bin | `dsh-sup` | Owner's choice: short at the hc prompt (`hc run --bg --name w1 dsh-sup session-…`), unambiguous once documented, and unregistered on npm |

Registry check (2026-11-10, `registry.npmjs.org`):

- `dsh-supervision` — **404, unregistered**. Available unscoped; the `@mstar`
  scope is not used by any published package either.
- `dsh-sup` — 404, unregistered.
- `dsh-ctl` — **taken**: v0.1.1, described as "DeepSeek Harness (dsh) lifecycle
  control plugin", so the name already means "start/stop/restart dsh" in this
  ecosystem. Rejected to avoid a same-domain collision.
- `dsh-attach` — taken (0.0.1), rejected.

Rejected candidates: `dsh-lite` / `dsh-lite-tty` (implies a lightweight DSH
build, which is wrong — it is a remote control), `dsh-bridge` (names the
implementation), `dsh-hc` (binds the product to herdr), `dsh-ctl` (occupied by a
lifecycle-control plugin).

### Architecture

```
hc core
└── terminal "w1" (PTY, foreground)
      └── dsh-sup            (creates a session; `attach <id>` for an existing one)
            │  stdin: hc paste + submit
            │  /dev/tty: OSC 7501 + echo lines
            │
            └── unix socket (0600, ~/.dsh/supervision/)
                  │
                  └── dsh web (already running, port unchanged)
                        ├── host plugin
                        │     ├── transport: socket server, framing, registry
                        │     ├── status: session events → OSC reports
                        │     ├── input: lines → steer / cancel / approve
                        │     ├── approval: prepended waterfall for the supervised tree
                        │     └── routes: GET /dsh-supervision/state, POST /dsh-supervision/reclaim
                        └── browser plugin (same package, ./client export)
                              ├── supervision banner in the session view
                              └── "Take back control" action → POST reclaim
```

Nothing in DSH or herdr-core changes. The forwarder is an ordinary program; the
plugin is an ordinary Cordis plugin with a host half and a browser half.

### Why the forwarder owns no logic

OSC encoding, state derivation, command grammar and the approval queue stay in
the plugin, where the session is. The forwarder does three things only:

1. write the plugin's OSC bytes verbatim to `/dev/tty` (fallback: stdout when it
   is a TTY; otherwise disable and report `error`),
2. split stdin into lines and forward them,
3. exit with a documented code when the backend is gone.

This keeps one implementation of every protocol rule and makes the forwarder
small enough to review in one sitting.

### Discovery and registry

The plugin owns one control socket per `dsh web` process:

```
$DSH_HOME/supervision/                 0700
  <pid>-<8hex>.sock                      control socket, 0600
  <pid>-<8hex>.json                      registry entry, 0600
```

Registry entry: `{ "proto": 1, "pid": 42817, "socket": "...", "startedAt": 1762..., "dshVersion": "0.2.2-rc.1" }`.
Socket paths are short because a Unix socket path is capped near 103 bytes; the
session id never appears in a path.

On startup the plugin scans the directory, removes entries whose pid is dead or
whose socket is gone, writes its own, and registers cleanup with
`ctx.effect(() => () => { close socket; unlink both files })`.

`dsh-sup list` reads every registry entry, connects, sends `{"t":"list"}`, and
prints the union:

```
SESSION                                  CWD                     LIVE  BRIDGED
session-9f3c…                            /repo/api               yes   —
session-1a07…                            /repo/web               no    —
```

### Session selection

Attaching is the exception; **starting work is the default**. A supervisor's
first command should not require knowing a session id.

| Command | Behaviour |
|---|---|
| `dsh-sup` | **Create a new session** in the running `dsh web`, `cwd` = the forwarder's current directory, and attach to it. This is the default so `hc run --bg --name w1 dsh-sup` just works |
| `dsh-sup new [--cwd <path>]` | Same, explicit |
| `dsh-sup attach <session-id>` | Attach an existing session; if it has no live agent, `ctx.agents.resume({ resumeSessionId })` with the deployment default route, exactly as opening a cold session in the GUI |
| `dsh-sup <session-id>` | Shorthand for `attach` when the first argument starts with `session-` |
| `dsh-sup list [--cwd <path>]` | List attachable sessions: id, cwd, live, bridged |
| `dsh-sup --pid <n> …` | Choose among several running `dsh web` processes; without it, exactly one registry entry must exist |

Creation details:

- The plugin derives the session id like the headless runner does
  (`session-${randomUUID()}`) and calls
  `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions })`; `cwd` is the
  absolute path the forwarder sent, not the web process's own directory.
- The new session appears in the browser session list immediately
  (`session/created` → `api-session/added`), so the person can watch it.
- A creation failure (no agent factory, no default model, bad cwd) returns
  `{"t":"error","code":"create-failed","message":…}` and the forwarder exits 5.
- `--cwd` defaults to the forwarder's `process.cwd()`; a relative value is
  resolved there, never in the web process.

One bridge per session. A second `hello` for a bridged session is answered with
`{"t":"error","code":"busy","bridgedBy":<pid>}` and exit 3. Different sessions in
one process get independent bridges; each hc terminal then owns one root record,
which is the natural mapping the supervisor already expects.

### Wire protocol

NDJSON over the Unix socket, UTF-8, one JSON object per line, max frame 64 KiB.

Plugin → forwarder:

```json
{"t":"welcome","proto":1,"session":"session-…","title":"repo","state":"idle","turn":0}
{"t":"osc","data":"\u001b]7501;state=working:app=dsh\u001b\\"}
{"t":"echo","text":"[turn 1] tool bash → exit 0 (2.1s)"}
{"t":"sessions","items":[{"id":"session-…","cwd":"/repo","live":true,"bridged":false}]}
{"t":"error","code":"busy|unknown-session|create-failed|locked|protocol|internal","message":"…"}
{"t":"bye","reason":"plugin-disposed"}
```

Forwarder → plugin:

```json
{"t":"hello","proto":1,"pid":51234,"attach":"session-…"}
{"t":"hello","proto":1,"pid":51234,"new":{"cwd":"/repo"}}
{"t":"hello","proto":1,"pid":51234}
{"t":"line","text":"run the tests"}
{"t":"list","cwd":"/repo"}
{"t":"bye"}
```

`hello` without `attach` or `new` means "create" (the bare `dsh-sup` case); the
plugin answers `welcome` with the new session id in both attach and create
cases, so the forwarder has one success path. `list` never binds a bridge.

Rules:

- The forwarder writes the root `idle` from `welcome` **before** reading stdin,
  so hc's readiness gate and `started: true` both work.
- `osc.data` is opaque bytes; the forwarder never inspects or re-encodes it.
- A `hello` whose `proto` is not 1 is refused with `error.code = "protocol"`.
- Every inbound frame is validated in the plugin; the forwarder validates only
  JSON parseability, so it stays dependency-free.

### Status derivation (plugin)

Unchanged from the in-process design, and the reason the forwarder can stay
dumb. Precedence, highest first:

| Condition | Root report |
|---|---|
| any parked approval in the supervised tree | `blocked:kind=permission:msg=<tool> <reason> [ask <id>]` |
| a turn is running | `working` |
| last turn ended `error` | `error:msg=<summary>` |
| last turn ended `completed` | `done` |
| nothing running | `idle` |
| plugin disposing | `clear` |

Sources: `session/event` (`turn/start`, `turn/end` with
`reason.kind ∈ completed | aborted | blocked | error | max-tokens | interrupted`),
`agent/status`, `approval/asked` / `approval/decided`. Every root report restates
`app` and `title` because a root record is replaced whole. `turn` is never faked:
it advances only when the root leaves `working`.

Non-attached sessions in the same process are child records
`id=<sessionId>`; in-process subagents use `id=sub/<sessionId>`. Child reports
never change `turn` and are invisible to `hc wait`.

### Input grammar (plugin)

| Line | Effect |
|---|---|
| plain text | `agent.steer(createUserMessage({content:[{type:'text',text}], source:{kind:'user'}}))` on the attached session |
| `/approve <ask-id>` | settle that approval `allowed-once` |
| `/reject <ask-id>` | settle it `rejected` |
| `/cancel` | `agent.cancel({ kind: 'user' })` |
| `/status` | echo one line: session, state, turn, pending ask ids |
| `/attach <session-id>` | switch the bridge to another live session (refused while an ask is parked) |

Bare `/y` / `/n` settle the single parked ask and are refused when more than one
is parked. `steer()` starts a turn on an idle agent
(`packages/core/agent/src/runtime-types.ts:254`), so there is no separate
follow-up branch.

While the root is `blocked`, hc refuses `send` without `--force`. That is the
human gate by design: a supervisor escalates deliberately with
`hc send --force w1 "/approve <id>"`, and the plugin echoes one audit line per
decision naming the ask id, outcome and source.

### Approvals

Register once with `ctx.on('approval/request', handler, { prepend: true })`
(cordis `unshift` at registration, `shift` at dispatch — `vendor/cordis/src/events.ts:142,264`).
The waterfall receiver is `scopeTarget(req.agent, req.agent)`, whose filter
admits root-context listeners for every agent
(`packages/core/scope/src/index.ts:172-183`), so one handler sees all asks.

Claim rule: `subagents.rootOf(req.agent).session.header.id` equals the bridged
session. That covers the session itself and every in-process subagent beneath
it; everything else calls `next()` and keeps the GUI answerer. A throw from
`rootOf` (agent outside any tree) also delegates.

Root `blocked` is forced regardless of the attached session's own word: hc's
`send` refusal reads only the root, and a child record showing `blocked` blocks
nobody. The root returns to the attached session's real word when the last
parked ask **in the bridged tree** settles; an ask in another session of the
same process never moves this root, because it is not claimed here at all.

Fail closed: asker `req.signal` abort, bridge disconnect, plugin dispose, or
`approvalTimeoutMs` expiry (default disabled) → `cancelled`.

### Activation

```
active = config.enabled !== false && (a forwarder is connected || HC_TERMINAL_ID is set)
```

A GUI-only `dsh web` has neither signal: the plugin registers no listener, reads
no stdin, writes no OSC, and writes no registry entry. This is the single most
important safety property: a prepended answerer must never silently steal
approvals from the person using the browser.

### Lifecycle and failure

| Event | Behaviour |
|---|---|
| forwarder starts | connect → `hello` → wait ≤ 5 s for `welcome` → write root `idle` → read stdin. No `welcome` → write `error:msg=backend handshake timeout`, exit 1 |
| socket EOF (web died, plugin disposed, HMR reload) | write `error:msg=backend offline`, exit 1 |
| forwarder dies | plugin drops the bridge, resolves every parked ask `cancelled`, emits child-record cleanup; the agent keeps running |
| session busy | `error:code=busy`, exit 3 |
| unknown/resumable session | resume; if the writer lock is held elsewhere, `error:code=locked`, exit 4 |
| create fails (no factory, no default model, bad cwd) | `error:code=create-failed` with the reason, exit 5 |
| usage/no candidate/multiple `dsh web` processes | print candidates, exit 2 |
| `hc kill w1` | kills the forwarder only. The agent, session and browser GUI keep running; approvals return to the GUI answerer |
| browser `reclaim` | host sends `bye/reclaimed`, closes the socket; forwarder writes `clear` and exits 0; approvals return to the GUI immediately; UI banner disappears on the next poll |

No automatic reconnect: a restarted `dsh web` is a new process with a new
socket; the supervisor starts a new forwarder. Reconnecting would silently
rebind a session the supervisor no longer holds.

### Browser UI: supervision state and reclaim

A takeover that the person in the browser cannot see is unacceptable: they would
watch approvals disappear with no explanation. Two surfaces are therefore part
of the product, not an optional extra.

**Host routes** (registered on `ctx.webserver`, which accepts named routes from
any plugin — `packages/host/webserver/src/index.ts:445`):

| Route | Method | Body |
|---|---|---|
| `/dsh-supervision/state` | GET | `{"sessions":{"<id>":{"bridged":true,"terminal":"w1","pid":51234,"since":1762…,"asks":["3f9a"]}}}` |
| `/dsh-supervision/reclaim` | POST | `{"session":"<id>"}` → 200 `{"reclaimed":true}`; 409 when no bridge |

`reclaim` requires `Content-Type: application/json` so a cross-origin simple
form post cannot reach it; the only consequence it can cause is handing control
back to the person already looking at the session.

**Browser plugin** (same package, `./client` export, declared through
`dsh.client` in `package.json`, injected with `sessions`, `remote`, `uiSession`,
`slots`, `locale`):

- polls `/dsh-supervision/state` every 2 s (SSE is unnecessary for a boolean
  that changes a few times a day);
- registers a session-scoped banner slot above the composer:
  `Supervised from terminal w1 (pid 51234) · approvals are answered there · [Take back control]`;
- the action POSTs `reclaim`, then optimistically hides the banner and lets the
  next poll confirm.

**Reclaim semantics**

1. Host sends `{"t":"bye","reason":"reclaimed"}` and closes that bridge's socket.
2. `dsh-sup` writes `state=clear`, exits 0; hc records a finished terminal with
   exit 0, so the supervisor sees an explicit, non-error end.
3. Approvals for that session and its subagent tree immediately fall back to the
   browser answerer; the next gated tool shows its normal card.
4. Reconnecting is allowed: a new `dsh-sup` takes the session again and the
   banner returns. There is no "do not reconnect" tombstone.

This replaces the earlier "GUI receives no banner" decision: the state must be
visible, and the person must have an explicit way back. What does **not** change
is single ownership — while bridged, only the supervisor answers approvals.

Messages steered from hc appear in the GUI's transcript, tagged by source; the
GUI and hc are two views of one session, not two sessions.

### Technology choices

| Part | Choice | Why |
|---|---|---|
| Plugin (host) | TypeScript → `lib/` via `tsc`, ESM, `exports` map | Matches DSH package shape; loaders resolve built JS |
| Plugin (browser) | Same package, `./client` export, `dsh.client` roster entry, React slot components | The shipped DSH way to add UI (`packages/client/ui-approval` is the model) |
| UI → host channel | `ctx.webserver` named routes (`GET /dsh-supervision/state`, `POST /dsh-supervision/reclaim`) | No Typert generator, no remote-event allowlist change; the webserver accepts plugin routes |
| Forwarder | `bin/dsh-sup.mjs`, plain ESM JavaScript, zero dependencies | No build step, auditable, runs on any Node ≥ 22 |
| Shared protocol | JSON only; types live in the plugin, the forwarder parses JSON | One validator, no shared build artifact |
| IPC | Unix domain socket, `0600`, directory `0700` | Local only; no network surface |
| Tests | `node --test` for pure functions and socket round-trips | Zero dependency; DSH's vitest stays in DSH |
| Registry | `$DSH_HOME/supervision/*.json`, stale entries reclaimed by pid | Survives restarts without a daemon |

Node built-ins only: `node:net`, `node:fs`, `node:path`, `node:os`,
`node:process`, `node:readline`.

### Security model

- The socket is reachable by the same OS user only (directory `0700`, socket
  `0600`). That user can already read `~/.dsh` sessions and settings, so the
  socket adds no new privilege boundary; it is a new *injection path* and is
  documented as such.
- No TCP, no HTTP, no token. A token would not raise the boundary (same user can
  read it) and would add rotation state.
- Any process that can write the socket can steer the agent. That is the same
  authority as `hc send` to the forwarder, so the trust surface is unchanged
  from hc's own model.
- A cross-origin page reachable from the browser cannot reclaim the session: the
  route requires `Content-Type: application/json`, which forces a CORS preflight
  that the server does not answer. The worst a same-origin script can do is hand
  control back to the person already watching the session.
- Registry and socket files are removed on dispose; a crashed process leaves a
  stale entry that the next plugin start reclaims.

### Phasing

| Phase | Deliverable | Gate |
|---|---|---|
| **P0** | plugin: `osc.ts`, `state.ts`, `transport.ts` (socket + registry); forwarder: socket client, tty writer, stdin reader | Encoder tests pass; hc shows `reported:true`, `turn:1`, echo lines through the forwarder |
| **P1** | command grammar, `steer`/`cancel`, session selection, `list`, busy/locked refusals, child records; browser banner + `reclaim` route | Same-turn steering proven on the session log; `dsh-sup list` accurate; dual-bridge refusal; banner appears and reclaim returns approvals to the GUI |
| **P2** | approval bridge, subagent tree claim, audit echo | Blocked root + exit 9 + `--force /approve`; subagent ask reaches root; GUI untouched when no bridge |
| **P3** (optional) | in-process transport (direct tty, no forwarder) | Same acceptance as P0 with `dsh web` started inside hc |

The in-process transport (`dsh web` inside hc) is not dropped: it shares every
module above and is the fallback when the owner wants a dedicated worker.

## Alternatives considered

1. **`dsh web` inside hc (`--port 0`).** Rejected as the primary shape: it
   cannot supervise the session the owner already has open, needs a second web
   tree and port, and duplicates the agent. Kept as a secondary transport
   because it reuses the same modules.
2. **SDK or ACP as the control surface.** Rejected: neither can steer mid-turn;
   ACP rejects concurrent prompts; SDK has no wire-level cancel. Verified in
   `02-dsh-surfaces.md` and `03-probes.md`.
3. **Screen scraping or hc-side heuristics.** Forbidden by herdr-core's own
   `AGENTS.md` ("no screen detection, no vendor-specific logic").
4. **Calling DSH's internal HTTP API.** Rejected: authenticated internal GUI
   surface, unstable contract, and no approval answerer role.
5. **A token-authenticated TCP bridge.** Rejected: adds a network surface with
   no security gain over a `0600` Unix socket on a single-user machine.
6. **Forwarding through a log file or fifo instead of a socket.** Rejected:
   no backpressure, no disconnect detection, no session binding.
7. **Writing the forwarder in Go or Rust.** Rejected: extra toolchain and
   distribution for a program that moves bytes and lines.
8. **Having the plugin itself write OSC to a tty it does not own.** Impossible:
   the running `dsh web` has no relationship to the hc PTY.

## Acceptance criteria

1. Unit: encoder drops an over-cap `msg`, rejects `kind` on `working`, terminates
   with `ESC \`; state machine maps each `turn/end.reason.kind` and never reports
   a resumed session's historical outcome as a fresh `done`.
2. Socket: round-trip `hello`/`welcome`/`osc`/`line`; a second `hello` for a
   bridged session returns `busy`; closing the socket makes the forwarder exit 1
   with `error:msg=backend offline`; plugin dispose removes the registry entry
   and socket file.
3. hc end-to-end, forwarder transport: `hc run --bg --name w1 --cwd /repo dsh-sup`
   creates a session and shows `reported: true`, `state: idle`, `app: "dsh"`,
   `title: repo`; the new session appears in the browser session list; one
   `hc send` yields `turn: 1`; `hc read` shows the echo lines. `dsh-sup attach
   <id>` attaches that same session from a second terminal, and `dsh-sup list`
   reports both the live and the bridged state.
4. Steering: with a 20 s tool running, `hc send w1 "ignore that, answer BETA"`
   produces a second `step/start` **inside the same turn** and no `turn/end`
   before it.
5. Cancel: `hc send w1 "/cancel"` ends the turn with `aborted`; root returns to
   `idle`.
6. Approval: a gated tool yields root `blocked` with the ask id; `hc send w1
   "/approve <id>"` exits 9; `hc send --force w1 "/approve <id>"` allows once and
   the turn completes; `hc read w1` shows one audit line with ask id, outcome and
   source.
7. Subagent approval: parent `idle`, a `spawn` subagent raises an ask → root
   flips to `blocked`; after `--force /approve` the root returns to `idle` and the
   child continues.
8. Inert without a bridge: a plain `dsh web` registers nothing, writes no OSC,
   reads no stdin, and still shows its browser approval card. Assert by grepping
   a redirected run for `\x1b]7501` (zero hits) and completing one approval in
   the GUI.
9. Multi-worker: two forwarders on two sessions show independent root records and
   independent `turn` counters; `hc wait --children any` reports both.
10. GUI coexistence: messages steered from hc appear in the browser transcript.
11. Supervision UI: with a bridge connected, the browser session view shows the
    banner naming the terminal and pid; `POST /dsh-supervision/reclaim` closes the
    bridge, the forwarder exits 0, the banner disappears within one poll, and the
    next gated tool shows the normal browser approval card.
12. UI isolation: without a bridge, `GET /dsh-supervision/state` returns an empty
    session map and no banner renders.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| DSH internal API drift (`agents.resume`, `subagents.rootOf`, `session/event`) | Plugin breaks on a DSH upgrade | Pin the DSH version in the README; isolate every call behind `src/dsh.ts`; smoke test on upgrade |
| herdr-core protocol drift (0.1.x) | Status/exit semantics change | Measured baseline v0.1.20; encoder caps live in one module; optional `ESC]7501;?` probe logs the core's advertised states |
| Plugin HMR/reload | Socket drops, forwarder exits, supervisor loses the bridge | Documented behaviour; forwarder exits 1; supervisor restarts it |
| Same session driven by GUI and supervisor simultaneously | Interleaved steering, last writer wins | Accepted; session log tags sources; approvals have exactly one owner |
| Stale registry after a crash | `dsh-sup list` shows a dead entry | Pid liveness check on list and on plugin start; stale files unlinked |
| `/dev/tty` missing (container, remote, Electron) | Forwarder cannot report | Fall back to stdout when it is a TTY; otherwise `error:msg=no tty` and exit 1 |
| Local socket injection | Same-user process can steer the agent | Same privilege as `~/.dsh` access; directory `0700`, no TCP; documented |
| Two answerers (plugin + browser) | Approval races | Plugin claims only the bridged tree; the browser answerer never sees bridged asks |
| Long `session-id` in a filesystem path | `ENAMETOOLONG` | Session ids never appear in paths; pid + random hex only |
| Client/host half skew | Banner renders against an older route payload | `proto` in the state response; the client ignores unknown fields and hides the banner when `proto` differs |
| Route name collision with another plugin | `webserver.register` throws on duplicate paths | Namespace every route under `/dsh-supervision/`; a collision is a hard boot error, deliberately loud |
| Reclaim race (bridge exits while the request lands) | 409 or a stale banner for one poll | Reclaim is idempotent: closing an absent bridge returns `{reclaimed:false}` with 409, and the UI hides on the next poll |
