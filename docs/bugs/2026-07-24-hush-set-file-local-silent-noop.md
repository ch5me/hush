# Bug Report: `hush set --file env/project/local` Reports Success But Persists Nothing

Date: 2026-07-24
Reporter context: Cloudflare Vectorize migration in `/Users/hassoncs/src/ch5/firefly-cloud`
Observed Hush version: `7.5.0`
Status: **fixed** — landed on `main` after `7.7.0` (see [Root Cause](#root-cause-proven) and [Fixes](#fixes-applied))

Related: [`2026-06-23-hush-set-file-ignored.md`](./2026-06-23-hush-set-file-ignored.md) — same command
family, same silent-success failure mode, previously fixed in `7.5.0` for repository-scoped files.
The machine-local (`env/project/local`) destination still fails, so treat this as a regression in the
same surface rather than an unrelated defect.

## Summary

`hush set --file env/project/local <KEY> <value>` exits `0` and prints the normal success line
(`<KEY> set in env/project/local (...)`), but the value is never actually persisted. A subsequent
`hush get <KEY>` / target resolve for that key returns nothing.

The write silently no-ops. No warning, no nonzero exit, no diagnostic.

## Why This Is Severe

This is a direct violation of the CH5 fail-loud principle: *a green signal that can coexist with a
dead system is a defect.*

For a secrets manager this is the worst possible failure mode. The operator reads a success message,
walks away believing the credential is in place, and the gap only surfaces later — at deploy time, at
runtime, or during an incident — with no trace back to the write that never happened. Every
downstream verification step (`hush verify-target`, CI preflight, service boot) inherits a false
premise.

## Repro

Command shape as run during the Vectorize migration:

```bash
hush set --file env/project/local <KEY> <value>
# -> exit 0, success message printed
```

Then:

```bash
hush get <KEY>
# -> nothing; key does not resolve
```

## Expected

Either:

- the value is persisted to the machine-local override store and resolves via `hush get` /
  target resolution, **or**
- the command fails loud with a typed error naming the unmet precondition.

Success output must never be emitted unless a read-back proves the value is retrievable.

## Actual

- Exit code `0`.
- Success message printed naming `env/project/local`.
- Key does not resolve on any subsequent read.

## Workaround Used

Copying the key from an existing target worked:

```bash
hush copy-key <KEY> --from <source-file> --to env/project/local
```

Until this is fixed, `hush set --file env/project/local` cannot be trusted. Any use must be followed
by an explicit `hush get` / `hush trace` read-back before the operator treats the credential as
present.

## Suspected Area

Unverified leads, recorded to save the next investigator a cold start. The `local` file key is not a
repository file — it is special-cased onto a machine-local override store, and that divergence is the
obvious place for a write/read mismatch:

- `hush-cli/src/commands/set.ts` around the persistence branch: when
  `editable.scope === 'machine-local'` the write goes through `writeMachineLocalOverrides(...)`
  instead of `writeEditableFileDocument(...)`.
- `hush-cli/src/commands/v3-command-helpers.ts`:
  - `ensureEditableFileDocument()` special-cases `fileKey === 'local'`.
  - `getMachineLocalOverridePath()` derives the path from `getProjectStatePaths(store)`. If the store
    resolves to a different project root at write time than at read time, the write lands somewhere
    the reader never looks.
  - `loadMachineLocalOverrides()` returns `null` outright when `store.mode === 'global'`, so a write
    performed under one store mode can be invisible to a read performed under another.
  - Machine-local overrides are merged into resolution only in `resolveTargetEnvView()`. Read paths
    that do not go through that function would never see a correctly-written local override.

Any of these produces the same operator-visible symptom, so the fix must be confirmed by read-back,
not by inspection.

## Root Cause (proven)

**A reader/writer asymmetry in the machine-local override store.** Lead 3 above was correct; the
others were not the cause.

`env/project/local` is not a repository file — it is backed by the machine-local override document
under the project state root. Two functions in `hush-cli/src/commands/v3-command-helpers.ts` owned
that store and disagreed about it:

- `writeMachineLocalOverrides()` persisted for **every** store mode.
- `loadMachineLocalOverrides()` began with `if (store.mode === 'global') return null;`.

That early return dates back to the original v3 migration (`49bef1d`). Every read path — including
`resolveTargetEnvView()`, the only place local overrides merge into resolution — goes through
`loadMachineLocalOverrides()`. So under a global store the write landed on disk and **no read path
ever looked at it**. `hush set --global --repo-local KEY value` (equivalently
`--global --file env/project/local`) was an unconditional silent no-op: no topology precondition and
no misconfiguration required.

### Leads tested and discarded

- *`getMachineLocalOverridePath()` resolves a different project root at write vs read time.*
  **Discarded.** `resolveStoreContext()` pins `projectStateRoot` into the `StoreContext` at
  resolution time, and the project slug is derived deterministically from `keyIdentity`. Writer and
  reader always agree on the path.
- *The `editable.scope === 'machine-local'` branch in `set.ts` is itself the bug.* **Discarded.** The
  branch routes to the correct store. The defect was that the reader refused to read what that store
  had persisted.
- *A read path bypasses `resolveTargetEnvView()`.* **Discarded.** All runtime reads go through it.
- *A declared `env/project/local` repository file shadows the alias.* **Real, but intended behavior.**
  `609b78d` ("prefer explicit hush file paths", the June fix) deliberately makes a declared
  repository file win over the alias, with test coverage. When such a file is declared *and* included
  in the target's bundle, the value resolves correctly. When it is declared but no bundle includes it,
  the value persists but does not resolve — a topology error rather than a routing bug. It is now
  surfaced by an explicit warning instead of a clean success line.

## Fixes Applied

All in `hush-cli/src/commands/`:

1. **Reader/writer symmetry (`v3-command-helpers.ts`).** Removed the `store.mode === 'global'` early
   return from `loadMachineLocalOverrides()`. The reader now looks wherever the writer writes, in
   every store mode. This is the root-cause fix.

2. **Fail-loud write verification (`v3-command-helpers.ts` + `set.ts`) — the durable fix.** New
   `readBackEditableValue()` and `assertEditableValuePersisted()`. After every `set` write, the value
   is re-read from durable storage through the **same reader the runtime resolution path uses** for
   that scope: `loadMachineLocalOverrides()` for machine-local, and a **freshly loaded** repository
   for repository files (the caller's in-memory repository has a file cache that would otherwise echo
   a document that was never persisted). If the value is missing or mismatched, `set` throws, audits a
   failed write, and prints no success line. Error messages never contain the secret value.

   This is the guarantee that keeps the bug class from recurring: even if a future write path breaks,
   `set` fails loudly instead of lying.

3. **Unresolved-write warning (`v3-command-helpers.ts` + `set.ts`).** New `describeUnresolvedWrite()`.
   When a write persists but the active target's bundle does not select the destination file, `set`
   still succeeds and warns that `hush get` will not return the key there, pointing at
   `hush trace <KEY>`. Non-fatal by design — writing into a file the current target does not resolve
   is a normal stage-split workflow. Also emitted as `resolutionWarning` in `--json` output.

## Regression Coverage

`hush-cli/tests/set-local-write-verification.test.ts` — 9 tests. Six fail against the pre-fix source;
the baseline round-trip cases correctly passed both before and after.

- `set --file env/project/local resolves back through the runtime target view`
- `piped stdin value to --file env/project/local resolves back through the runtime target view`
- `set --file local (alias form) resolves back through the runtime target view`
- `set --repo-local resolves back in global store mode` *(the root-cause regression)*
- `warns instead of reporting a clean success when the written file is not selected by the target`
- `does not warn when the written file is selected by the target`
- `fails loud instead of reporting success when a machine-local write does not persist`
- `fails loud instead of reporting success when a repository write does not persist`
- `never includes the secret value in a write-verification error`

Read-back assertions go through `hasCommand` → `resolveTargetEnvView`, i.e. the same path a later
`hush get` uses — not merely a check that bytes reached the disk. That is exactly what the June fix's
coverage lacked, which is how this regressed.

## Machine-Local Writer Audit

Requested by the original report. `set` and `edit` are the only commands that write to the
machine-local override store (both via `ensureEditableFileDocument()` / `writeMachineLocalOverrides()`).

- `set` — fixed by all three changes above.
- `edit` — was subject to the same global-mode invisibility and is fixed by change 1. It validates the
  edited document before re-encrypting and does not assert that a specific key persisted, so the
  per-key read-back guard does not apply to it.
- `copy-key` / `move-key` / `delete-key` — repository files only; they never touch the machine-local
  store, so they are not exposed to this defect.

## Verification

- `bun run type-check` — clean, with no `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Full CLI suite: 45 files, 452 tests, all passing.
