---
name: use-dsh-supervision
description: Use when a DSH session runs the dsh-supervision plugin or needs terminal supervision through it — checks that the same-version dsh-sup forwarder CLI is installed and points at its full manual.
---

# use-dsh-supervision

This session runs the `dsh-supervision` plugin, version {{version}}. Terminal
supervision goes through the `dsh-sup` forwarder CLI, which must be the **same
exact version** as the plugin. A version mismatch is unsupported, and a
protocol mismatch is quieter than that: the plugin's registry entry is skipped
as not live, so the CLI reports `no running dsh web found`.

## Check the forwarder

```sh
dsh-sup --version
```

`--version` prints one line. If the command is missing, or that line with its
surrounding whitespace trimmed is anything other than `{{version}}`, tell the
user what you found. Installing or upgrading the CLI is the user's decision: ask
for permission, and only then run

```sh
npm i -g dsh-sup@{{version}}
```

## Full manual

```sh
dsh-sup --skill
```

prints the forwarder's complete manual — `new`, `attach <session-id>`,
`<session-id>`, `list`, `--cwd` / `--pid`, the exit codes and the environment
variables.
