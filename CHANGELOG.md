# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.1.0-alpha.2] - 2026-11-14

### Fixed

- The tty's first session waits for the preset registry inside one 30 s boot window shared with the agent factory retry, re-reading both host services on every attempt. A profile that registered the registry after the first hello used to create a session with no mounted tools; a profile that mounts neither pays that one window at boot.
- The bridge no longer puts the terminal into raw mode. Raw mode disabled the driver's ISIG, ECHO, IXON and line editing, so Ctrl+C, Ctrl+Z, Ctrl+\\, Ctrl+S/Q and input echo stopped working while a session was bound; the plugin now reads stdin in the terminal's own line mode and leaves every control key to the driver.
- Ctrl+D (end of terminal input) now reports `terminal input ended` and finishes the bridge instead of leaving it mounted with a dead keyboard.
- `dsh-sup list` no longer offers sessions the web UI has archived: the sidebar shows no row for them, so attaching one led nowhere. A session an active bridge holds stays listed, because that bridge is the surface steering it.
- `dsh-sup list` now answers from the same account the sidebar groups: a session created before this `dsh web` started appears with `LIVE no` instead of being missing, while blank sessions (never had a turn) and sessions no Workspace owns stay out, so every listed id has a sidebar row to open. The archive exemption for a bridged session is unchanged. The previous reply enumerated every persisted session, and a real history overflowed one protocol frame — the socket then closed with no answer at all.
- `dsh-sup list` sizes every column from its widest cell instead of relying on tab stops, so a long session id or cwd no longer pushes the LIVE and BRIDGED columns out of alignment.
- Records reach `/dev/tty` through a non-blocking stream, so a paused terminal (Ctrl+S) holds them in an ordered queue instead of blocking the host's event loop. The stdout fallback keeps its synchronous write.
- The package declares `dsh.bundle` with a `cordis.patch.yml`, so `dsh plugin add dsh-supervision` (and the plugin manager) activates it as a profile bundle; previously the row never mounted, the control socket never opened, and `dsh-sup` reported no running backend.
- The manifest carries the plugin package keywords, `main`/`types`, an `engines.dsh` compatibility range, and subpath exports for the bundle patch and `package.json`, matching the shape DSH's plugin manager reads.
- The repository ships the MIT `LICENSE` file its manifest already declared.
- A session created by `dsh-sup` (`new`, or a bare hello) now carries the profile's default model selection and mounts the default agent preset, so its first turn no longer fails with "no provider/model" and its tool set includes bash and the file tools — the same shape the GUI creates.
- The plugin reads `agentDefaultModel` and `agentPresets` reflectively, so a host without those services keeps the plain create.
- A session created by `dsh-sup` is attached to the workspace that owns its directory and removed from the archive set, so the GUI lists it under that project; previously the session answered on the wire and in `dsh-sup list` but never appeared in the browser.
- The attach waits for a late `workspaceRegistry` on the tty's boot create, which runs before the profile registers that service.

### Added

- The plugin opens its control socket even when `dsh web` runs inside a supervised terminal: the in-process tty is now an additional reporting surface rather than an exclusive mode, so herdr-core keeps watching the terminal while a `dsh-sup` elsewhere can attach another session.
- A session still has exactly one bridge across both surfaces; a second claim is refused with `busy` — on the wire `hello`, on the `/attach` operator command, and for two hellos racing the same session — and the first bridge stays untouched.
- Only the tty's synthesized first session retries for up to 30 s while the profile boots without an agent factory; forwarder creates and `/new` keep failing fast with `create-failed`.
- A tty that cannot be opened no longer suppresses the socket surface.
- Attached in a terminal, `dsh-sup` now shows the conversation it is supervising. A new `mirror` frame carries each operator message, each assistant reply (with a `⟦↑in ↓out⟧` usage line when the adapter reported token usage), and each tool call; the forwarder writes it as append-only lines — no colour, no markdown, no spinner, no rewritten line, and nothing from before the attach replayed. The transcript goes to stdout, and only when stdout is a TTY.
- OSC 7501 records keep going to `/dev/tty`, so the machine surface is unchanged; `echo` lines now reach exactly one sink — stdout when the operator has a TTY, `/dev/tty` otherwise — so status and approval lines appear in an interactive attach without a real supervisor losing them.
- `PROTO` is now `2`. The plugin and `dsh-sup` ship as one version pair, so an old forwarder and a new plugin refuse each other instead of half-working.
- Input handling is untouched: line mode, no raw mode, no alternate screen.
- Supervision records are now capped the same way the rest of the encoder already was: a multi-byte session title or message is shortened to the documented byte budget instead of producing an over-cap record that the supervisor drops, so a supervised session can no longer report a stale state. ASCII records are byte-identical.
- The GUI now marks a supervised session everywhere it appears: its sidebar row gets a heavy blue outline and a whale-tail badge, and opening it covers the composer with `Supervised from dsh-sup — this composer is covered.` plus an **Unlock** button that reclaims the session. The editor is `inert` while supervised, so neither the pointer nor an already-focused caret can type into it.

### Changed

- The README states that a session created by `dsh-sup` stays out of the web UI sidebar until its first message, so an empty session visible in `dsh-sup list` is expected rather than a missing workspace attach.
- `dsh-sup list` now lists every session on every live backend; `--cwd` narrows the table to one directory. The CWD column already names where each session lives, so filtering by the caller's directory only hid the rest.
- The table carries a `PID` column naming the backend each row came from, so a listing that spans several `dsh web` processes stays attributable.

## [0.1.0-alpha.1] - 2026-11-11

### Added

- Supervision applies to the `dsh web` process that already runs the session, not to a second copy: the plugin publishes a `0600` control socket and a registry entry under `$DSH_HOME/supervision/`, so a forwarder discovers it without any change to the host.
- `dsh-sup` connects from the terminal, reports the supervised session as OSC 7501 records on `/dev/tty`, and relays the operator's stdin back into that same session — bare text steers the running turn, `/cancel` cancels it, `/status` answers with session, state, turn and parked asks, and `/new <absolute path>` / `/attach <session-id>` switch sessions.
- `dsh-sup list` prints one table per live backend instead of one merged listing, and reports a backend that cannot answer rather than letting it look empty.
- A tool approval raised inside the bridged session tree is parked under a short id and surfaces as `state=blocked:kind=permission` naming the tool and its reason, so the supervisor answers it without a second GUI: `/approve <ask>` settles it as `allowed-once`, `/reject <ask>` as `rejected`, `/y` and `/n` answer the only parked ask, and a withdrawn ask becomes `cancelled`.
- While a session is bridged the GUI shows a supervision banner above the composer with a **Take back control** button that posts to the reclaim route, drops the bridge and lets the forwarder exit cleanly.
- With `HC_TERMINAL_ID` set, a `dsh web` started inside the supervised terminal supervises itself: the plugin writes the same OSC 7501 records to its own `/dev/tty` and reads its own stdin, so no socket, no registry entry and no forwarder process are created.
- A terminal that cannot be opened — no `/dev/tty`, or a stdin that is not a terminal — fails the mount closed with one stderr line, leaving the host's sessions untouched.
- `dsh-sup` exits with a distinct code per outcome: `0` clean bye, `1` backend lost, `2` usage or no live backend, `3` session busy, `4` locked, `5` create failed, and `6` a protocol refusal from a backend that is still alive.
- A `list` run that hits several failures keeps the strongest signal: a lost backend outranks a coded refusal, and the exit code does not depend on registry order.
- CI runs on every pull request, and releases are PR-driven: change fragments are assembled into the changelog, both package versions are bumped, a `release vX.Y.Z` pull request is opened, and merging it publishes with npm provenance.
- Bilingual user documentation: `README.md` / `README.zh-CN.md`, package-localized metadata in `locale/`, `docs/DETAIL.md` / `docs/DETAIL.zh.md` and the preview figures.
- The plugin logo (`icon.svg`) is declared as the package icon.
- `pnpm release:prepare` and `pnpm release:validate` ship with a `node --test` suite that also runs in CI.
- Both packages (`dsh-supervision`, `dsh-sup`) share one version surface and publish together from a single release.

### Changed

- The in-process tty transport reads `DSH_SUP_TERMINAL_ID` first and the supervisor label reads `DSH_SUP_TERMINAL_NAME` first; herdr-core's `HC_TERMINAL_ID` and `HC_TERMINAL_NAME` remain as compatibility fallbacks, so an existing `hc` setup keeps working unchanged.

### Fixed

- Both packages publish through `npm` with npm provenance (Trusted Publishing) instead of `pnpm publish`, whose OIDC token exchange fails against the registry, and the pnpm `workspace:` protocol is stripped from the manifest before packing, so a published package carries no unresolved `workspace:*` specifier. Trusted Publishing needs the registry scope key `//registry.npmjs.org/:_authToken` to exist with an empty value: a placeholder token is used as the publish token instead of the one npm exchanges over OIDC, while dropping the key leaves npm without a credentialed registry and the publish fails with `ENEEDAUTH`. npm logs a failed OIDC exchange only at verbose level, so the publish steps run with `NPM_CONFIG_LOGLEVEL=verbose` to make the next failure diagnosable. The Release workflow must be triggered by `pull_request` rather than `pull_request_target`: npm only accepts an OIDC token minted for the former and rejects every exchange under the latter with `package not found`.

## [0.0.0] - 2026-11-11

- Repository baseline: `dsh-supervision` and `dsh-sup` were unpublished before
  this standardization; the first published version is produced through the
  Release prep workflow.
- `0.1.0-alpha.1` was prepared through the Release prep workflow and withdrawn
  before it reached the registry; the manifests were reset to `0.0.0` so the
  first published version is produced by a fresh prep run.
