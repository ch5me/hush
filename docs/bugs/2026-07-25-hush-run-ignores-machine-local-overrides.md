# Bug Report: `hush run` (and `trace`, `get`, `materialize`) never sees machine-local overrides

Date: 2026-07-25
Observed Hush version: `7.7.0` (reproduced identically on the v8 storage-class branch — **not** a regression from it)
Status: **fixed** (2026-07-25)

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

## Fix

Machine-local overrides are now a **resolver layer**, not a command-layer post-merge.

- `ResolveV3Options.machineLocal: 'include' | 'exclude'` is **required**, with no default. The
  original defect was a command inheriting the wrong answer by saying nothing, so the type checker
  now forces every call site — including any future one — to state its intent. Adding the field
  enumerated all fourteen existing call sites at compile time.
- `resolveV3Bundle` appends the store's value entries as candidates carrying provenance
  `filePath: user/local`, so `hush trace` attributes an override instead of hiding it.
- The v8 storage-class split does the load-bearing work here: `user/**` is reserved and can never
  be a repository file, so a machine-local logical path can never contend with a repository one.

### Where the override actually applies

Overrides win at the **environment-key** layer, not the logical-path layer — `user/local/DB_URL`
and `env/project/shared/DB_URL` are different paths that both collapse to `DB_URL`. That collapse
happens in `collectEnvVars` (`hush-cli/src/v3/artifacts.ts`), so the shadowing lives there.

Putting it in the resolver's path-level selection instead would have been a worse bug than the one
being fixed: `interpolateCandidates` runs after selection and resolves `${env/project/shared/DB_URL}`
against the selected map, so dropping a shadowed node there would leave interpolation pointing at a
path that no longer exists. Keeping the node means `${...}` still reads the repository value while
the environment view collapses.

Two repository paths colliding on one environment key still throw, override or not. Resolving that
in favor of the override would make a genuine ambiguity green on the one machine holding the
override and broken in CI and for everyone else.

### Participation by command

| Included (resolves for this machine) | Excluded (describes committed content) |
|---|---|
| `run`, `materialize`, `decrypt --force`, `push`, `has`, `list`, `project` | `diff`, `export-example` |
| `resolve`, `trace`, `verify-target` — must agree with `run` | `migrate --validate` — an override must not make a repo with a missing key look migrated |

`push` and the `resolveTargetEnvView` group already included overrides; their behavior is unchanged.
`get` is not implemented on `main` (see `feat/hush-get-command`); the affected-command table above
listed it from the error-message text in `v3-command-helpers.ts`.

### Overrides are no longer silent

An override that displaces a repository value is now reported rather than only applied:

- `hush set --repo-local` names the repository files it displaces, at the one moment the operator is
  looking.
- `hush resolve <target>` lists them under **Machine-local overrides** (`shadowed` in `--json`).
- `hush trace <KEY>` attributes the value to `user/local`.

### Regression test

`hush-cli/tests/runtime-v3.test.ts` → `run and machine-local overrides`, three cases asserted
through `runCommand` and the `spawnSync` child environment: machine-local-only key injected,
override beats the shared value, non-overridden repository keys survive. Asserting through
`hasCommand` is what let this survive commit e759211 — `has` reads through the one wrapper that
always did merge overrides, so it could never have failed.

`hush-cli/tests/v3/resolver.test.ts` → `resolveV3Target machine-local layer` covers the shadowing
metadata, the interpolation-still-resolves invariant, provenance attribution, `exclude`, and the
preserved two-repository-path collision error.

### Known follow-ups (deliberately not in this change)

- No drift detection: a stale override masking a *rotated* shared secret is reported the same as a
  fresh one. Recording the shadowed value's digest at write time would let `run` warn only when the
  repository value has since changed.
- No tombstones: there is no way to locally unset a key to test the fallback path. Natural in a layer
  model; needs an entry-schema encoding, so it wants reserving before the format is widely written.
- `push` ships machine-local overrides to remote targets. That is pre-existing behavior, not
  introduced here, but a developer's laptop values reaching a shared environment deserves its own
  decision.

## Original Suggested Direction (for the record)

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
