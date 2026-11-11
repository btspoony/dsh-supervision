---
module: release-automation
date: 2026-11-11
problem_type: pitfall
category: pitfalls
severity: high
plan_id: dsh-supervision-standardization
tags:
  - github-actions
  - release
  - npm
  - tags
related_components:
  - release-workflow
  - release-prep-workflow
applies_when:
  - adding or changing a GitHub Actions publish job
  - making a release workflow re-runnable
---

# Two ways a "safe-looking" release workflow publishes from someone else's code

## What this pattern solves

A PR-driven publish job looks guarded once it checks "merged, title says
release, head branch says release". Two mechanics still let the wrong code
publish, and both are invisible in the YAML.

## Pitfall 1 — `pull_request` executes the workflow file from the PR

A workflow triggered by `pull_request` runs the definition **from the merge
commit**, not from the default branch. A same-repo PR can therefore delete its
own `if` guard and still be granted the job's `permissions:` — including
`id-token: write` for npm Trusted Publishing and `contents: write` for the tag
push. (Fork PRs get no OIDC token, so the exposure is same-repo only.)

Use `pull_request_target`: the workflow file and the `if` come from the base
branch, and the guard is evaluated before any checkout. Keep checking out the
trusted ref (`merge_commit_sha`) afterwards. A protected Environment with
required reviewers is additional coverage, not a substitute.

## Pitfall 2 — an annotated tag's SHA is not the commit SHA

`git tag -a` creates a tag *object*. `git rev-parse refs/tags/vX` returns that
object's SHA, which never equals `git rev-parse HEAD` — so a resume path that
compares them rejects every legitimate retry ("not at this merge commit"),
permanently, after the first success. Peel first:

```sh
TAG_SHA="$(git rev-parse --verify --quiet "refs/tags/v${VERSION}^{commit}")"
```

`^{commit}` dereferences the tag to the commit it points at, which is the value
comparable with `HEAD`.

## Shape that survives both

1. `pull_request_target` + a job-level guard written in the default branch.
2. Guard binds who opened the PR (prep bot / repo owner) and that the head repo
   is this repository — title and branch names are drift checks, not identity.
3. Validate anything irreversible *before* it happens: changelog section,
   version agreement, dist-tag legality.
4. Make every step re-runnable: skip a package whose exact version is already
   published; accept an existing tag that peels to this commit; leave a tag at
   another commit an error.
5. Bind the dist-tag to the version, and refuse a prerelease channel that would
   displace the stable one.
