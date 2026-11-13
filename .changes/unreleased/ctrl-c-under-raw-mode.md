---
category: Fixed
---
- The bridge no longer puts the terminal into raw mode. Raw mode disabled the driver's ISIG, ECHO, IXON and line editing, so Ctrl+C, Ctrl+Z, Ctrl+\\, Ctrl+S/Q and input echo stopped working while a session was bound; the plugin now reads stdin in the terminal's own line mode and leaves every control key to the driver. Operator input is still read a line at a time.
