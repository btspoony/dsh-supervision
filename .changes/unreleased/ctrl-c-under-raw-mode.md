---
category: Fixed
---
- The bridge no longer puts the terminal into raw mode. Raw mode disabled the driver's ISIG, ECHO, IXON and line editing, so Ctrl+C, Ctrl+Z, Ctrl+\\, Ctrl+S/Q and input echo stopped working while a session was bound; the plugin now reads stdin in the terminal's own line mode and leaves every control key to the driver. Operator input is still read a line at a time.
- Records reach the terminal through a non-blocking stream, so a paused terminal (Ctrl+S) holds them in an ordered queue instead of blocking the host's event loop.
