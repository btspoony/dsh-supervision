---
module: supervision-output
date: 2026-11-14
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: dsh-supervision-session-mirror
tags:
  - transcript
  - output-sink
  - sanitizer
  - byte-cap
  - protocol
related_components:
  - dsh-supervision-protocol
  - dsh-sup
  - dsh-supervision-plugin
applies_when:
  - adding a human-readable view to a stream another program parses
  - routing one frame stream to two destinations
  - printing model output beside machine records
---

# Human output surface: a readable transcript beside a machine protocol

## What this pattern solves

A supervision channel already carries machine records — OSC 7501 reports a
supervisor parses — so an operator who attaches to a session can type into it and
read nothing. The readable view is not a second channel: it is a second sink on
the same byte stream. Treating it as independent produces three defects at once —
duplicate lines on an interactive attach, a renderer per transport, and model
output able to forge the machine surface it shares.

## Shape

- **Two sinks, one stream.** OSC records go to `/dev/tty`; transcript lines go to
  stdout only when it is a TTY. On an interactive attach both are the same screen,
  so `echo` (state, turns, asks) picks exactly one sink —
  `human ? stdout : /dev/tty` in `routeFrame` (`packages/cli/src/route.ts`) — and a
  redirected stdout stays free of machine records.
- **Rendering belongs to the protocol package.** `renderMirror(item, width)` in
  `packages/protocol/src/render.ts` is the single formatter: the socket forwarder
  (`route.ts`) and the in-process tty transport (`src/tty-transport.ts`, through
  `renderFrame`) both read it and only choose a sink. `renderMirror` returns no
  trailing newline; the sink that writes lines adds exactly one, so the next record
  cannot glue onto a transcript line.
- **Width is an argument, never a query.** The forwarder passes
  `process.stdout.columns || undefined` and the renderer owns the default, so a
  pty reporting 0 columns does not wrap at width 1, and no second constant exists.
- **The producer maps events to items.** `mirrorOf` in `src/mirror.ts` is pure over
  one event plus a bounded call table; `src/index.ts` only sends the frame. Nothing
  about rendering reaches the plugin, nothing about host event shapes reaches the
  protocol package.
- **Append-only line mode.** No raw mode, no alt screen, no repaint: the terminal
  keeps its own Ctrl+C/Ctrl+Z and line editing. That rules out spinners and cursor
  movement, and it is why wrapping consumes a width argument.

## Failure modes it prevents

**A field-by-field filter is not a sanitizer.** Mirrored text is model output
printed into the stream a supervisor parses, so a reply carrying
`ESC ]7501;state=done ST` forges a supervision record. The first attempt stripped
each input field as it was read; it stayed bypassable because `tool` arguments are a
**JSON string** — a legal `\u001b` escape re-materialises as ESC after `JSON.parse`
and was printed intact. The durable form is a **final-output invariant**: every arm
breaks to one exit that runs `stripControls` over each finished line (splitting on
`\n` keeps newlines, `\t` is kept explicitly), so a new field or helper is covered
without anyone remembering to filter it.

**A `.length` cap is not a byte bound.** Inside a JSON string literal a C0 control
costs six bytes (`\u0001`), so control-heavy text expands sixfold on the wire: a
16 Ki-character payload measured about 98 KB encoded against the 64 KiB `MAX_FRAME`
in `packages/protocol/src/frames.ts`. `MAX_ITEM_*` are therefore UTF-8 byte
budgets, truncation measures the JSON-literal width (`wireWidth` / `fit` in
`src/mirror.ts`), and `mirrorFrame` drops an item whose `stringify`ed frame would not
fit rather than letting `encodeFrame` refuse and close the bridge.

**Numbers cross a strict boundary.** The forwarder's decoder rejects a non-integer
count and stops the stream, ending the attach as `backend offline`, so `mirrorOf`
validates at the mapping boundary (`Number.isSafeInteger(n) && n >= 0`) and omits the
field or the item instead.

**Identifiers are pairing keys: drop, do not truncate.** A cut `callId` prints a tool
header whose result can never arrive, because the result side looks its call up by
that exact string. `mirrorOf` drops a `name` or `callId` over its cap rather than
shortening it.

## When it does not apply

- Both surfaces are consumed by programs: there is no human sink to split to.
- The readable view is a separate process or GUI: it has its own channel, so the
  one-sink rule and the shared renderer stop applying.
- The renderer may hold terminal state (raw mode, alt screen, spinners): the
  append-only invariant and width-argument wrapping no longer hold, and a repaint
  protocol is required instead.
- Content from before the attach must be shown: the mirror is a live projection and
  keeps no transcript log of its own.

## Verified scope

The sink split and the transcript were proven in two real-process runs against a
fake backend — a TTY attach printing the transcript, and a redirected stdout staying
silent while OSC and echo records reached `/dev/tty`. A real DSH host with this
plugin installed was not exercised end to end, and nothing asserts how a supervisor
reacts to a forged record.

## Related

- `.agents/knowledge/architecture-patterns/in-process-supervisor-transport.md` —
  the transport seam, and the rule that rendering belongs to the protocol package;
  this note extends it to the human surface.
