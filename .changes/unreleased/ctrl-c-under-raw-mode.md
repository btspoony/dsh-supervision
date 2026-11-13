---
category: Fixed
---
- A tty bridge puts the terminal in raw mode, which disables the terminal's Ctrl+C signal; the plugin now restores the terminal and delivers SIGINT to `dsh web` instead of swallowing the byte, so the process still stops normally from its own terminal.
