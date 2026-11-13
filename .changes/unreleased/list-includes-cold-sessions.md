---
category: Fixed
---
- `dsh-sup list` now reads persisted sessions, not only live agents: a session created before this `dsh web` started is listed with `LIVE no` instead of disappearing, matching the sidebar. Blank sessions (never had a turn) are omitted unless a bridge holds them, since the sidebar hides them too.
