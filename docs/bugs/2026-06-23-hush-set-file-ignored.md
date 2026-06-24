# Bug Report: `hush set --file <v3-path>` Writes To `env/project/shared`

Date: 2026-06-23
Reporter context: Folio Forgejo deploy migration in `/Users/hassoncs/src/ch5/folio-db`
Observed Hush version: `7.3.0`
Status: fixed in `7.5.0`

## Summary

`hush set <KEY> <VALUE> --file env/project/staging` and the stdin form both ignored the requested v3 file path and wrote the key to `env/project/shared`.

The related cleanup command `hush delete-key <KEY> --from env/project/shared --yes` also exited successfully during this incident but did not remove the key from `env/project/shared`.

This breaks stage-split runtime/deploy targets because operators think they wrote into `env/project/staging` or `env/project/production`, but `hush verify-target <stage-target>` cannot resolve the key.

## Impact

- Stage-split Hush targets silently miss required values.
- Deploy CI setup fails at `hush verify-target`.
- Sensitive deploy credentials can land in broader `env/project/shared` instead of the intended environment file.
- The command exits successfully, so the failure is easy to miss unless followed by `hush verify-target` or `hush trace`.
- Cleanup can also appear successful while leaving the wrong entry in place.

## Repro

Run in a v3 repo that has:

- `env/project/shared`
- `env/project/staging`
- a target that resolves only `env/project/staging`

Example topology from Folio:

```bash
hush file add env/project/staging --roles owner,member,ci
hush bundle add wrangler-deploy-staging --files env/project/staging
hush target add wrangler-deploy-staging --bundle wrangler-deploy-staging --format dotenv
```

Then run either write form:

```bash
printf smoke-value | hush set FOLIO_CI_HUSH_WRITE_SMOKE --file env/project/staging
```

or:

```bash
hush set FOLIO_CI_HUSH_WRITE_SMOKE2 smoke-value --file env/project/staging
```

## Expected

The key should exist at:

```text
env/project/staging/FOLIO_CI_HUSH_WRITE_SMOKE
```

and:

```bash
hush verify-target wrangler-deploy-staging --require FOLIO_CI_HUSH_WRITE_SMOKE
```

should pass.

## Actual

`hush trace FOLIO_CI_HUSH_WRITE_SMOKE` showed:

```text
Repository files:
  env/project/shared
    env/project/shared/FOLIO_CI_HUSH_WRITE_SMOKE

Targets:
  wrangler-deploy-staging (not selected by target bundle)
    diagnosis: secret exists in env/project/shared, but target bundle wrangler-deploy-staging does not resolve those file(s).
```

`hush verify-target wrangler-deploy-staging --require FOLIO_CI_HUSH_WRITE_SMOKE` failed because the stage target resolves only `env/project/staging`.

Then this cleanup command also returned without removing the key:

```bash
hush delete-key FOLIO_CI_HUSH_WRITE_SMOKE --from env/project/shared --yes
```

Follow-up `hush trace FOLIO_CI_HUSH_WRITE_SMOKE` still showed the key under `env/project/shared`.

## Workaround Used

For existing keys already in `env/project/shared`, this worked:

```bash
hush copy-key KEY --from env/project/shared --to env/project/staging
hush verify-target wrangler-deploy-staging --require KEY
```

For newly generated one-time values, `hush set --file` is not safe until fixed. The operator must verify with `hush trace` or avoid the command path.

## Suspected Area

Likely command parsing or destination selection in the `set` command:

- `hush-cli/src/commands/set.ts`
- CLI parsing around `--file`
- Any legacy fallback that defaults destination to `shared`

## Required Fix

- Honor declared v3 file paths passed via `--file`.
- Add regression coverage for both value forms:
  - `hush set KEY value --file env/project/staging`
  - `printf value | hush set KEY --file env/project/staging`
- Add regression coverage for `hush delete-key KEY --from env/project/shared --yes`.
- Assert the key is written only to the requested file, not `env/project/shared`.
- Make unknown or unresolved `--file` destinations fail loud instead of falling back.
- Make `delete-key` fail loud if no key was removed.
