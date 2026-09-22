# STO-05 scoped deletion and recovery

Hush's scoped deletion/recovery gate is **experimental**, **default-off**, and **disabled**. Complete wipe is unproved (`MISS-STO05-COMPLETE-WIPE-UNPROVED`). This change does not perform live deletion, authorize blanket delete, run legacy migration, invent a complete wipe, activate customers, or spend.

## Receipt

Machine-readable copy: `.ch5/sto-05-deletion.json`

| Field | Value |
| --- | --- |
| Program / ids | ELF-CH5 `STO-05-IMPL-01` / `MISS-STO05-COMPLETE-WIPE-UNPROVED` |
| Task | STO-05 |
| Gate | `scoped-deletion-recovery` |
| Status | `DISABLED` |
| Experimental | `true` (default-off) |
| Enabled | `false` |
| Spend | `0` (D08) |
| CON-06 | `NOT_ACTIVATED` |
| Customer release | `BLOCKED` (SEC-05) |
| Complete wipe | `false` |
| Live delete | `false` |
| Blanket delete | `false` |
| Legacy migration | `false` |
| `verifiedStores` | `[]` |
| `outstandingCopies` | `[]` |
| `externalEffectsNotErased` | `[]` |
| `independentExportsNotClaimed` | `[]` |
| Blocker | `MISS-STO05-COMPLETE-WIPE-UNPROVED` |

Gaps always listed: `MISS-STO05-COMPLETE-WIPE-UNPROVED`, `MISS-STO05-OUTSTANDING-COPIES-UNERASED`, `MISS-STO05-EXTERNAL-EFFECTS-UNERASED`, `MISS-STO05-INDEPENDENT-EXPORTS-UNERASED`. SEC-05 isolation remains unproved (`MISS-SEC05-ISOLATION-UNPROVED`). SEC-03 ownership remains unresolved.

## Gate

`issueScopedDeletion` emits a scoped deletion receipt that lists `verifiedStores[]` and `outstandingCopies[]` honestly. Independent user exports stay in `independentExportsNotClaimed[]` (`claimedErased: false`). Already-completed external effects stay in `externalEffectsNotErased[]` (`erased: false`). `issueScopedRecovery` recovers only verified in-scope stores. Blanket delete and legacy migration claims return `BLANKET_DELETE_REFUSED` and `LEGACY_MIGRATION_REFUSED`. Live deletes and real filesystem paths are refused. Fake `fixture://sto05/` paths only. Tenant/owner scope composes SEC-05: out-of-scope stores are outstanding copies, not verified.

Symbols: `issueScopedDeletion`, `issueScopedRecovery`, `refuseCompleteWipe`, `refuseBlanketDelete`, `refuseLegacyMigration`, `refuseLiveDelete`, `deletionStateFromReceipt`.

## Fixtures (fake paths only)

| Id | Property |
| --- | --- |
| `FX-STO05-honest-deletion-receipt` | Deletion receipts list verified stores and outstanding copies honestly; recovery is scoped to verified stores |
| `FX-STO05-no-erase-exports-promise` | No promise is made to erase independent user exports or already-completed external effects |
| `FX-STO05-blanket-delete-refused` | Blanket deletion and legacy migration claims are refused |

## Out of scope

No live deletion, broad migration, invented complete wipe, customer release, spend, CON-06 activation, npm.ch5.me peer fetch, or real filesystem deletes.
