# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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

### Fixed

- Both packages publish through `npm` with npm provenance (Trusted Publishing) instead of `pnpm publish`, whose OIDC token exchange fails against the registry, and the pnpm `workspace:` protocol is stripped from the manifest before packing, so a published package carries no unresolved `workspace:*` specifier. Publishing authenticates through OIDC alone: `setup-node` must not set `registry-url`, because the `.npmrc` it writes carries a placeholder `_authToken` that npm prefers over the OIDC exchange, and the registry answers that placeholder with a 404 on the publish PUT while provenance signing still succeeds.

## [0.0.0] - 2026-11-11

- Repository baseline: `dsh-supervision` and `dsh-sup` were unpublished before
  this standardization; the first published version is produced through the
  Release prep workflow.
