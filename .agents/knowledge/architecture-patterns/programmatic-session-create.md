---
module: supervision-session
date: 2026-11-12
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: dsh-supervision-session-parity
tags:
  - session
  - agent
  - preset
  - model
  - dsh-host
related_components:
  - dsh-agent
  - dsh-agent-presets
  - dsh-agent-default-model
applies_when:
  - creating an agent outside the GUI or headless entry points
  - a supervised session answers but cannot run a tool
---

# Programmatic session create: three things the GUI passes that you must pass

## What this pattern solves

`ctx.agents.create()` alone returns an agent that looks healthy — it binds,
reports `idle`, accepts a steer — and then fails on its first turn. Two failures
reproduce the same way, and neither is visible until a real model call runs:

1. `agent "<id>" has no provider/model: set AgentOptions.provider and
   AgentOptions.model or record a model selection` — the turn ends `error`.
2. The session's tool list holds host-level tools only (team, MCP, ralph): no
   `bash`, no `read`/`write`, so the agent narrates instead of acting.

## Shape

The GUI's `createAgent` composes three pieces; a plugin creating a session must
reproduce all three:

- `agentOptions` from `ctx.agentDefaultModel.currentSelection()` — provider,
  model, optional reasoning effort.
- `meta.agentPreset` from `(await ctx.agentPresets.resolve())\.id` — the
  profile default (a named preset otherwise narrows the composition).
- `setup(agentCtx)` calling `ctx.agentPresets.mount(agentCtx, id)` — the mount
  is what installs the preset's scoped tool rows. Without it the agent has no
  bash and no file tools.

Read all three reflectively (`ctx.get('agentDefaultModel')`,
`ctx.get('agentPresets')`): a host that omits them still creates a plain agent,
and no declared dependency keeps the plugin from loading there.

## Rules that are easy to get wrong

- **A created session is not a usable session.** Treat "first turn fails" as a
  missing create option, not a model or provider problem, until `agentOptions`
  and `setup` are both supplied.
- **Do not name a preset you did not resolve.** A hardcoded id, or a preset
  named without `mount`, silently changes or empties the tool set.
- **The first session can race the boot.** A profile that boots an agent loop
  late answers `no agent factory registered`; retry that one create, and only
  the one the process makes for itself, so operator commands still fail fast.

## Verified

Real `dsh web` (0.2.2-rc.1) under a PTY with `DSH_SUP_TERMINAL_ID`: a
`dsh-sup new` session answered `/status`, ran a bash tool call, parked an
escalation ask as `blocked:kind=permission`, accepted `/approve`, and finished
`done` with the file written.

## Related decisions

- `.agents/adr/proposed/architecture/2026-11-11-external-bridge-transport.md`
- `.agents/knowledge/architecture-patterns/in-process-supervisor-transport.md`
