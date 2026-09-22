# SEC-03 secret-mediation boundary — experimental, disabled

> `admit(destination, action)` is required before secret materialization or use projection. The adapter is default-off while ownership is unresolved.

## Normative rule

The experimental secret-mediation adapter stays `DISABLED` with blocker `MISS-SEC03-OWNER-UNRESOLVED`. Hush remains the existing vault. Do not invent another vault, enable the adapter, or treat credential hiding as authorization of arbitrary service effects. CON-06 stays `NOT_ACTIVATED`. Zero spend (D08).

> Sources: `.ch5/sec-03-mediation.json`, `hush-cli/src/sec03/mediation.ts`, `docs/SEC-03-MEDIATION.md`

## Implementation

`admit`, `projectUse`, and `materializeUse` fail closed unless destination and action are admitted. Workers receive a local experimental SEC-02 `sec02.use_projection` receipt with `materialPresent: false`; they never receive secret material. Unresolved ownership disables the adapter even if a fixture sets `enabled: true`. `refuseInventedVault` records `INVENTED_VAULT_REFUSED`.

> Sources: `hush-cli/src/sec03/mediation.ts` (`admit`, `projectUse`, `materializeUse`, `requestRawSecret`, `authorizeFromHiddenCredential`, `evaluateMediationAdapter`, `refuseInventedVault`), `hush-cli/tests/sec03/mediation.test.ts`, `hush-cli/tests/fixtures/sec03/`
