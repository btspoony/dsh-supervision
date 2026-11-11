# Change fragments

`.changes/unreleased/` is the only place release fragments are collected from.
`pnpm release:prepare` reads the `<slug>.md` files in that directory, assembles
them into the next `## [<version>] - <date>` section of `CHANGELOG.md` (directly
under `## [Unreleased]`), then moves the consumed fragments to
`.changes/archive/<version>/`.

`.changes/archive/<version>/` only holds fragments a release already consumed;
nothing reads it.

## Format

- Filename: any slug ending in `.md` (e.g. `add-foo.md`) inside
  `.changes/unreleased/`. This file lives in `.changes/` and
  `.changes/unreleased/.gitkeep` is a placeholder, so neither is collected.
- Frontmatter (optional): a `category:` key groups the fragment's bullets
  under a `### <category>` heading in the changelog (default: `Changed`).
- Body: one or more English bullet lines (`- ` prefix), rendered verbatim.

```markdown
---
category: Added
---
- Describe the change in one concise English bullet.
- A second bullet if needed.
```

Keep each fragment focused on a single user-visible change.
