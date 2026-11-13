---
category: Added
---
- Attached in a terminal, `dsh-sup` now shows the conversation it is supervising. A new `mirror` frame carries each operator message, each assistant reply (with a `⟦↑in ↓out⟧` usage line when the adapter reported token usage), and each tool call; the forwarder writes it as append-only lines — no colour, no markdown, no spinner, no rewritten line, and nothing from before the attach replayed. The transcript goes to stdout, and only when stdout is a TTY.
- OSC 7501 records keep going to `/dev/tty`, so the machine surface is unchanged; `echo` lines now reach exactly one sink — stdout when the operator has a TTY, `/dev/tty` otherwise — so status and approval lines appear in an interactive attach without a real supervisor losing them.
- `PROTO` is now `2`. The plugin and `dsh-sup` ship as one version pair, so an old forwarder and a new plugin refuse each other instead of half-working.
- Input handling is untouched: line mode, no raw mode, no alternate screen.
