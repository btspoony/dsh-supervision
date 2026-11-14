---
module: supervision-terminal-surface
date: 2026-11-14
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: dsh-supervision-terminal-tui
tags:
  - tui
  - history-replay
  - raw-mode
  - alternate-screen
  - session-log
related_components:
  - dsh-sup
  - dsh-supervision-plugin
applies_when:
  - a terminal attach needs history the live projection never saw
  - a forwarder is allowed to own the terminal (raw mode, alternate screen)
  - a log read races the live event feed
---

# Browsable terminal surface: replay the log, own the screen carefully

## What this pattern solves

A supervision bridge is a live projection: it starts at attach, so the operator
cannot see what the session already said, and an append-only line surface offers
no scroll, no edit and no status. Two changes fix both without touching the wire:

1. **Replay the session log as ordinary transcript frames.** The host exposes
   `ctx.sessionQuery.readSession(id)` → `{ events }`; `mirrorOf` already maps one
   event to one `MirrorItem`, so replay is mapping, not a second projection. Cap
   it (`HISTORY_ITEMS = 200`) and say when items were skipped.
2. **Let the forwarder own its own terminal.** `dsh-sup` runs in the supervisor's
   PTY, so it may take raw mode and the alternate screen; the in-process tty
   transport must not (it would steal the host terminal's Ctrl+C and screen).

## The race that makes replay hard

Opening the subscription after reading the log loses any event appended in
between; reading before opening it means live events can overtake the replay. The
stable shape is **open first, arm a replay window, then read**:

- live transcript items are buffered as *raw events* while the window is armed;
- after the read, send the replay, then flush buffered events whose host-stamped
  `seq` is greater than the snapshot's last seq, then disarm;
- buffer raw events, not mapped items: mapping at arrival loses a tool result
  whose call is still inside the snapshot and has not entered the call table;
- race the read against a deadline inside the handshake budget and degrade to
  `history unavailable: …` — an attach must never depend on the log;
- disarm on the single-owner refusal path too, or a closed bridge keeps buffering.

## Owning the screen

- Use the terminal library's alternate-screen class (`@earendil-works/pi-tui`
  `TuiAltScreen`), not the inline one, when the transcript is meant to scroll
  inside the viewport. Release keys the alt-screen class claims but the transcript
  needs (`pageUp`/`pageDown`).
- Filter **key releases**: Kitty-protocol terminals report press and release, and
  `matchesKey` cannot tell them apart, so PageUp/PageDown scroll twice and Ctrl+C
  can send two `/cancel`s. Guard with `isKeyRelease` before mapping actions.
- Restore on *every* exit path: `exit`, `SIGTERM`, `SIGHUP`, `uncaughtException`,
  and `SIGINT` (restore, then re-raise so the process still exits 130). In raw
  mode Ctrl+C is a byte, not a signal — the signal handler is only for an external
  kill.
- Clamp layout width to `Math.max(1, columns)`; a floor like 20 renders wider than
  a narrow pane and breaks the row accounting the library relies on.
- Keep a line-mode fallback byte-identical (`--no-tui`, redirected stdout or
  non-terminal stdin) and keep OSC 7501 on `/dev/tty`.
- State shown in the TUI must not depend on the prose `echo` config: derive state
  from the OSC root record. The OSC record has no turn, so a turn display freezes
  when echo is off — that is a known residual until the record carries `turn=`.

## When it does not apply

- The forwarder does not own its PTY (it is one surface of a larger host):
  raw mode/alt screen are off-limits; only replay applies.
- The supervisor already renders its own transcript from the OSC records: a second
  surface would fight it for the screen.

## Related

- `.agents/knowledge/architecture-patterns/human-output-surface.md` — the
  append-only line contract this surface deliberately replaces for `dsh-sup`.
