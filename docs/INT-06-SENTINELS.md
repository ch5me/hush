# INT-06 cross-boundary failure and security acceptance

Hush's INT-06 sentinel suite is **experimental**, **default-off**, and **disabled**. It is a fixture / synthetic sentinel run only. Live suite against an admitted production release combination is unproved (`MISS-INT06-LIVE`). This change does not run a live suite, hide failures, invent green, activate MIG, customer-release, or spend.

## Receipt

Machine-readable copy: `.ch5/int-06-sentinels.json`

| Field | Value |
| --- | --- |
| Program / ids | ELF-CH5 `INT-06-IMPL-01` / `MISS-INT06-LIVE` |
| Task | INT-06 |
| Gate | `cross-boundary-failure-security-acceptance` |
| Status | `DISABLED` |
| Experimental | `true` (default-off) |
| Enabled | `false` |
| Spend | `0` (D08) |
| CON-06 | `NOT_ACTIVATED` |
| Customer release | `BLOCKED` (SEC-05) |
| `live_run` | `false` |
| `ready_for_live` | `blocked_by_D06` |
| `sentinelsRun` | `complete` (fixture representation) |
| Opaque refs | EXE-02, DEV-07, SEC-05, FF-04, OBS-01, UI-02 |
| Blocker | `MISS-INT06-LIVE` |

Gaps always listed: `MISS-INT06-LIVE`. STO-05 complete wipe remains unproved. SEC-05 isolation remains unproved. SEC-03 ownership remains unresolved.

## Gate

`runSentinelSuite` evaluates critical security / identity / no-fallback sentinels against an admitted **fixture** release combination. Peer tasks are opaque refs only. `sentinelsRun` is `complete` when every critical sentinel is represented, otherwise `incomplete`. An untested required boundary returns `UNTESTED_BOUNDARY_NARROWS` (supported claim drops that boundary) or `ROLLOUT_BLOCKED`. Acceptance criteria are sealed with the run; changing them afterward to hide a failed sentinel returns `POST_HOC_CRITERIA_CHANGE_REFUSED`. Live runs, npm.ch5.me, real tokens, invented green, and customer-release ALLOWED claims are refused. Fake `tok_fx_int06_` tokens only.

Symbols: `runSentinelSuite`, `refuseLiveRun`, `refuseLiveSuite`, `refusePostHocCriteriaChange`, `criticalSentinelRegistry`, `sentinelStateFromReceipt`.

## Sentinel registry (opaque refs)

| Id | Category | Opaque ref | Boundary |
| --- | --- | --- | --- |
| `SEN-INT06-EXE02-NO-FALLBACK` | no-fallback | EXE-02 | `execution-identity-no-fallback` |
| `SEN-INT06-DEV07-IDENTITY` | identity | DEV-07 | `developer-identity-binding` |
| `SEN-INT06-SEC05-NO-FALLBACK` | no-fallback | SEC-05 | `auth-fail-no-fallback` |
| `SEN-INT06-FF04-SECURITY` | security | FF-04 | `feature-flag-fail-closed` |
| `SEN-INT06-OBS01-SECURITY` | security | OBS-01 | `observability-no-secret-leak` |
| `SEN-INT06-UI02-IDENTITY` | identity | UI-02 | `ui-identity-presentation` |

## Fixtures (fake tokens only)

| Id | Property |
| --- | --- |
| `FX-INT06-sentinels-complete` | All critical sentinels are represented against an admitted fixture combination (`sentinelsRun: complete`); live stays blocked |
| `FX-INT06-untested-boundary-narrows` | An untested boundary narrows the supported claim (`UNTESTED_BOUNDARY_NARROWS`) or blocks rollout (`ROLLOUT_BLOCKED`) |
| `FX-INT06-no-post-hoc-criteria` | Changing acceptance criteria after the run to hide a failed sentinel is refused (`POST_HOC_CRITERIA_CHANGE_REFUSED`) |

## Out of scope

No live suite against prod, no admitted live release combination, no hidden failures, no invented green, no MIG activation, no customer release, no spend, no CON-06 activation, no npm.ch5.me peer fetch, no live credentials.
