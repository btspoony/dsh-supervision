---
category: Fixed
---
- Records reach `/dev/tty` through a non-blocking stream, so a paused terminal (Ctrl+S) holds them in an ordered queue instead of blocking the host's event loop. The stdout fallback keeps its synchronous write.
