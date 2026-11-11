---
category: Fixed
---
- Both packages publish through `npm` with npm provenance (Trusted Publishing) instead of `pnpm publish`, whose OIDC token exchange fails against the registry, and the pnpm `workspace:` protocol is stripped from the manifest before packing, so a published package carries no unresolved `workspace:*` specifier. Trusted Publishing needs the registry scope key `//registry.npmjs.org/:_authToken` to exist with an empty value: a placeholder token is used as the publish token instead of the one npm exchanges over OIDC, while dropping the key leaves npm without a credentialed registry and the publish fails with `ENEEDAUTH`. npm logs a failed OIDC exchange only at verbose level, so the publish steps run with `NPM_CONFIG_LOGLEVEL=verbose` to make the next failure diagnosable.
