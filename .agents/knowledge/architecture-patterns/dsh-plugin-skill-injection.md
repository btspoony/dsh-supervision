---
module: dsh-plugin-skill-injection
date: 2026-11-14
problem_type: architecture_pattern
category: architecture-patterns
plan_id: dsh-supervision-use-skill
tags:
  - skills
  - plugin
  - cordis
  - cli
  - packaging
related_components:
  - dsh-supervision-plugin
  - dsh-sup
  - dsh-web-host
applies_when:
  - adding an agent skill to an existing DSH plugin
  - coupling a plugin to a same-version companion CLI
---

# DSH plugin skill injection: teach the agent the coupling from inside the plugin

## What this pattern solves

An agent working in DSH must learn, without reading the plugin's repo, that the
plugin needs a companion CLI of the **same exact version**, how to verify that,
and that installing it needs the user's authorization. The plugin teaches this
by shipping a skill; the CLI teaches its own full manual — neither hard-depends
on host services, neither duplicates the other's text.

## Shape

- DSH exposes one skill registry, `ctx.skills`, with `registerProvider(create)`
  returning a dispose callback. The plugin registers an in-process provider:
  one provider named after the plugin, one candidate per skill file.
- The candidate carries `source: 'bundled'`, `provider` (the plugin name), `rank: 600`
  (the bundled-provider rank from `@deepseek-ai/dsh-skill`, mirrored as a constant
  because the package takes no DSH runtime dependency), and `resourceBase`
  pointing at the skill directory so relative links in the body resolve.
- The packaged Markdown is the file-level SSOT: `list()` takes the `description`
  from the file's frontmatter (the same line the catalog shows); `get()` reads
  the file, strips the frontmatter, and renders `{{version}}` from the package
  manifest — the plugin version, which is also the required CLI version, so the
  printed text never goes stale after release.
- Paths resolve relative to the built module (`new URL('../skills/...', import.meta.url)`),
  i.e. the package root from `lib/index.js`; the skill directory must be in
  `package.json` `files` or the published package ships a broken provider.
- Mount is reflective and effect-scoped: `ctx.get?.('skills')` is read structurally
  (not through `inject`) so a host without the registry still loads the plugin,
  and registration runs inside `ctx.effect` so disposal unregisters the provider.
- The companion CLI self-describes instead of documenting: `--version` prints the
  manifest version and `--skill` prints the packaged CLI manual, frontmatter
  stripped and `{{version}}` filled; both are answered before the backend registry
  lookup, so they work with no live `dsh web`. The plugin skill names the coupling
  and points at `dsh-sup --skill` for the grammar, exit codes and environment
  variables.

## Why not a separate skill package

The official `dsh-experimental-badge-skill-bundle` → `@deepseek-ai/dsh-skill-badge`
split is right when the skill has its own release cadence. A plugin that already
ships a bundle patch through its own `cordis.patch.yml` does not need a second
package for one Markdown file; registering the provider in-process avoids a
versioned dependency between two packages released together anyway.

## Limits and pitfalls

- **Mount timing.** If `ctx.get('skills')` is absent at apply time, the skill
  is silently missing while the plugin keeps working. That skip is deliberate,
  but it means skill absence surfaces only as "the catalog doesn't list it" —
  there is no log line.
- **Host candidate validation runs outside the per-provider try/catch.** A
  candidate the host's validator rejects takes every skill in the process down,
  so `list()` must never emit a candidate without a description: an
  unparseable manual is simply not a candidate.
- **The installer stays user-authorized.** The skill body instructs the agent to
  tell the user what `dsh-sup --version` showed, ask permission, and only then
  run `npm i -g dsh-sup@<version>`. The plugin never probes, installs or
  upgrades the CLI itself; the host's approval prompt remains the gate.

## Applies when

Adding an agent skill to an existing DSH Cordis plugin, or coupling a plugin to
a companion CLI that ships in the same release (exact-version match, no
protocol negotiation).