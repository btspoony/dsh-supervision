---
category: Changed
---
- Both READMEs carry a one-prompt handoff for the agent that drives the supervisor's terminal: it matches `dsh-sup` to the installed plugin version, falls back to a consent-gated `npm i -g dsh-sup@latest` when `dsh` or the plugin is absent (a desktop DSH has no CLI), reads `dsh-sup --skill` as the authority, and records the usage in its own supervisor-side skill, memory or AGENTS.md instead of repeating CLI details that the manual already owns.
