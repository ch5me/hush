# RFC: Make `hush set --target` Target-Aware or Fail Closed

**Status:** Proposed  
**Date:** 2026-07-09  
**Author:** Field incident from Firefly Cloud staging-auth recovery  
**Severity:** High — a secret can be written to a broader file than the operator intended

## Summary

The Hush CLI globally parses `-t/--target`, including when the active command is
`set`, but `setCommand()` does not receive or validate that target. When an
operator runs:

```bash
hush set -t root-runtime-production NEXTAUTH_URL https://app.elf.dance
```

Hush accepts the command and writes to the default destination:

```text
will write NEXTAUTH_URL -> env/project/shared
```

The operator selected a production target, but the write landed in the shared
file. In a stage-split repository this can create duplicate-key conflicts,
broaden secret exposure, and leave the selected target unchanged because an
environment-specific file has higher precedence.

Hush must either make `set --target` target-aware or reject it before reading the
secret value. Silently accepting and ignoring an authority/scoping flag is not a
safe behavior for a secrets manager.

## Incident

During Firefly Cloud authentication recovery, production Hush contained:

- a placeholder `NEXTAUTH_URL` in `env/project/production`
- no effective `NEXT_PUBLIC_FIREFLY_APP_URL` in the production target

The initial repair used the target selected for all preceding diagnostics:

```bash
hush set -t root-runtime-production NEXTAUTH_URL https://app.elf.dance
hush set -t root-runtime-production NEXT_PUBLIC_FIREFLY_APP_URL https://app.elf.dance
```

Both commands reported successful writes to `env/project/shared`. Hush then
reported that `NEXTAUTH_URL` existed in both production and shared files and that
the production file would win at runtime.

The repair required explicit file writes and cleanup:

```bash
printf %s https://app.elf.dance |
  hush set NEXTAUTH_URL --file env/project/production

printf %s https://app.elf.dance |
  hush set NEXT_PUBLIC_FIREFLY_APP_URL --file env/project/production

hush delete-key NEXTAUTH_URL --from env/project/shared --yes
hush delete-key NEXT_PUBLIC_FIREFLY_APP_URL --from env/project/shared --yes
```

The final target diff correctly showed only the two production-file changes.

## Root Cause in the Current CLI

The CLI parser accepts `-t/--target` globally in `hush-cli/src/cli.ts`:

```ts
if (arg === '-t' || arg === '--target') {
  target = args[++i];
  continue;
}
```

But the `set` dispatch does not pass `target` to `setCommand()`:

```ts
await setCommand(defaultContext, {
  store,
  file: resolvedSetFile,
  key,
  value,
  gui,
  repoLocal: resolvedRepoLocal,
});
```

`setCommand()` then calls `resolveSetDestination(file, repoLocal, repository)`.
With neither `--file` nor `--repo-local`, the destination defaults to shared.

This is not a cryptographic or SOPS failure. It is command-line scope ambiguity
combined with a fail-open destination default.

## Relationship to the Previous `--file` Defect

`docs/bugs/2026-06-23-hush-set-file-ignored.md` documents an older defect where
an explicit `--file env/project/staging` selector was ignored. That defect is
marked fixed in 7.5.0.

This RFC covers a separate path:

- `--file` now works and is the successful workaround.
- `--target` is still accepted globally for `set` but is not honored or rejected.
- The common operator expectation that a selected target scopes a write remains
  unsafe.

Regression coverage must keep these cases separate.

## Safety Invariant

For any mutating command, every supplied scope selector must be one of:

1. honored exactly;
2. rejected as unsupported before secret input is read; or
3. rejected as ambiguous with a command showing the required explicit selector.

A mutating command must never silently ignore a supplied target, environment,
file, identity, or repository selector.

## Options

### Option A: Reject `set --target` (minimum safe fix)

If target-aware writes are not yet designed, fail before prompting or consuming
stdin:

```text
error: `hush set` does not accept --target.
Choose a destination file explicitly:
  hush set KEY --file env/project/production
Inspect target precedence with:
  hush resolve root-runtime-production
```

This is the smallest safe change and should ship immediately.

### Option B: Infer a unique writable file from the target

Resolve the target's bundle and identify writable files for the active identity.
Proceed only when exactly one destination is valid. If the target contains
multiple writable files, fail with their ordered list and require `--file`.

This improves ergonomics for narrowly scoped deploy targets but introduces
policy questions around imports, precedence, machine-local overrides, and ACLs.

### Option C: Target-aware update of the current winning owner

Resolve the target and key. If the key already has exactly one winning owner,
update that file. For a new key or duplicate owners, require `--file`.

This makes repair workflows concise but risks surprising operators who intended
to move ownership rather than update the existing owner.

## Recommendation

Ship Option A first, then separately evaluate Option C.

The immediate requirement is fail-closed behavior. Target-aware mutation should
not be added until its ownership, precedence, import, ACL, and audit semantics are
specified and covered by tests.

## Required Changes

### CLI parser and dispatch

- Track whether `--target` was explicitly supplied.
- Maintain a per-command option contract instead of accepting every global flag.
- Reject unsupported flags before prompting, opening a GUI, or reading stdin.
- Include the command, rejected flag, and safe alternative in the audit event.

### Tests

Add regression tests for:

```bash
hush set -t root-runtime-production KEY value
printf value | hush set KEY -t root-runtime-production
hush set KEY value --target root-runtime-production --file env/project/production
```

For the minimum fix, all target-bearing forms should fail before mutation,
including the combined `--target --file` form. Assert:

- no encrypted file changes;
- no audit event claims a successful write;
- stdin is not consumed when the option contract can be rejected first;
- shared never receives the key;
- the error recommends `--file` and names the selected target.

Retain the existing explicit-`--file` success tests from the June defect.

### Documentation surfaces

Per the Hush CLI change contract, update together:

- `hush-cli/src/commands/skill.ts`
- `docs/src/content/docs/reference/commands.mdx`
- shell completion metadata/help text
- migration or release notes if behavior changes from accepted to rejected

## Broader Audit Questions

The same parser pattern should be audited across every command and option:

- Which globally parsed flags are silently ignored by each command?
- Do unsupported mutating-command flags fail before secret input?
- Can `--env`, `--global`, `--local`, `--repo-local`, `--file`, `--target`,
  `--bundle`, `--from`, or `--to` broaden or redirect writes unexpectedly?
- Are completion/help contracts generated from the same option authority as the
  runtime parser?
- Do audit events record the operator's requested scope as well as the resolved
  scope?

These questions should be part of a full repository audit, not only this fix.

## Acceptance Criteria

- `hush set --target ...` can no longer report success while writing shared.
- Unsupported scope flags fail before the secret value is acquired.
- Explicit `--file` writes remain correct for inline, stdin, GUI, and interactive
  input paths.
- Tests prove no mutation on every rejected combination.
- CLI help, generated AI skill guidance, completion, and user documentation agree.
