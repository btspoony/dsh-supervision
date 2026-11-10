# AGENTS.md — .mstar/ (harness layer)

- Path symbols: {HARNESS_DIR} = .mstar/; {PLAN_DIR} = plans/; {SDD_DIR} = sdd/<plan-id>/;
  {ITERATION_DIR} = iterations/; {KNOWLEDGE_DIR} = knowledge/; {SPECS_DIR} = specs/;
  {WORKFLOW_DIR} = workflows/; {PROJECT_DIR} = projects/ (SSOT: skills/mstar-conventions).
- Process vs results: process artifacts (plans/, iterations/, sdd/, status.json, workflows/,
  projects/) stay local and gitignored; results (this file, knowledge/, specs/) are tracked
  and shared across clones.
- Done: only @project-manager may set Done; implementers set InReview.
