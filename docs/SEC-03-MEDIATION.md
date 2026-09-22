# SEC-03 secret-mediation boundary

Hush's experimental secret-mediation adapter is **default-off** and **disabled**. Ownership of a mediation adapter distinct from the existing Hush vault is unresolved (`MISS-SEC03-OWNER-UNRESOLVED`). This change does not invent another vault, activate CON-06, spend, or cut over public `hush run` materialization.

## Receipt

Machine-readable copy: `.ch5/sec-03-mediation.json`

| Field | Value |
| --- | --- |
| Program / ids | ELF-CH5 `SEC-03-IMPL-01` / `MISS-SEC03-OWNER-UNRESOLVED` |
| Task | SEC-03 |
| Adapter | `secret-mediation` |
| Status | `DISABLED` |
| Experimental | `true` (default-off) |
| Enabled | `false` |
| Spend | `0` (D08) |
| CON-06 | `NOT_ACTIVATED` |
| Ownership | `unresolved` |
| Blocker | `MISS-SEC03-OWNER-UNRESOLVED` |

## Gate

`admit(destination, action)` is required before any secret materialization or use projection. Workers and adversaries never receive secret material. A successful admit yields a local experimental SEC-02 `sec02.use_projection` receipt (`materialPresent: false`). Credential hiding is confidentiality, not authorization of arbitrary service effects.

Symbols: `admit`, `projectUse`, `materializeUse`, `requestRawSecret`, `authorizeFromHiddenCredential`, `evaluateMediationAdapter`, `refuseInventedVault`.

## Fixtures (fake tokens only)

| Id | Property |
| --- | --- |
| `FX-SEC03-adversary-no-secret` | Adversary cannot obtain the secret or use it outside an admitted destination/action |
| `FX-SEC03-hide-not-authorize` | Hiding a credential does not authorize arbitrary service effects |
| `FX-SEC03-unresolved-owner-disabled` | Unresolved ownership keeps the adapter disabled; invented vaults are refused |

## Out of scope

No new vault product, spend, CON-06 activation, npm.ch5.me peer fetch, or live cloud credentials. Shipped `hush run` injection is unchanged while this adapter remains disabled.
