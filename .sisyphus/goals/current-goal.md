# Current Goal

## Goal As Stated

Delete or replace the temporary Hush project-env reconciliation RFC with a real
durable plan, then finish the work so the reconciler is upstreamed into Hush,
Folio uses the upstreamed commands, and the temporary plan/prototype surfaces
can be removed.

## Interpreted Goal

Port Folio's repo-local `scripts/hush-project-env.mjs` prototype into first-
class `hush project` CLI commands in the Hush repo, keep the behavior low-risk
by making it additive to existing Hush surfaces, switch Folio to the upstreamed
commands, and remove the now-redundant RFC/prototype glue if the upstreamed
version fully replaces it.

## Success Criteria

- Hush CLI ships `hush project plan`, `hush project validate`, and
  `hush project sync`.
- Hush command behavior is covered by tests and documented in CLI/user docs.
- Folio (`/Users/hassoncs/src/ch5/folio-db`) stops relying on `scripts/hush-project-env.mjs` as its canonical
  implementation surface.
- Folio CI/deploy flows use the upstreamed Hush commands.
- Temporary RFC/prototype surfaces are deleted or reduced to brief historical
  notes if no longer needed.
- `git status --short` is clean in both `hush` and `folio-db`.
- Commits are pushed.
- Proof includes: Hush tests for new command family, Folio workflow/script
  migration evidence, and clean status in both repos after push.

## Constraints

- Keep behavior additive and low-risk; do not break existing `set`, `push`,
  `verify-target`, or Cloudflare flows.
- Follow Hush CLI change contract: implementation, skill docs, and user docs
  move together.
- No secrets printed.
- Preserve unrelated repo state.

## Non-Goals

- Generalize every provider/runtime in one pass.
- Replace all bespoke deploy tooling across all CH5 repos now.
- Add destructive secret pruning.

## Current State

- Folio already has a working repo-local prototype:
  `scripts/hush-project-env.mjs`.
- Hush now has additive `project` command plumbing plus tests/docs for
  `plan`, `validate`, and `sync`.
- Hush RFC + temporary upstreaming plan are removed in favor of shipped docs
  and this goal file.
- Folio CI/deploy migration is still in progress.
- `hush set --file` and `delete-key --from` regressions are already fixed.

## Plan

1. Finish Folio migration to direct `hush project` usage everywhere active.
2. Remove redundant Folio prototype surfaces now covered upstream.
3. Verify both repos, commit, push, and leave clean status.

## Next Update Triggers

- goal changes
- constraints change
- acceptance criteria change
- plan or blocker state changes materially
