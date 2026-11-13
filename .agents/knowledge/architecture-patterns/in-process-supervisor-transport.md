---
module: supervision-transport
date: 2026-11-11
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: dsh-supervision-tty-transport
tags:
  - transport
  - tty
  - activation
  - approval
  - plugin
related_components:
  - dsh-supervision-protocol
  - dsh-sup
  - dsh-web-host
applies_when:
  - adding or changing a supervision transport
  - replacing a forwarder boundary
---

# In-process supervisor transport: one seam, two owners of the same protocol

## What this pattern solves

A supervision feature needs to report agent state to a terminal and accept
operator input, but there are two ways to reach that terminal: an external
forwarder over a Unix socket, and the supervised process itself running inside
the terminal. Both must speak the same protocol and honour the same safety rules
without duplicating either.

## Shape

- The transport seam is `Transport` with `start`, `send`, `reclaim`, `close`.
  `Bridge` (`session`, `claim`, `send`, `close`, optional `retryOnNoFactory`)
  and `TransportHandlers` (`hello`, `line`, `list`, `bye`) are the only shared
  vocabulary. The boot-only retry flag is the one optional member, so a tty
  first hello may wait for the agent factory while operator paths fail fast.
- `OutFrame` is the transport-independent wire shape. Rendering it to terminal
  bytes belongs to the protocol package, not to either transport, so a
  forwarder and an in-process transport write identical records.
- Selection is additive in the plugin entry: the socket transport always
  mounts, and an environment signal appends the in-process transport when the
  process owns a terminal. Both may mount for one process; the shared bridge
  table is what keeps one bridge per session across them.
- `reclaim` means the same thing on both paths — drop the binding, run `bye`,
  write the clear record, return ownership to the browser — and must never exit
  the host process. On the socket path the forwarder exits afterwards because
  that process only existed to be a bridge; the host keeps running either way.

## Rules that are easy to get wrong

- **A terminal write is a host-wide failure surface.** Writing synchronously on
  the event loop means a stopped pty stalls every session and every approval
  route, and an escaping `EIO`/`EBADF` kills the host. Treat a failed write as
  a dead bridge: fail it closed with the same teardown the socket path uses,
  and never let the exception reach a host emitter.
- **Check the read side, not only the write side.** A process can have a
  writable terminal and a redirected stdin; accepting that stdin hands the
  operator command channel (steer, attach, approve) to whatever wrote the pipe.
  Fail closed unless stdin is a terminal.
- **Keep the socket path's teardown discipline.** A handler throw must drop the
  binding and notify `bye` for the bound session, or per-session listeners and
  parked approvals leak.
- **Do not let a failure path leak the shell.** Teardown that runs under an
  exception needs `try/finally` around the resource close, and line feeds must
  append with a loop rather than a spread (a large paste otherwise raises a
  range error inside a stdin listener).

## When the activation rule must be stated precisely

The plugin mounts in two layers: a discovery layer that always opens the socket
and writes a registry entry, and an effect layer that mounts only when a bridge
exists. The in-process terminal is an additional surface on top of the socket,
not a replacement: a forwarder elsewhere can still discover and attach a
different session, while the terminal renders the one it holds.

## Trade-offs accepted

- The in-process write stays synchronous, with exception containment and a
  labelled shortcut for the blocking half. A bounded asynchronous sink would be
  the fix; unbounded buffering would trade a stall for unbounded memory.
- Real-terminal behaviour (record interleaving with host logs, a stopped
  terminal) is stated as unverified in the delivery plan rather than claimed.
- The bridge reads only complete lines, so it never needs raw mode; stealing
  ISIG, ECHO or IXON from the operator would be a regression, not a feature.

## Related decisions

- `.agents/adr/proposed/architecture/2026-11-11-external-bridge-transport.md`
  §§ Architecture, Activation, In-process transport, Lifecycle and failure.
