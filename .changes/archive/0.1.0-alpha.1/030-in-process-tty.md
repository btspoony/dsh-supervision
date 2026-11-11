---
category: Added
---
- With `HC_TERMINAL_ID` set, a `dsh web` started inside the supervised terminal supervises itself: the plugin writes the same OSC 7501 records to its own `/dev/tty` and reads its own stdin, so no socket, no registry entry and no forwarder process are created.
- A terminal that cannot be opened — no `/dev/tty`, or a stdin that is not a terminal — fails the mount closed with one stderr line, leaving the host's sessions untouched.
