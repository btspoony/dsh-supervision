# dsh-supervision: supervised DSH sessions for herdr-core

**plan_id:** dsh-supervision
**Delivery kind:** development
**Date:** 2026-11-11
**Planned at:** c35eb18
**Status:** Locked — transport, naming, CLI and takeover UX settled in
`.agents/adr/proposed/architecture/2026-11-11-external-bridge-transport.md`

## 1. Context

Research package: `.mstar/projects/_default/reference/kick-off/` (README + 01–05).

Version delta: the research was written against herdr-core `ce81486` / crate
0.1.19; this plan was verified against `master` at `de97ea5` (tag `v0.1.20`,
2026-11-10). The contract did not move: `crates/herdr-core/src/status.rs:76`
still increments `turn` only when `was_working && !working`, `status.rs:13`
still caps records at 256, `input.rs:418` still refuses a `blocked` target
without `--force`, and `rpc.rs:64` still maps `blocked` to exit 9.

herdr-core (`hc` 0.1.19–0.1.20) has no agent object. A program becomes a first-class
terminal agent by (a) emitting OSC 7501 status, (b) accepting pasted text plus
submit on stdin. Verified contract details are in
`01-herdr-core-contract.md`; the decisive ones:

- A root report replaces the whole record: every report must restate `app`.
- `turn` increments only when the root record leaves `working`.
- `blocked` refuses `hc send` with exit 9; `--force` bypasses.
- The program must stay in the PTY's foreground process group.
- Child records (`id=…`) never affect `turn` or `wait`.

DSH (checkout `../../deepseek-harness`, version `0.2.2-rc.1`) has no TUI in core
and no OSC 7501 emitter. The only place that can both observe a turn and inject
into it is an in-process plugin (`02-dsh-surfaces.md` §7):

| Path | Can steer mid-turn |
|---|---|
| Web BFF (`agent.steer()` for `mode:'steer'`) | yes, internal GUI API |
| SDK server | no (`followup()` only) |
| ACP server | no |
| In-process plugin | **yes** |

Current state that constrains the design (verified in source this session):

1. **Nothing in the `web` profile reads stdin.** `process.stdin` appears only in
   `packages/acp/acp/src/index.ts`, `packages/sdk/server/src/index.ts`,
   `packages/bundle/headless/src/runner-internals.ts`,
   `packages/boot/cmdline/src/index.ts`, `packages/ssh/ssh/src/helper-entry.ts`.
   The stdin channel is therefore free for a plugin in the web profile.
2. **The owner's `web` profile is heavily customised** (`~/.dsh/profiles/web/
   package.json` links `@mstar-harness/dsh`, `dsh-advisor`, `dsh-context`,
   `dsh-keys-manager`, `dsh-llm-fallbacks`, `dsh-ponytail`, plus a long
   `cordis.patch.yml`). A separate profile would fork that configuration.
3. **The approval waterfall is agent-scoped and ordered by registration.**
   `packages/interaction/user-approval/src/index.ts` dispatches
   `ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, …)`;
   `vendor/cordis/src/events.ts` registers with `unshift` when
   `options.prepend` is true and `waterfall()` consumes with `shift`. A
   `prepend` listener therefore runs before the Web remote answerer regardless
   of profile row order.
4. **The policy gate runs before the waterfall.** Same file: `effectivePolicy
   === 'never'` returns `rejected` before dispatch. The owner's profile sets
   `permission.defaultPreset: danger-full-access` → `approval: never`, so no
   answerer is ever called. Approvals require `ask`.
5. **`steer()` on an idle agent starts a turn**
   (`packages/core/agent/src/runtime-types.ts:254`). A stdin line needs one
   path, not a `steer`/`followup` branch.
6. **The Web remote answerer is always offered the request.**
   `packages/api/remotes/src/index.ts` `forwardWaterfall()` pushes to the queue
   and awaits the browser; only a missing carrier or a closed queue calls
   `next()`. With a browser connected and the plugin not first, the plugin
   never sees the request.
7. **The status encoder is already solved.** `@deepseek-harness-tui/dsh-tui`
   0.19.0 ships `lib/types/ink/termio/osc7501.js` (caps, sanitizing, ST
   termination, dedup) and `lib/types/ink/hooks/use-program-status.js` (state
   precedence, live-turn latch). It is MIT; read it for semantics, do not copy
   code without adding attribution to `THIRD_PARTY_NOTICES`.

Operating model: the surface exists so a **supervisor** drives DSH through
`hc` — `hc send` steers, `hc interrupt` stops, `hc send --force` settles
approvals, `hc wait`/`hc get` observe. A human attaching to the PTY is the
fallback, not the design centre. Every command the plugin accepts must
therefore be machine-typable and unambiguous (explicit verbs, ask ids), and
every decision it takes must be visible in `hc read`.

## 2. Decision

Ship **one Cordis plugin package on the existing `web` profile**, not a
separate profile. Its primary transport is the external forwarder
`dsh-sup` (§9, ADR `2026-11-11-external-bridge-transport.md`); the in-process
shape is an optional second implementation of the same interface.

Reasons, in order of weight:

1. The stated goal is to keep the Web profile's plugins, settings, credentials
   and session history. An overlay keeps them with zero copying; a separate
   profile copies the plugin list and immediately diverges from the owner's
   customised profile.
2. The web profile consumes no stdin, so the input channel can be added without
   disabling anything. The plugin is nevertheless **inert unless a supervised
   surface names it** — `HC_TERMINAL_ID` (transport A) or a connected forwarder
   (transport B, §9) — so a plain `dsh web` keeps its current behaviour,
   including its browser approval flow.
3. Approval ownership is decided by `prepend`, not by disabling the browser
   answerer. On a supervised surface the supervisor owns approvals; elsewhere
   the plugin never registers, so the GUI answerer is untouched. A separate
   profile is not required to win the waterfall. The browser is never left
   uninformed: the session view shows a takeover banner and an explicit
   "Take back control" action that returns approval ownership to the GUI.
4. One package with one plugin keeps the shared writer, the attached-session
   state and the approval queue in one place. The research design split four
   components; they must share a single `/dev/tty` writer and one session
   subject, so four rows buy ordering problems, not isolation.

Activation gate, precisely — two layers, because a forwarder can only exist by
connecting to a socket the plugin must create first:

```
discovery = config.enabled !== false          // create socket + registry entry
effect    = discovery && (HC_TERMINAL_ID is a non-empty string   // transport A
                          || a bridge is connected)              // transport B
```

- **Discovery layer**: unless `enabled === false`, `apply` creates the socket and
  registry entry at startup. It has no effect on the agent: no OSC, no event
  subscription, no stdin read, no approval listener.
- **Effect layer**: only when `HC_TERMINAL_ID` is set or a bridge has completed
  `welcome`. Then — and only then — the emitter, the line reader and (P2) the
  prepended approval answerer mount, scoped to the bridged session tree.

This is what prevents the worst regression of the design: a prepended answerer
silently stealing approvals from a person using the browser GUI on a `dsh web`
that merely happens to run in a terminal. On a GUI-only run no bridge exists and
`HC_TERMINAL_ID` is unset, so the effect layer never mounts; the socket is a
local, permission-restricted discovery surface with no agent-facing behaviour.

The gate is the only place the two transports differ. Transport A writes OSC to
`/dev/tty` directly and reads `process.stdin`; transport B hands the same bytes
and lines to the forwarder over a socket. Everything upstream of the transport
— encoder, state machine, command grammar, approval queue — is shared.

Package layout: the repository root **is the plugin package**; the shared
protocol is a private package; the forwarder is a separately publishable package.

```
package.json                     name dsh-supervision (plugin, publishable)
tsconfig.json / tsconfig.base.json
pnpm-workspace.yaml              packages: ["packages/*"]
src/index.ts                     host plugin: name, inject, Config, apply()
src/state.ts                     session-event → report state derivation
src/transport.ts                 control socket, Bridge/Transport interfaces
src/routes.ts                    GET /dsh-supervision/state, POST /dsh-supervision/reclaim (P1)
src/stdin.ts                     inbound line grammar (P1)
src/approval.ts                  prepended approval/request bridge (P2)
src/client/index.ts              browser plugin: banner slot + reclaim action (P1)
src/transport-inprocess.ts       deferred §5.1: direct tty writer, no socket
src/state.test.ts                precedence and turn latch
src/transport.test.ts            socket round-trip, busy, dispose cleanup

packages/protocol/               name dsh-supervision-protocol, "private": true
  src/osc.ts                     OSC 7501 encoder, caps, sanitizing
  src/frames.ts                  frame types, runtime guards, encode/decode
  src/registry.ts                registry paths, entry guard, liveness, reclaim
  src/index.ts                   one re-export surface
  src/*.test.ts                  encoder caps, frame guards, registry rules

packages/cli/                    name dsh-sup (publishable, independent)
  package.json                   bin { "dsh-sup": "./bin/dsh-sup.mjs" }
  bin/dsh-sup.mjs                thin shebang shim importing ../lib/main.js
  src/main.ts                    orchestration: parse → registry → connect → tty → stdin pump
  src/args.ts                    new | attach | list | usage, --cwd, --pid
  src/registry.ts                selection policy: none | single | ambiguous
  src/connection.ts              NDJSON client, 5 s welcome timeout, frame cap
  src/tty.ts                     /dev/tty → stdout(isTTY) → unavailable, single writer
  src/*.test.ts                  CLI grammar, registry selection, framing
```

Packaging constraint: `dsh-supervision-protocol` is private, so it can never be
a runtime dependency of a published package. Both `dsh-supervision` and `dsh-sup`
bundle it into their own output (tsdown); their `dependencies` stay empty, and
their tarballs contain no `packages/` entries.


Phasing, each phase independently useful:

| Phase | Scope | Why it is separable |
|---|---|---|
| **P0** | `src/osc.ts`, `src/state.ts`, `src/transport.ts`, `cli/*` (new/attach/list + tty + stdin pump), echo lines | Read-only supervision through the forwarder; no input grammar, no approval risk |
| **P1** | `stdin.ts` — `steer`, `/cancel`, `/status`, `/attach`, `/approve`, `/reject`; session selection and `list`; child records for non-attached sessions; `src/routes.ts` + `src/client/` — takeover banner and explicit reclaim | Requires P0's transport and session subject; makes concurrent supervision usable and visible |
| **P2** | `approval.ts` — `prepend` waterfall, `blocked`, supervisor decisions, audit echo | Requires P1's input channel and an owner decision on policy |
| **P3** (optional) | `transport-inprocess.ts` — `dsh web` inside hc, no forwarder | Same interface; only when a dedicated worker is wanted |

### Concurrency

Three different things are called "children"; do not conflate them:

| Layer | Name | Meaning | Surface |
|---|---|---|---|
| hc | terminal children | a terminal started from another (`parent`, `hc wait --children any`) | `hc ls`, `hc wait` |
| OSC 7501 | `records[id]` | extra status records one program reports inside one terminal, `/`-hierarchical | `hc get.records` |
| DSH | session / agent | one conversation unit; a `spawn`/`fork` subagent owns its own durable session | plugin: `ctx.agents.list()` |

This plan's "multi-session" means the **DSH** layer. A `spawn` or `fork`
subagent runs in-process and therefore becomes visible through the same
mechanism; an external subagent (ACP, SDK, Codex, Claude Code) is a separate
process and cannot be observed or reported from here.

Two shapes, both legitimate; the plugin must not assume one:

1. **Process-per-worker — the primary shape.** Each
   `hc run --bg --name dsh-N dsh web --patch …` owns one session, so root
   records are naturally isolated and `hc send`/`hc wait` address each worker
   directly. `hc wait --children any` (hc terminal children) covers a supervisor
   watching several workers.
2. **Multi-session in one process.** OSC has exactly one root record, so the
   *attached* session (last targeted by `/attach`, `/new`, or a supervisor
   message) owns the root — with one override: while any in-process session or
   subagent has a parked approval, the root is `blocked` regardless of the
   attached session's word (P2). Every other live session is a child record
   `id=<sessionId>` (in-process subagents use `id=sub/<sessionId>`), refreshed on
   its turn boundaries and removed with `state=clear:id=<sessionId>`. Child
   records never advance `turn` and are invisible to `hc wait` — a supervisor
   reads them through `hc get`/`hc ls` on the same terminal.

Blind spot this closes: a `spawn` subagent is a background activation, so the
parent can sit `idle` while children still work. The root word alone would tell
a supervisor "nothing is running"; the child records keep that work visible
even though `hc wait` still only follows the root.

Workers never share a session: DSH's session controller fences an agent to one
owner, so N concurrent workers require N sessions.

### Process ownership and the web port

hc can only supervise a program **it started in its own PTY**. It has no way to
adopt an already-running `dsh web`: an OSC report written by that process goes
to its original `/dev/tty`, which hc never reads, and `hc attach` attaches to an
hc terminal, not to an arbitrary PID. The same holds for input: `hc send` writes
to the stdin of that PTY. So the worker process must be launched by `hc run`.

Port consequences, verified in `packages/bundle/web-app/cordis.patch.yml`:

- `webserver` binds `ctx.webStartup.port ?? 3080`.
- `dsh web --port <n>` overrides it and **`--port 0` lets the OS pick a free
  port** (`packages/bundle/web-app/src/startup.ts:66`).

Therefore the launch form is:

```sh
hc run --bg --name dsh-1 --cwd /repo dsh web --port 0 --no-open
hc read dsh-1 --lines 40      # the printed URL line gives the actual port
```

The browser may open that URL and watch the **same** agent; the GUI and hc are
two views of one process. The GUI does not get approvals, though — inside hc the
plugin's prepended answerer owns them (that is the point of the gate, §7).

A pure worker with no HTTP surface is the alternative: an overlay that disables
the `webserver` and `web-runtime` rows. That removes the port entirely and
starts faster, at the cost of the browser view. Pick per deployment; the plugin
itself does not care which.

```yaml
# lite.overlay.yml — no HTTP surface, agent + plugin only
- id: webserver
  disabled: true
- id: web-runtime
  disabled: true
```

Not supported directly: hc adopting an already-running `dsh web` on its own. hc
never reads another process's `/dev/tty`, and the DSH writer lock already stops
two processes from driving one session. The supported form of that idea is the
forwarder in §9: a small program in the hc PTY reports OSC and relays input over
a local socket, while the plugin stays in the running `dsh web`.

## 3. Non-goals

- Replacing the browser GUI. It stays; this is an additional surface.
- Independent policy answers without an audit trail: a supervisor may decide,
  but every decision is echoed with its ask id and source.
- Treating an unattended process as a background service: hc drops the status
  when the worker leaves the foreground process group.
- Any change to `deepseek-harness` or `herdr-core` source.
- A full-screen TUI; `dsh-tui` remains the reference, not a dependency.

## 4. Interfaces (verbatim from source)

```ts
// packages/core/agent/src/runtime-types.ts:260, :207
steer(message: UserMessage): void
cancel(cause: AgentCancelCause, options?: CancelOptions): void   // CancelOptions.keepInbox

// packages/interaction/user-approval/src/types.ts:87
'approval/request'(
  this: Scoped<Agent>,
  req: ApprovalRequestEvent,
  next: () => Promise<ApprovalOutcome>,
): Promise<ApprovalOutcome>          // 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

// packages/core/agent/src/runtime-types.ts:303
'turn/end': { turn: number; reason: TurnEndReason }
// reason.kind ∈ completed | aborted | blocked | error | max-tokens | interrupted | (fork markers)

// packages/bundle/headless/src/index.ts:389, :420
await agents.create({ sessionId, meta: { cwd }, agentOptions, setup })   // → { agent }
agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))

// packages/core/agent/src/index.ts:127, :205, :429
interface ResumeAgentOptions { resumeSessionId: SessionId; agentOptions?: AgentOptions; signal?: AbortSignal; setup?: … }
resume(options: ResumeAgentOptions): Promise<AgentHandle>

// packages/subagent/subagent/src/index.ts:295
rootOf(caller: Agent): Agent          // live tree root; throws outside a tree

// packages/host/webserver/src/index.ts:445
register(route: WebRoute): () => void // exact/prefix + handler(request,response); duplicate path throws
```

`ctx.on(name, listener, { prepend: true })` is the documented cordis option
(`vendor/cordis/src/events.ts:113`).

Scope routing is what lets one plugin answer for one agent: the waterfall
receiver is `scopeTarget(req.agent, req.agent)`, whose filter admits any
listener whose context has no scope tag
(`packages/core/scope/src/index.ts:172-183`: `scopeOf(ctx) === undefined →
true`) and any listener tagged with a matching or ancestor scope. A listener
registered on the **root** context therefore receives every agent's
`approval/request`; filter on `req.agent` inside the handler. Registering on
`agent.ctx` also works but requires tracking each agent's creation.

OSC wire form (from `crates/herdr-core/src/status.rs` and `dsh-tui`'s encoder):

```
ESC ] 7501 ; state=<word>[:id=…][:kind=…][:progress=…][:app=…][:title=<b64>][:msg=<b64>] ST
ST = ESC \
```

## 5. Task P0 — encoder, state, and the forwarder

**In scope:** `package.json`, `tsconfig.json`, `src/osc.ts`, `src/state.ts`,
`src/transport.ts`, `src/index.ts`, `src/osc.test.ts`, `src/state.test.ts`,
`src/transport.test.ts`; and in `cli/`: `package.json`, `tsconfig.json`,
`bin/dsh-sup.mjs`, `src/{main,args,registry,connection,tty}.ts`,
`src/{args,registry}.test.ts`.

**Out of scope:** `src/stdin.ts`, `src/approval.ts`, the in-process tty writer
(deferred to §5.1); any file under `../../deepseek-harness`;
`~/.dsh/profiles/web/cordis.patch.yml` (P0 is validated with a temporary
`--patch` overlay and reverted).

Steps:

1. `src/osc.ts`: encode only the legal forms; drop (never truncate) an illegal
   report. Caps: sequence < 4096 bytes, `app` ≤ 32 and `[A-Za-z0-9_.+-]+`,
   `msg` ≤ 2048 decoded / 2732 encoded, `title` ≤ 192 / 256, `id` ≤ 128 with
   ≤ 8 `/`-separated segments. Sanitize free text to one control-free line
   (C0/C1/DEL/bidi removed). Terminate with `ESC \`.
2. `src/state.ts`: derive the root report from `session/event` + `agent/status`
   with precedence `blocked` > `working` > `done`/`error` > `idle`, plus a
   per-session latch so a resumed session's historical `turn/end` is never
   reported as a fresh `done`. Dedup identical consecutive reports; restate
   every field on a changed one.
3. `src/transport.ts`: the control socket. Create
   `$DSH_HOME/supervision/<pid>-<8hex>.sock` (dir `0700`, socket `0600`), write the
   registry entry, reclaim stale entries by pid, and serve one bridge per
   session. Frame codec for the NDJSON protocol in the ADR
   (`hello`/`welcome`/`osc`/`echo`/`line`/`list`/`error`/`bye`), with `proto:1`
   checked on `hello`. Dispose closes the socket, unlinks both files, and
   resolves parked asks `cancelled`.
4. `cli/src/main.ts` (+ `args`, `registry`, `connection`, `tty`): resolve the target registry entry (single entry, or
   `--pid <n>`), then:
   - bare `dsh-sup` or `dsh-sup new [--cwd <path>]` → `hello` without a target
     (create), `cwd` = the forwarder's resolved cwd;
   - `dsh-sup attach <id>` or `dsh-sup <session-…>` → `hello` with `attach`;
   - `dsh-sup list [--cwd <path>]` → `list`, print, exit 0.
   Then wait ≤ 5 s for `welcome`, write the root `idle` to `/dev/tty` (fallback
   stdout when `isTTY`, else `error` and exit 1), and pump lines both ways.
   Exit codes: 0 normal, 1 backend lost, 2 usage/multiple backends, 3 session
   busy, 4 writer-lock conflict, 5 create failed.
5. `src/index.ts`: `export const name`, `export const inject = ['agents']`,
   `export const Config`, `export function apply(ctx, config)`. Serve three
   `hello` shapes: `attach` → the live agent or
   `agents.resume({ resumeSessionId })`; `new` → `agents.create({ sessionId:
   \`session-${randomUUID()}\`, meta: { cwd }, agentOptions })`; bare →
   create with the forwarder's cwd. Reply `welcome` with the resulting session
   id in every successful case, and `error` with `create-failed` / `locked` /
   `busy` otherwise. Subscribe to `session/event` for the bridged session, push
   encoded reports to the socket, and keep `src/transport.ts` behind
   `Transport` so §5.1 and future shapes are additions, not rewrites.
6. Config: `enabled` (default true; false skips even the discovery socket),
   `programStatus` (default on), `app` (`dsh`), `echo` (default on),
   `titleFrom` (`cwd-basename|session-title|none`, default `cwd-basename`),
   `socketDir` (default `$DSH_HOME/supervision`).

**Acceptance (P0):**

- `node --test test/osc.test.ts test/state.test.ts test/transport.test.ts`
  passes; the encoder test asserts a dropped over-cap `msg`, a rejected `kind`
  on `working`, and ST termination. The transport test asserts a
  `hello`/`welcome` round-trip, a second `hello` for the same session returning
  `busy`, and dispose removing the socket and registry files.
- Forwarder transport, already-running `dsh web`:
  `hc run --bg --name w1 --cwd /repo dsh-sup` creates a session →
  `hc get w1` shows `reported: true`, `status.state == "idle"`,
  `status.app == "dsh"`, `turn: 0`; the session appears in the browser list;
  one `hc send w1 "say hi"` then `hc wait w1` yields `turn: 1` and a
  `done`/`idle` word; `hc read w1` shows the echo lines.
- Attach and list: `dsh-sup attach <id>` in a second terminal attaches the same
  session (or exits 3 while the first bridge holds it); `dsh-sup list` prints
  both sessions with their `live`/`bridged` state and creates nothing.
- Backend loss: kill the `dsh web` process → `hc get w1` shows
  `state: error` with `msg=backend offline` before the forwarder exits 1.
- Inactive transport: a plain `dsh web` with neither `HC_TERMINAL_ID` nor a
  connected forwarder writes no OSC 7501 at all. Assert by running it with
  stdout/stderr redirected to a file and grepping for `\x1b]7501` — zero
  matches — and confirm the browser GUI still shows its own status handling.

### 5.1 Deferred: in-process transport

The `dsh web`-inside-hc shape writes OSC to `/dev/tty` itself. It is the same
`Transport` interface with no socket, so it is added after P2 if a dedicated
worker is wanted, and it reuses every other module unchanged. Its acceptance
(`hc run --bg --name t0 dsh web --port 0 --no-open`) is not part of P0.

## 6. Task P1 — stdin input channel

**In scope:** `src/stdin.ts`, `src/index.ts`, `src/client/**`, `src/stdin.test.ts`.

Enabling rule: the component mounts only when the activation gate holds (§2:
`config.enabled !== false` and either `HC_TERMINAL_ID` is set or a forwarder is
connected); within that, `DSH_STDIN_PROMPT=0` disables it, otherwise it is
enabled (web reads no stdin). On EOF stop reading and keep the process alive.

Grammar (machine-typable; a human attached with `hc attach` types the same):

| Input | Effect |
|---|---|
| plain text | `agent.steer(createUserMessage({ content: [{type:'text',text}], source: {kind:'user'} }))` on the attached session |
| `/cancel` | `agent.cancel({ kind: 'user' })` — exact cause per `AgentCancelCause` |
| `/status` | echo one line: attached session, state, turn, pending ask ids |
| `/new [cwd]` | create a fresh session via `ctx.agents.create()` and attach it; `cwd` defaults to the current session's |
| `/attach <id>` | attach an existing live session |
| `/approve <ask-id>`, `/reject <ask-id>` | settle that parked approval (P2) |

Framing: accept `\n` and `\r`; do not enable DECSET 2004 (hc then sends raw
text, measured); strip a bracketed-paste wrapper if it ever arrives.

Child records: every live session that is not attached gets one record
`id=<sessionId>` whose state mirrors that session's last turn word, refreshed on
its `turn/start`/`turn/end` and removed with `state=clear:id=<sessionId>` on
disposal. Emit child records only after the root `idle`: a child report alone
sets `reported`, and hc would then type before the input surface is ready.

Browser half: `src/routes.ts` registers `GET /dsh-supervision/state` and
`POST /dsh-supervision/reclaim` on `ctx.webserver` (handler form so POST is
allowed; the `resource` form is GET/HEAD only). `src/client/index.ts` declares
`inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale']`, polls the
state route every 2 s, and registers a session-scoped banner slot above the
composer with the terminal name, pid and the reclaim action. `package.json`
gains the `dsh.client` roster entry, `exports["./client"]`, and `bin` for
`dsh-sup`. Reclaim sends `bye/reclaimed`, closes the socket, and resolves every
parked ask in that tree `cancelled`.

**Acceptance (P1):**

- `src/stdin.test.ts` asserts `\r`/`\n` framing, wrapper stripping, and command
  parsing.
- Under a live hc core, with a 20 s tool running in turn 1:
  `hc send t0 "ignore that, answer BETA"` then `hc get t0` shows no new turn
  before the tool returns; the session log shows a second `step/start` inside
  turn 1 (`04-design-lite-tty.md` §9 is the exact assertion).
- `hc send t0 "/cancel"` ends the turn with `aborted`; `hc get t0` returns to
  `idle` within the wait window.
- Under a live hc core (so `HC_TERMINAL_ID` is injected):
  `hc run --bg --name t1 --cwd /repo sh -c 'cat prompt.txt | dsh web --patch ./overlay.yml'`
  starts exactly one turn and survives the pipe closing (settles research U1).
- Inactive transport: piping the same text into a plain `dsh web` with neither
  `HC_TERMINAL_ID` nor a connected forwarder creates no turn — the plugin never
  mounts, so nothing reads stdin. This is the P1 regression guard for the
  activation gate.
- Two sessions in one process: `hc get t0` lists the attached session as the
  root status and the other under `records`; the child's turn changes never
  move the root `turn` or end `hc wait`; `state=clear:id=…` removes it.
- An in-process `spawn` subagent: while the parent is `idle`, `hc get t0` shows
  a `records` entry `sub/<id>` in `working`, and clears it when the child
  settles; `hc wait t0` is unaffected by the child.
- Two concurrent workers (`hc run --bg --name dsh-1 …`, `dsh-2 …`):
  `hc wait --children any` reports both, and each worker's `turn` is its own.
- Takeover banner: with a bridge connected, the browser session view shows
  `Supervised from terminal <name> (pid <n>) · [Take back control]` within one
  poll; `GET /dsh-supervision/state` returns that session with `bridged: true`.
- Reclaim: clicking the action POSTs `/dsh-supervision/reclaim`; the forwarder
  exits 0 (`hc get` shows a finished terminal), the banner disappears within one
  poll, and a subsequent gated tool renders the normal browser approval card.
- No banner without a bridge: `GET /dsh-supervision/state` returns an empty
  session map and the session view renders unchanged.

## 7. Task P2 — approval bridge

**In scope:** `src/approval.ts`, `src/stdin.ts`, `src/index.ts`.

Steps:

1. Register with `ctx.on('approval/request', handler, { prepend: true })` and
   claim **only** asks whose agent belongs to the bridged tree:
   `ctx.get('subagents')?.rootOf(req.agent).session.header.id === bridgedSessionId`.
   That covers the supervised session itself and every `spawn`/`fork` subagent
   beneath it, while a `rootOf` throw (agent outside any tree) and every other
   session delegate with `next()`. Claiming more is a defect, not a shortcut: a
   second session in the same process that a person is using would lose its
   browser approval card, violating the takeover-visibility rule.
2. On claim: force the root to
   `blocked:kind=permission:msg=<toolName + reason + source session>`, restating
   `app`, **regardless of the attached session's own word**. Root `blocked`
   means "the supervised session has an undecided approval"; it returns to the
   attached session's real word only when the last parked ask **in that tree**
   settles. Unrelated parked asks never move this root. Park the request and
   resolve `cancelled` if the asker's `req.signal` aborts.
3. Decision sources, supervisor first: `hc send --force <t> "/approve <id>"`
   → `allowed-once`, `"/reject <id>"` → `rejected`. The ask id is the
   `ApprovalRequestId` suffix, unique process-wide, so one supervisor command
   settles a subagent's ask without any routing — echoed in the blocked `msg`
   and in `/status`. Bare `/y` `/n` settle the single pending ask and are
   rejected when more than one is parked. A human attached with `hc attach`
   types the same commands. `hc send` without `--force` fails with exit 9 while
   blocked — that refusal is the human gate, not a transport error, and
   `--force` is the audited supervisor escalation.
4. On settle: recompute the root from the parked asks **in the supervised tree**
   and the attached session's real state (`blocked` if one remains, else
   `working`/`idle`), so the record never sticks; pair every `approval/asked`
   with its `approval/decided` (watchdog re-emits if the decision is missing
   within `approvalTimeoutMs`, default disabled). Echo one line naming the ask
   id, outcome and source (`supervisor` vs `attached`) so the decision is
   auditable from `hc read`.
5. Fail closed: EOF, teardown, or timeout → `cancelled`.

**Precondition (owner decision):** the profile policy must be `ask`. Either set
`permission.defaultPreset: workspace-write` in the profile, or launch with
`DSH_PERMISSION_MODE=workspace-write`. Do not edit the owner's profile in this
plan; P2 runs under an explicit `--patch`/env override.

**Acceptance (P2):**

- Under a live hc core with a browser connected: triggering a gated command
  yields `hc get` `state: blocked`, `kind: permission`, and a `msg` carrying the
  ask id; `hc send t0 "/reject <id>"` exits 9 without `--force`;
  `hc send --force t0 "/reject <id>"` rejects, `"/approve <id>"` allows once,
  and the turn completes. This settles research U3 with the stronger `prepend`
  argument.
- Two parked asks: a bare `/y` is refused, `/approve <id>` settles exactly the
  named one, and both settle without leaving a `blocked` record.
- `/reject <id>` ends the turn through the tool's rejection path.
- `hc read t0` shows one audit line per decision with ask id, outcome and
  source.
- Parent session `idle` while a `spawn` subagent raises an ask: the root flips
  to `blocked` (msg names the source session and the child record
  `sub/<id>` is also `blocked`), `hc send t0 "/approve <id>"` without `--force`
  exits 9, `hc send --force t0 "/approve <id>"` settles it, the root returns to
  `idle`, and the subagent continues. Without this, a supervisor that never
  polls `hc get` cannot learn a subagent is waiting, and the ask fails closed as
  `unavailable`.
- Inactive transport: the same gated command in a plain `dsh web` with neither
  `HC_TERMINAL_ID` nor a connected forwarder is still answered by the browser
  answerer, and no listener is registered — assert the GUI card appears and the
  turn completes from the browser. This is the regression guard for the
  activation gate.
- Supervision isolation in one process: session A is bridged, session B is used
  by a person in the browser. A gated command in B shows its normal GUI card,
  B's ask never reaches the forwarder, and A's root word does not change. This
  is the regression guard for the tree-scoped claim rule.

## 8. Verification and boundaries

- TypeScript conventions: strict + `noUncheckedIndexedAccess` with no `any`,
  no `as unknown as`, no non-null assertions on values that may be absent;
  type-only imports; `readonly` data; string-literal unions instead of enums;
  explicit return types plus a one-line JSDoc on every export; boundary
  validation (socket frames and registry JSON are `unknown` until a type guard
  proves them); pure modules (encoder, state reduction, arg parsing, registry
  selection, frame codec) separated from I/O and testable without sockets or
  timers; `Error` subclasses with stable `code` fields for programmer errors
  and discriminated results for expected outcomes; `node:test` +
  `assert/strict` with no shared mutable state and no sleep-based
  synchronisation.
- Unit checks: `pnpm test` at the root (plugin: `tsc` then `node --test
  lib/*.test.js`) and `pnpm --filter dsh-sup test` for `cli/`. No package-wide
  suite, no DSH vitest.
- Integration: the hc scenarios above, run in the control checkout, one worker
  per scenario. Record `hc get` JSON as evidence.
- Drift: re-read `src/index.ts` and `src/state.ts` before P1/P2; the plan was
  written against `c35eb18` for this repo and DSH `0.2.2-rc.1`.
- Security boundary: the socket directory is `0700` and the socket `0600`, so
  only the same OS user can connect — the same trust domain that can already
  read `~/.dsh`. No TCP listener exists. The reclaim route requires
  `Content-Type: application/json` so a cross-origin form post cannot reach it.
- Out of scope forever: `deepseek-harness` package source, `herdr-core` source,
  `~/.dsh/profiles/web/cordis.patch.yml` (unless the owner approves landing the
  rows), `dsh-tui` source (reference only).

**STOP conditions**

- `hc get` shows `reported: false` after the first `idle`: the forwarder's writer
  is not reaching a TTY, or the report is malformed. Stop; do not "fix" by
  retrying variants blindly — run `hc read` and the capability probe `ESC ] 7501 ; ?`.
- `hc get` shows `status: null` while DSH runs: the process left the foreground
  process group, or the report went to a pipe. Stop and inspect `process.stdout`
  / `/dev/tty` availability under hc.
- The web tree fails to boot with the overlay inserted: composition left a
  dangling row reference. Stop; `dsh web --patch ./overlay.yml --dump-config`
  first.
- `turn` does not advance after a completed turn: the state machine did not pass
  through `working`. Stop; a repeated word is not a turn.
- An approval is answered by the browser despite `prepend`: registration order
  or scope is wrong. Stop; do not add a second claim path.
- A unit test passes but the hc scenario fails: the protocol, not the logic, is
  wrong. Stop; treat the hc result as authoritative.

## 9. Alternative transport: external bridge

**Decided:** adopted as the primary transport. The design record is
`.agents/adr/proposed/architecture/2026-11-11-external-bridge-transport.md`;
this section keeps the evaluation and the constraints that shaped it.

A second shape keeps the plugin in an **already-running** `dsh web` and puts a
small forwarder in the hc PTY:

```
hc terminal (foreground)          dsh web (already running, port unchanged)
  dsh-sup ── unix socket ──▶ supervision plugin ──▶ agent / session
      │                                   │
      └─ writes OSC to /dev/tty           └─ steer / cancel / approvals
```

This is legitimate: hc only sees a program that reports OSC and reads stdin.
The forwarder is that program; it owns no agent. Implementation home in this
repository: `bin/dsh-sup.mjs` (the hc-PTY program) plus `src/transport.ts`
(the plugin side: socket server, peer check, framing).

Why it is not a second implementation: OSC encoding, state derivation and the
command grammar stay in the plugin. The forwarder writes the plugin's OSC bytes
verbatim to `/dev/tty` and forwards stdin lines back. P0's encoder and state
machine are shared by both shapes; only the transport module differs.

It buys three things A cannot:

1. No second `dsh web`, so no port juggling and no disabled web rows.
2. The supervised session is the one the owner is already using in the GUI.
3. N workers map to N bridges over one process with N sessions.

It costs a new local IPC surface and a split of process identity. These must be
fixed in the design before implementation:

| # | Decision | Proposed rule |
|---|---|---|
| 1 | IPC trust | Unix socket, mode `0600`, directory `0700`; same-user trust domain, **no token**. A token would not raise the boundary (the same user can read it) and would add rotation state. Document the socket as a new local injection path |
| 2 | Ownership | One bridge per session; a second attach is refused with a reason. Many workers = many sessions |
| 3 | Activation | The gate becomes `HC_TERMINAL_ID set || a forwarder is connected`; with neither, the plugin never registers an approval answerer, so a GUI-only run is untouched |
| 4 | Backend loss | Socket EOF → bridge emits `error:msg=backend offline` and exits. Never leave a stale `idle` |
| 5 | `hc kill` | Kills the forwarder only; the agent and session keep running. State this in the supervisor contract |
| 6 | Restart | A restarted `dsh web` requires a new bridge; the old one has already exited, so there is no double writer |

Comparison:

| | A: `dsh web` inside hc | B: external web + forwarder |
|---|---|---|
| New code | one plugin | plugin + ~200-line forwarder |
| Port | needs `--port 0` or disabled web rows | none |
| Reuses the owner's session | no | yes |
| New process | no | yes, with its own crash semantics |
| New attack surface | none | local socket |
| What `hc get` describes | the agent process | the forwarder |
| Multi-worker | N processes | N bridges over N sessions |

Recommendation: B is the primary transport, so P0 builds the encoder, the state
machine and the forwarder together — the protocol proof and the socket layer are
verified in one pass. A (in-process, no forwarder) becomes `P3`, an optional
second implementation of the same `Transport` interface; it is not a
prerequisite and must not be built first, because its tty writer would hide the
framing bugs the socket path needs to expose.

## 10. Decisions

Every item below is settled; nothing is left for the executor to choose.

| # | Decision | Settled rule |
|---|---|---|
| D1 | How the plugin is installed into the running web profile | Local link plus one inserted row in `~/.dsh/profiles/web/cordis.patch.yml`; a `--patch` overlay is only for pre-landing tests. Landing the row is an owner action, never a side effect of a test run |
| D2 | Approval policy source | Launch with `DSH_PERMISSION_MODE=workspace-write`; never edit the profile's `defaultPreset`, because that would change the owner's GUI behaviour |
| D3 | Supervisor answers approvals without a human | Yes — that is the point; decisions use `/approve <id>` / `/reject <id>` and are echoed with ask id, outcome and source |
| D4 | Multi-session child records | Yes for sessions in one process; concurrent workers still default to one process each |
| D5 | Emitter mounted in the plain `web` profile | Yes; that is what B is. It activates only with a forwarder or `HC_TERMINAL_ID`, so a GUI-only run is unchanged |
| D6 | Transport | B (external web + `dsh-sup` forwarder) is primary; A (in-process) is P3, optional, sharing the same modules — ADR `2026-11-11-external-bridge-transport.md` |
| D7 | IPC trust | Unix socket `0600` in a `0700` directory, same-user trust domain, no token |
