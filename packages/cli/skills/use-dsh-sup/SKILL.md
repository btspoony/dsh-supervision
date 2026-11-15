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
message, every assistant reply (with a `⟦↑in ↓out⟧` usage line when the adapter
reported token usage) and every tool call appears as its own block — no colour, no
markdown, no spinner. An attach replays the last 200 items of the session's
persisted log as ordinary `mirror` frames, and an `echo` line says so when that
replay was truncated (`history: showing last 200 items`) or the log could not be
read.

When stdin and stdout are both terminals, an attach opens a full-screen surface:
a scrollable transcript of those blocks, a multi-line editor for the next
operator line, and a status line with the session id, state and turn. The turn
appears only while the plugin's `echo` config is on — with echo off no frame after
`welcome` carries a count, so the bar follows OSC records and omits it. Everything
forwarded stays in the transcript, so scrolling back reaches the whole attach. The
surface takes over the alternate screen; terminal scrollback is not written, and
the last frame returns to the normal screen on exit.

The surface is themed so input and output are distinguishable: the operator's line
is a tinted `❯` block, assistant prose renders as Markdown (headings, lists,
inline code, bordered fences), tool calls are coloured status rows with a dim
detail line, system/echo lines are dim, the status bar is a reverse-video row, and
the editor is framed in the accent colour. `NO_COLOR`, a non-terminal stdout or
`TERM=dumb` keeps the layout and drops the colour.

| Key | Effect |
|---|---|
| `Enter` | send the editor's text as one operator line |
| `Shift+Enter` | newline in the editor, when the terminal reports the modifier (modifyOtherKeys or Kitty keyboard protocol); otherwise it submits like `Enter` |
| `Ctrl+C` | clear what you typed; on an empty editor a second press within 1.5 s leaves the attach |
| `Esc` | close the completion menu if one is open; otherwise send `/cancel` (ends the running turn, keeps the attach) |
| `Ctrl+D` | leave the attach and restore the terminal |
| `PageUp` / `PageDown` | scroll the transcript one page |
| `↑` / `↓` | scroll one line, while the editor is empty |
| `Home` / `End` | oldest line / back to the newest (when the editor is empty) |

Typing `/` opens the suggestion menu the plugin's `catalog` frame feeds: the
session's skills appear as `/skill:<name>` (fuzzy-matching the bare name works),
and the forwarder's own exits close the list. That is the whole menu — a host
slash command such as `/compact` is not offered and would answer
`unknown command /<verb>` if typed, because the bridge cannot execute one; host
commands belong to the web input box. Tab inserts the highlighted completion,
while Enter accepts and sends it immediately. Accepting `/skill:<name>` or typing
it by hand is forwarded like any other line, and the plugin injects that skill's
body. The catalog frame never reaches stdout or `/dev/tty`; `--no-tui` ignores
it. `@file` completion resolves against the session's directory when `fd` is
installed.

`/q`, `/quit`, `/exit` and `/bye` leave the attach from either surface: the
forwarder sends `bye`, restores the screen and exits 0, and the line never reaches
the session. They also sit at the end of the `/` menu as `leave dsh-sup (local)`,
so the menu shows a way out even with no host vocabulary. In the TUI, `Ctrl+D` also leaves, `Esc` closes an open completion
menu first and otherwise sends `/cancel`, and Ctrl+C clears the editor (twice on
an empty editor within 1.5 s leaves; any other key resets that window). Trailing
spaces are ignored, so accepting the menu entry and pressing Enter still leaves.

Windows terminals (ConPTY) and tmux are unverified: no run has exercised this
surface there. When you do, check the alternate screen is restored on every exit
path (`Ctrl+D`, `/q`, a lost backend), that the terminal reports a keyboard
protocol the surface understands (modifyOtherKeys or Kitty, which decide
`Shift+Enter`), and that the pane has a `/dev/tty` the bridge can open — without
one only the socket surface mounts, and the reason lands on stderr.

Scrolled back, the last row shows `↓ N new` for entries that arrived meanwhile;
reaching the bottom resumes following. `--no-tui`, or a redirected stdout, keeps
the append-only line surface: in line mode those blocks go to stdout only when
stdout is a TTY, so a piped or redirected run keeps its stdout machine-clean. The
line surface itself is untouched — no raw mode, no alternate screen, line at a
time after Enter — and the plugin's in-process tty transport (`DSH_SUP_TERMINAL_ID`
or `HC_TERMINAL_ID`) always stays on it, because the full-screen surface belongs
to `dsh-sup` alone.

The machine records are unchanged: OSC 7501 still goes to `/dev/tty`, and the
`echo` lines — `[turn <n>] <state>`, `[ask <id>] <tool> parked (<session>)`,
`[ask <id>] <tool> → <outcome> (source=supervisor|attached)`, the `/status` answer
`session=<id> state=<state> turn=<n> asks=<ids>` (`-` when nothing is parked),
`refused: <n> approval(s) parked`, `new failed: …`, `attach failed: …`,
`unknown command /<verb>` — reach exactly one place each: stdout in line mode when
you have a TTY, the transcript viewport in a full-screen attach, `/dev/tty`
otherwise.

The root word covers more than the session's own turn: while a descendant
subagent is `running`, or a background job owned by the session is `running` or
`stopping`, the root reports `working` and its `msg` carries the count
(`2 subagents · 1 job`). If that activity's identity (a family's status, label or
membership) does not change for 5 minutes, the root falls back to the turn word —
`msg` then reads `activity stale: …` — and one `activity stale: …` echo line
explains it.

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
| `--no-tui` | every command | Keep the append-only line surface even when stdin and stdout are terminals. A redirected stdout always uses it. |

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
