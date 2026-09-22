# INT-06 cross-boundary sentinel suite — experimental, default-off

> Fixture / synthetic sentinel suite only. Live suite against an admitted release combination stays unproved.

## Normative rule

The INT-06 cross-boundary failure and security acceptance gate stays `DISABLED` with `defaultOff: true` and blocker `MISS-INT06-LIVE`. Critical security / identity / no-fallback sentinels covering EXE-02, DEV-07, SEC-05, FF-04, OBS-01, and UI-02 as opaque refs MUST be represented against an admitted **fixture** release combination (`sentinelsRun: complete|incomplete`). An untested boundary MUST narrow the supported claim (`UNTESTED_BOUNDARY_NARROWS`) or block rollout (`ROLLOUT_BLOCKED`). Changing acceptance criteria after the run to hide a failed test MUST return `POST_HOC_CRITERIA_CHANGE_REFUSED`. `live_run` stays `false`, `spend` stays `0`, `customer_release` stays `BLOCKED`, `ready_for_live` stays `blocked_by_D06`. Fake `tok_fx_int06_` tokens only. No npm.ch5.me. Zero spend (D08). CON-06 stays `NOT_ACTIVATED`.

> Sources: `.ch5/int-06-sentinels.json`, `hush-cli/src/int06/sentinels.ts`, `docs/INT-06-SENTINELS.md`

## Implementation

`runSentinelSuite` never contacts prod or npm.ch5.me. Completeness is representation of the six critical sentinels. Missing UI-02 identity coverage is the untested-boundary fixture; a failed SEC-05 no-fallback result stays visible and cannot be dropped from sealed criteria. `refuseLiveRun` fail-closes live/ENABLED/ALLOWED claims on the canonical receipt.

> Sources: `hush-cli/src/int06/sentinels.ts` (`runSentinelSuite`, `refuseLiveRun`, `refuseLiveSuite`, `refusePostHocCriteriaChange`, `criticalSentinelRegistry`, `sentinelStateFromReceipt`), `hush-cli/tests/int06/sentinels.test.ts`, `hush-cli/tests/fixtures/int06/`
