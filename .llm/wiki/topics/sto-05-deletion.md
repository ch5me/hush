# STO-05 scoped deletion and recovery — experimental, default-off

> Scoped deletion receipts list verified stores and outstanding copies honestly. Complete wipe, live delete, blanket delete, and legacy migration stay refused.

## Normative rule

The scoped deletion/recovery gate stays `DISABLED` with `defaultOff: true` and blocker `MISS-STO05-COMPLETE-WIPE-UNPROVED`. Deletion receipts MUST list `verifiedStores[]` and `outstandingCopies[]` honestly. They MUST NOT promise to erase independent user exports (`independentExportsNotClaimed[]`) or already-completed external effects (`externalEffectsNotErased[]`). Blanket delete returns `BLANKET_DELETE_REFUSED`. Legacy migration returns `LEGACY_MIGRATION_REFUSED`. Recovery is scoped to verified in-scope stores only. Compose SEC-05 tenant/owner scope; customer release stays `BLOCKED`. Fake `fixture://sto05/` paths only. Zero spend (D08). CON-06 stays `NOT_ACTIVATED`.

> Sources: `.ch5/sto-05-deletion.json`, `hush-cli/src/sto05/deletion.ts`, `docs/STO-05-DELETION.md`

## Implementation

`issueScopedDeletion` never deletes. In-scope verified fake-path stores are listed as `verified: true`; unverified replicas, machine-local copies, and cross-tenant/cross-owner stores are outstanding. `issueScopedRecovery` sets `recoveredStoreIds` from verified stores only (`completeRestore: false`). `refuseCompleteWipe` fail-closes enabled/complete-wipe/blanket/legacy claims on the canonical receipt. `refuseLiveDelete` records `LIVE_DELETE_REFUSED`.

> Sources: `hush-cli/src/sto05/deletion.ts` (`issueScopedDeletion`, `issueScopedRecovery`, `refuseCompleteWipe`, `refuseBlanketDelete`, `refuseLegacyMigration`, `refuseLiveDelete`, `deletionStateFromReceipt`), `hush-cli/tests/sto05/deletion.test.ts`, `hush-cli/tests/fixtures/sto05/`
