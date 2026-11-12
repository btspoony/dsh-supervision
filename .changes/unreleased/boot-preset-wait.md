---
category: Fixed
---
- The tty's first session now waits up to 5 s for the preset registry, re-reading it on every boot attempt, while the agent factory keeps its own documented 30 s retry window. A profile that registered the registry after the first hello used to create a session with no mounted tools; a profile that never mounts it pays only the short wait.
