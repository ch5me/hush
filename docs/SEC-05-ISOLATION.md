# SEC-05 tenant and data-disclosure isolation

Hush's tenant and data-disclosure isolation gate is **fixture-only** and labeled **internal**. Isolation is unproved for customer activation (`MISS-SEC05-ISOLATION-UNPROVED`). This change does not activate customers, cut over public `hush run` materialization, invent vault ownership, activate CON-06, or spend.

## Receipt

Machine-readable copy: `.ch5/sec-05-isolation.json`

| Field | Value |
| --- | --- |
| Program / ids | ELF-CH5 `SEC-05-IMPL-01` / `MISS-SEC05-ISOLATION-UNPROVED` |
| Task | SEC-05 |
| Gate | `tenant-data-disclosure-isolation` |
| Status | `INTERNAL_ONLY` |
| Internal | `internal_only: true`, `proof_label: internal` |
| Customer release | `BLOCKED` |
| Enabled | `false` |
| Spend | `0` (D08) |
| CON-06 | `NOT_ACTIVATED` |
| Ownership | `unresolved` |
| SEC-03 miss | `MISS-SEC03-OWNER-UNRESOLVED` |
| Blocker | `MISS-SEC05-ISOLATION-UNPROVED` |

## Gate

`enforceIsolation(destination, action)` composes SEC-03 `admit(destination, action)` with owner, tenant, and grant checks on declared access paths (`mediated.admit.use`, `mediated.admit.materialize`). Auth failure is fail-closed: local, cloud, and provider credential fallbacks are refused, and broader credentials are not consulted. A fixture-scoped pass stays `internal_only` with `customer_release: BLOCKED`. Unresolved mediation ownership is not rewritten into a vault owner.

Symbols: `enforceIsolation`, `discloseUse`, `refuseCustomerRelease`, `keepMediationDisabledPathHonest`, `isolationStateFromReceipt`.

## Fixtures (fake tokens only)

| Id | Property |
| --- | --- |
| `FX-SEC05-tenant-scope-enforced` | Declared supported access paths enforce owner/tenant/grant scope |
| `FX-SEC05-auth-fail-no-fallback` | Auth failure cannot trigger local/cloud/provider fallback or broader credentials |
| `FX-SEC05-customer-release-blocked` | Customer release remains blocked on unproved isolation; internal proof is labeled internal |

## Out of scope

No customer activation, public cutover, green production isolation pass, invented vault owner, spend, CON-06 activation, npm.ch5.me peer fetch, or live cloud credentials.
