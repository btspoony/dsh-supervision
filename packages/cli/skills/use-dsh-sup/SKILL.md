---
name: use-dsh-sup
description: Run the dsh-sup forwarder CLI to bridge a DSH session into a terminal supervisor — commands, options, exit codes, environment variables, and the exact version it must match the dsh-supervision plugin. Load before running dsh-sup.
---

# dsh-sup

`dsh-sup` is the forwarder that connects one live `dsh web` session to the
terminal supervisor you are running in: the supervisor reads the OSC 7501
records the forwarder writes to its PTY, and writes operator lines back into the
session. This build is version {{version}}.

## Version coupling

The `dsh-supervision` plugin and this CLI are released together and must be the
**same exact version**. There is no protocol negotiation, so a mismatch fails in
confusing ways; do not accept a nearby version.

```sh
dsh-sup --version        # prints {{version}}
```

If that prints a different version, or `dsh-sup` is not on `PATH`, stop and tell
the user. Installing or upgrading is the user's decision: ask first, and run the
install only with permission.

```sh
npm i -g dsh-sup@{{version}}
```

## Create, attach, list

```sh
dsh-sup                             # create a session in the dsh web process's directory
dsh-sup new --cwd ~/work/project    # same, elsewhere; resolved here and sent absolute
dsh-sup attach session-abc123       # attach an existing session
dsh-sup session-abc123              # the same, as a bare session id
dsh-sup list                        # list sessions on every live backend; binds nothing
```

`new` is the explicit spelling of the bare form, and a bare word starting with
`session-` is an attach. A session has exactly one bridge: a second attach is
refused with `busy`. Once bridged, lines you type go into the session, and the
GUI shows a supervision banner with **Take back control**.

The bridge also forwards the conversation into your terminal: every operator
message, every assistant reply (with its `⟦↑in ↓out⟧` usage line) and every tool
call prints as its own append-only block — no colour, no markdown, no spinner, no
rewritten line, and nothing from before the attach replayed. Those lines go to
stdout, and only when stdout is a TTY, so a piped or redirected run keeps its
stdout machine-clean. The machine records are unchanged: OSC 7501 still goes to
`/dev/tty`, and each `echo` line (`[turn <n>] <state>`, `[ask <id>] …`) goes to
exactly one sink — stdout when you have a TTY, `/dev/tty` otherwise. Input
handling is untouched: line mode, no raw mode, no alternate screen.

```text
❯ implement the mirror
· One assistant/message per step; no deltas to stream.
⟦↑1,234 ↓340 R900⟧
✔ bash: List the protocol package ⟦12ms⟧
  └─ packages/protocol/src
[turn 4] working
```

`list` prints one table per live backend and filters nothing by default.

## Options

| Option | Applies to | Effect |
|---|---|---|
| `--cwd <path>` | `new`, `list` | Working directory for the new session, or the filter for `list`; resolved against the caller's directory, sent absolute. Refused by `attach`. |
| `--pid <n>` | every command | Pick the backend when several `dsh web` processes run. Without it a bridge needs exactly one live backend, and the refusal names each candidate. |

Backends are discovered through `$DSH_HOME/supervision`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | clean `bye` |
| 1 | backend lost |
| 2 | usage error, or no live backend |
| 3 | `busy` — the session is already bridged |
| 4 | `locked` — refused while an approval is parked |
| 5 | `create-failed` |
| 6 | `protocol` — a frame this process refused, so the backend is still alive |

## Environment variables

| Variable | Read by | Effect |
|---|---|---|
| `DSH_HOME` | this CLI and the plugin | Base of the socket and registry directory; defaults to `~/.dsh`. |
| `DSH_SUP_TERMINAL_ID` | the plugin | Non-empty ⇒ an in-process tty transport is added, so the plugin also supervises the terminal `dsh web` runs in. |
| `DSH_SUP_TERMINAL_NAME` | the plugin | The supervisor label reported on the state route; defaults to `dsh-sup`. `HC_TERMINAL_ID` / `HC_TERMINAL_NAME` are read as herdr-core fallbacks. |

The package reads these variables and never writes them.

## This manual

```sh
dsh-sup --skill       # print this document, frontmatter stripped, version filled
dsh-sup --version     # print the version
```

Both flags need no live `dsh web`; every other form does.
