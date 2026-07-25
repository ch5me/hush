# Bug Report: `hush run` (and `trace`, `get`, `materialize`) never sees machine-local overrides

Date: 2026-07-25
Observed Hush version: `7.7.0` (reproduced identically on the v8 storage-class branch — **not** a regression from it)
Status: **open**

Related: [`2026-07-24-hush-set-file-local-silent-noop.md`](./2026-07-24-hush-set-file-local-silent-noop.md) —
same surface, same false-green shape. That report's "Leads tested and discarded" section states
*"A read path bypasses `resolveTargetEnvView()`. **Discarded.** All runtime reads go through it."*
**That discard was wrong.** `hush run` does not.

## Summary

`hush set --repo-local KEY value` reports success, the post-write read-back guard passes, and
`hush has KEY` confirms the key is set — but `hush run -- <cmd>` injects nothing for that key.

The machine-local override store is merged into resolution **only** inside `resolveTargetEnvView()`.
Only `has`, `list`, `push`, and `project` call it. The primary entrypoint — `run` — resolves through
`resolveV3Target` / `shapeTargetArtifacts` directly and never consults the store.

## Why This Is Severe

This is the fail-loud violation the July 24 fix was meant to close, one layer further out. Every
signal an operator has says the secret is in place:

- `hush set --repo-local` prints the success line
- `assertEditableValuePersisted()` proves the value reads back from durable storage
- `hush has KEY` reports "is set"

...and the command that actually consumes secrets sees nothing. The write verification cannot catch
it: it reads back through `resolveTargetEnvView()`, which is precisely the one path that *does*
merge machine-local. The guard and the defect are on opposite sides of the same fork.

## Repro

```bash
mkdir /tmp/hush-repro && cd /tmp/hush-repro
git init -q . && echo '{"name":"hush-repro"}' > package.json
hush bootstrap --yes

hush set MY_KEY "machine-value" --repo-local
# -> MY_KEY set in user/local (repo-local, 13 chars)

hush has MY_KEY
# -> MY_KEY is set (13 chars)

hush run -- sh -c 'echo "[$MY_KEY]"'
# -> []          <-- expected "[machine-value]"
```

## Expected

Either machine-local overrides participate in every runtime read path (`run`, `get`, `materialize`,
`trace`, `resolve`, `verify-target`), or a command that cannot see them says so instead of silently
resolving without them. A store that `set` writes and `has` confirms must not be invisible to `run`.

## Actual

| Command | Consults machine-local? | Path |
|---------|------------------------|------|
| `has`, `list`, `push`, `project` | yes | `resolveTargetEnvView()` |
| `run`, `get`, `materialize`, `trace`, `resolve`, `verify-target` | **no** | `resolveV3Target()` / `shapeTargetArtifacts()` directly |

`hush trace <KEY>` is affected the same way: for a key that exists in the machine-local store it
reports only repository provenance, so provenance output silently understates what would resolve on
the surfaces that *do* merge overrides.

## Root Cause

`resolveTargetEnvView()` in `hush-cli/src/commands/v3-command-helpers.ts` is a **command-layer**
wrapper that post-merges `loadMachineLocalOverrides()` onto the resolver's output:

```ts
const shaped = shapeTargetArtifacts(targetName, target, resolution);
const localOverrides = loadMachineLocalOverrides(ctx, store);
const envVars = upsertEnvVars(shaped.envVars, localOverrideEntriesToEnvVars(localOverrides));
```

Machine-local participation is therefore opt-in per command rather than a property of resolution.
Any command that resolves a target without going through that particular wrapper silently omits the
store — no error, no warning, no typed missing-precondition.

## Suggested Direction (not yet decided)

The merge belongs **below** the command layer, in the resolver, so participation is structural
rather than per-call-site — likely as an explicit machine-local layer in `resolveV3Target` with its
own provenance record, which would also let `hush trace` attribute an override to `user/local`
instead of hiding it. That is a resolver design change with provenance and precedence implications
(machine-local currently wins unconditionally at the env-var level), so it wants a deliberate call,
not a second post-merge call site bolted onto `run`.

Whatever the fix, the regression test must assert through the **`hush run` entrypoint**, not through
`has` — asserting through `has` is exactly what let this survive the July 24 fix.

## Scope Note

Found by end-to-end CLI smoke testing while landing the v8 storage-class separation
(`env/project/local` → `user/local`). Left unfixed there deliberately: it is a different subsystem
(resolver participation, not path semantics) and a different design decision. The v8 change neither
causes nor worsens it — behavior is byte-identical on `7.7.0`.
