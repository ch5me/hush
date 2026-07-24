# Bug Report: `hush set --file env/project/local` Reports Success But Persists Nothing

Date: 2026-07-24
Reporter context: Cloudflare Vectorize migration in `/Users/hassoncs/src/ch5/firefly-cloud`
Observed Hush version: `7.5.0`
Status: open

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

## Required Fix

- Make `hush set --file env/project/local` actually persist, or fail loud with a typed error.
- Never print a success line for a write that was not proven durable — read back the key after the
  write and fail if it does not resolve.
- Add regression coverage for both value forms against `env/project/local`:
  - `hush set --file env/project/local KEY value`
  - `printf value | hush set --file env/project/local KEY`
  - each asserting a subsequent `hush get KEY` returns the value.
- Add coverage asserting write and read agree on the machine-local override path across store modes
  (project vs global) rather than silently diverging.
- Audit every other command that writes to a machine-local destination for the same
  success-without-persistence gap.
