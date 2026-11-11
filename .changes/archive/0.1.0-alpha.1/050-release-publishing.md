---
category: Fixed
---
- Both packages publish through `npm` with npm provenance (Trusted Publishing) instead of `pnpm publish`, whose OIDC token exchange fails against the registry, and the pnpm `workspace:` protocol is stripped from the manifest before packing, so a published package carries no unresolved `workspace:*` specifier. Publishing authenticates through OIDC alone: `setup-node` must not set `registry-url`, because the `.npmrc` it writes carries a placeholder `_authToken` that npm prefers over the OIDC exchange, and the registry answers that placeholder with a 404 on the publish PUT while provenance signing still succeeds.
