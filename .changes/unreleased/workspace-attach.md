---
category: Fixed
---
- A session created by `dsh-sup` is attached to the workspace that owns its directory and removed from the archive set, so the GUI lists it under that project; previously the session answered on the wire and in `dsh-sup list` but never appeared in the browser.
