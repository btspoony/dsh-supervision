---
category: Added
---
- `dsh-sup attach` now replays the session's existing conversation before live items arrive: the plugin reads the persisted log through `ctx.sessionQuery.readSession`, maps the most recent 200 human-facing items (`history: showing last 200 items` when it truncated) and buffers live events across the read so nothing is lost or duplicated. A host without the reader, a locked log, or a read over the 4 s deadline still attaches and says `history unavailable: …`.
- The forwarder runs a full-screen pi-tui surface when both stdin and stdout are terminals: a scrollable transcript (PageUp/PageDown, arrows/Home/End when the editor is empty, `↓ N new` while scrolled up), a multi-line editor (Enter submits, Shift+Enter newlines where the terminal supports it), a status line with session/state/turn, Ctrl+C → `/cancel`, and Ctrl+D to exit. `--no-tui`, a redirected stdout, or a non-terminal stdin keep the append-only line surface exactly as before, and the in-process tty transport stays in the terminal's own line mode.
- The TUI is built on the maintained `@earendil-works/pi-tui` package.
