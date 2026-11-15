---
category: Fixed
---
- The package declares `dsh.bundle` with a `cordis.patch.yml`, so `dsh plugin add dsh-supervision` (and the plugin manager) activates it as a profile bundle; previously the row never mounted, the control socket never opened, and `dsh-sup` reported no running backend.
- The manifest carries the plugin package keywords, `main`/`types`, an `engines.dsh` compatibility range, and subpath exports for the bundle patch and `package.json`, matching the shape DSH's plugin manager reads.
- The repository ships the MIT `LICENSE` file its manifest already declared.
