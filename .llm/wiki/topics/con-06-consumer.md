# CON-06 contracts consumer — NOT_ACTIVATED

> Hush is not in the CON-06 import matrix and must not claim `agent-runtime-contracts` integration.

## Normative rule

Hush's CON-06 consumer row is `NOT_ACTIVATED` with `pin: null` and `binding: null`. That is an honest absence, not a deferred pin. Do not invent a binding, add `agent-runtime-contracts`, or enable experimental imports to look activated.

Zero spend (D08). This gate does not change Hush authority, public cutover, or bb wiring beyond the existing SEC-02 sink.

> Sources: `.ch5/mig-01-con-06-consumer.json`, `hush-cli/src/mig01/con-06-consumer.ts`, `docs/CON-06-CONSUMER.md`

## Implementation

The receipt lives at `.ch5/mig-01-con-06-consumer.json`. `refuseIntegratedCon06Claim` fail-closes any integrated/activated claim. Tests scan workspace `package.json` files, `bun.lock`, and `hush-cli/src` import specifiers.

Field vocabulary (`status`, `pin`, `binding`) follows the ch5-company MIG-01 lockfile. Pin and binding types here are `null` only; activated pin/binding shapes are not defined in this repo.

> Sources: `hush-cli/src/mig01/con-06-consumer.ts` (`refuseIntegratedCon06Claim`, `findForbiddenContractDependencies`, `findForbiddenContractImportSpecifiers`), `hush-cli/tests/mig01/con-06-not-activated.test.ts`, `hush-cli/tests/fixtures/mig01/fake-integrated-claim.json`
