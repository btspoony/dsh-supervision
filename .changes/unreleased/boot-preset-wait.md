---
category: Fixed
---
- The tty's first session now waits for the preset registry as well as the agent factory, re-reading both host services on every boot attempt. A profile that registered the registry after the first hello used to create a session with no mounted tools.
