---
category: Added
---
- The full-screen surface answers an agent's question with a keyboard picker instead of a hand-typed `/answer` line: `↑`/`↓` (or `j`/`k`) move, `Enter` picks, `1`–`9` select directly, `Space` toggles a multi-select option, `Esc` skips the whole ask, and an `Other (type your own)` row hands the line back to the editor for free text.
- The picker answers every question of one ask and emits a single existing-format `/answer <ask> <qid>=<value>` line, so protocol frames, the plugin and `--no-tui`/non-TTY line mode are unchanged; a second ask, a `closed` frame or `/cancel` keeps or clears that ask's progress, long option lists window to the terminal height with a `… N more` marker, and typed text the grammar would read as a pick or carry an assignment token is refused with a hint instead of being silently mis-answered.
