# RFC: Project Environment Reconciliation

Date: 2026-06-24
Status: proposed
Trigger incident: Folio deployed to staging/production with `RESEND_API_KEY` present in Hush and Cloudflare, but invalid provider-side. CI checked presence only, and Folio had separate Hush, Wrangler TOML, Worker secret sync, and provider validation paths.

Folio first implementation: `/Users/hassoncs/src/ch5/folio-db/scripts/hush-project-env.mjs` with config at `packages/runtime-config/config/hush-project-env.json`. It is a repo-local prototype of `hush project validate|sync`: Hush remains source of truth for secrets, Wrangler remains current non-secret materialization, and one command reconciles the contract, Hush target, Cloudflare Worker secret metadata, and provider validators.

## Problem

Hush is meant to be the project runtime authority, but current workflows can still drift:

- Hush target has a key, but provider rejects it.
- Hush target has runtime and deploy-only secrets mixed together.
- Wrangler TOML owns non-secret vars while Hush owns secrets, with no single reconciliation view.
- Cloudflare Worker/Pages secrets can differ from Hush because `wrangler secret put` is run by bespoke repo scripts.
- CI can verify "key exists" and still deploy broken runtime.

The operator needs one command that answers:

1. What variables are required for this project and environment?
2. Which source owns each value?
3. Does Hush resolve each required value?
4. Does the external runtime have the same required values?
5. Do provider keys pass safe live validation?
6. What exact sync/fix command should run, without printing secrets?

## Goals

- Make Hush the source of truth for environment inputs.
- Add project-level doctor/reconcile/sync surfaces that compare Hush, declared contract, host-platform state, and provider health.
- Keep output AI-safe: no secret values, no decrypted temp files by default.
- Make CI fail before deploy when required provider keys are missing, invalid, or not synced.
- Support non-secret runtime variables as first-class managed inputs, not only secret values.

## Non-goals

- No generic secret reveal command.
- No implicit destructive pruning of host-platform secrets.
- No silent fallback from one environment to another.
- No automatic promotion of staging secrets to production.

## Proposed Commands

### `hush project doctor`

Read a project contract and report desired-vs-actual state.

Example:

```bash
hush project doctor \
  --env staging \
  --contract packages/runtime-config/config/runtime-requirements.json \
  --runtime cloudflare-workers:apps/api/wrangler.toml#env.staging \
  --target api-worker-staging \
  --json
```

Checks:

- contract parses
- target exists
- required keys resolve from Hush target
- required non-secret vars resolve from Hush or declared static config
- target has no deploy-only keys unless allowed
- target has no missing runtime keys
- Wrangler TOML vars match contract-derived expected values
- Cloudflare Worker/Pages metadata has required secret names
- provider validators pass for declared validators

### `hush project plan`

Produce an AI-safe sync plan, no changes.

Example output shape:

```json
{
  "environment": "staging",
  "status": "drift",
  "actions": [
    {
      "kind": "cloudflare-secret-put",
      "key": "RESEND_API_KEY",
      "source": "hush:env/project/staging",
      "target": "worker:insight-db-api-staging",
      "reason": "missing-or-stale"
    },
    {
      "kind": "provider-validate",
      "provider": "resend",
      "key": "RESEND_API_KEY",
      "reason": "required validator"
    }
  ]
}
```

### `hush project sync`

Apply the plan from Hush to the external runtime.

Default behavior:

- only create/update required external values
- no pruning
- no reveal
- uses stdin to `wrangler secret put`
- writes non-secret vars through provider-native APIs when supported, otherwise fails with clear instructions

Example:

```bash
hush project sync \
  --env staging \
  --contract packages/runtime-config/config/runtime-requirements.json \
  --runtime cloudflare-workers:apps/api/wrangler.toml#env.staging \
  --target api-worker-staging
```

### `hush project validate`

CI-oriented hard gate. Equivalent to doctor + provider validators + external metadata check, but no sync.

Example:

```bash
hush project validate --env staging --contract packages/runtime-config/config/runtime-requirements.json
```

Exit codes:

- `0`: all required values resolve, sync state matches, validators pass
- `1`: drift or validation failure
- `2`: command/config misuse
- `3`: external provider unavailable or auth unavailable

## Contract Shape

Use a repo-owned contract file. Folio already has this shape:

```json
{
  "api": [
    {
      "name": "RESEND_API_KEY",
      "delivery": "secret",
      "requiredIn": ["staging", "production"],
      "topologyTargets": ["cf-worker-api"],
      "description": "Resend API key for magic-link email delivery"
    },
    {
      "name": "AUTH_FROM_EMAIL",
      "delivery": "variable",
      "templateManaged": true,
      "requiredIn": ["staging", "production"],
      "topologyTargets": ["cf-worker-api"],
      "description": "Sender email address for auth emails"
    }
  ]
}
```

Hush should support an optional companion config to map contract groups to Hush targets and external runtimes:

```yaml
environments:
  staging:
    targets:
      deploy: wrangler-deploy-staging
      apiRuntime: api-worker-staging
    runtimes:
      apiRuntime:
        provider: cloudflare-workers
        cwd: apps/api
        wranglerEnv: staging
        workerName: insight-db-api-staging
    validators:
      - provider: resend
        key: RESEND_API_KEY
        fromEmail: AUTH_FROM_EMAIL
```

## Hush Topology Recommendation

Projects should split targets by purpose:

| Target type | Contains | Example |
|---|---|---|
| deploy driver | build/deploy credentials used by CI | `wrangler-deploy-staging` |
| Worker runtime | runtime secrets pushed into Worker | `api-worker-staging` |
| Pages build/runtime | Pages project secrets/vars | `web-pages-staging` |
| local runtime | local dev values only | `runtime-dev` |

Deploy-driver targets should not be pushable to Worker runtime. Runtime targets should not contain deploy credentials like `NPM_TOKEN` or `CLOUDFLARE_API_TOKEN`.

## Provider Validators

Initial validators:

| Provider | Inputs | Safe validation |
|---|---|---|
| Resend | `RESEND_API_KEY`, optional sender domain from `AUTH_FROM_EMAIL` | `GET https://api.resend.com/domains`; require 2xx and verified sender domain |
| Cloudflare Workers | `CLOUDFLARE_API_TOKEN`, account id, worker name | list secret names/vars metadata only |
| WorkOS | `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` | read-safe app/client metadata if API supports it |
| Sentry | `SENTRY_DSN` | DSN parse + optional envelope/test event dry-run |

Validators must never print tokens or raw provider error bodies that can include secrets.

## Acceptance Criteria

- Folio can replace bespoke `scripts/sync-worker-secrets.sh` with Hush project sync or a thin wrapper around it.
- CI can run `hush project validate --env staging` before deploy and after sync.
- A bad Resend key fails before staging deploy.
- Missing Cloudflare Worker secret names fail before production promotion.
- JSON output names missing keys, owner system, target, validator, and remediation command.
- Dry-run output is deterministic and safe for AI agents.
- Runtime target separation prevents deploy-only keys from being pushed to Worker runtime.

Folio prototype status:

- `scripts/sync-worker-secrets.sh` now delegates to the reconciler.
- Forgejo validates with `node scripts/hush-project-env.mjs validate <env>`.
- Forgejo syncs with `node scripts/hush-project-env.mjs sync <env>`.
- The reconciler uses `hush verify-target` plus `hush run --target ...` to avoid printing secret values.
- Remaining upstream work: move this from Folio-local script/config into first-class Hush CLI commands and split Folio deploy-driver targets from Worker-runtime targets.

## Related Bug

`docs/bugs/2026-06-23-hush-set-file-ignored.md` must be fixed before relying on Hush to create/split new Folio runtime targets. Current workaround is `hush copy-key` for existing keys plus `verify-target`/`trace` after every mutation.
