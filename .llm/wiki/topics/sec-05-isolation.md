# SEC-05 tenant and data-disclosure isolation — internal, customer release BLOCKED

> Isolation is fixture-proved and labeled internal. Customer activation stays blocked while isolation is unproved.

## Normative rule

The tenant/data-disclosure isolation gate stays `INTERNAL_ONLY` with `customer_release: BLOCKED`, `proof_label: internal`, and `internal_only: true`. Declared access paths must enforce owner/tenant/grant scope. Auth failure must not fall back to local, cloud, or provider credentials. Do not invent vault ownership to green isolation: `MISS-SEC03-OWNER-UNRESOLVED` remains honest and the mediation adapter stays disabled. CON-06 stays `NOT_ACTIVATED`. Zero spend (D08).

> Sources: `.ch5/sec-05-isolation.json`, `hush-cli/src/sec05/isolation.ts`, `docs/SEC-05-ISOLATION.md`

## Implementation

`enforceIsolation` requires SEC-03 `admit(destination, action)` then matching owner, tenant, and grant on a declared access path. `discloseUse` never returns secret material. Auth failure returns `AUTH_FAIL_NO_FALLBACK` without consulting fallback or broader credentials. `refuseCustomerRelease` fail-closes any public/ALLOWED customer-release claim. `keepMediationDisabledPathHonest` records `INVENTED_VAULT_REFUSED` with `MISS-SEC03-OWNER-UNRESOLVED`.

> Sources: `hush-cli/src/sec05/isolation.ts` (`enforceIsolation`, `discloseUse`, `refuseCustomerRelease`, `keepMediationDisabledPathHonest`, `isolationStateFromReceipt`), `hush-cli/tests/sec05/isolation.test.ts`, `hush-cli/tests/fixtures/sec05/`
