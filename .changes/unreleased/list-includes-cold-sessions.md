---
category: Fixed
---
- `dsh-sup list` now answers from the same account the sidebar groups: a session created before this `dsh web` started appears with `LIVE no` instead of being missing, while blank sessions (never had a turn) and sessions no Workspace owns stay out. The previous reply enumerated every persisted session, and a real history overflowed one protocol frame — the socket then closed with no answer at all.
