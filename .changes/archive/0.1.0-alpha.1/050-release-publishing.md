---
category: Fixed
---
- Both packages publish through `npm` with npm provenance (Trusted Publishing) instead of `pnpm publish`, whose OIDC token exchange fails against the registry, and the pnpm `workspace:` protocol is stripped from the manifest before packing, so a published package carries no unresolved `workspace:*` specifier. Trusted Publishing is entered only by a registry line with no auth token: a placeholder `_authToken` (which setup-node's `registry-url` writes) makes npm publish with that placeholder instead of asking for an OIDC token, while omitting the registry line makes it fail with ENEEDAUTH before it ever tries.
