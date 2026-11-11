---
category: Added
---
- CI runs on every pull request, and releases are PR-driven: change fragments are assembled into the changelog, both package versions are bumped, a `release vX.Y.Z` pull request is opened, and merging it publishes with npm provenance.
- Bilingual user documentation: `README.md` / `README.zh-CN.md`, package-localized metadata in `locale/`, `docs/DETAIL.md` / `docs/DETAIL.zh.md` and the preview figures.
- The plugin logo (`icon.svg`) is declared as the package icon.
- `pnpm release:prepare` and `pnpm release:validate` ship with a `node --test` suite that also runs in CI.
- Both packages (`dsh-supervision`, `dsh-sup`) share one version surface and publish together from a single release.
