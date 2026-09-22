# CON-06 consumer status (MIG-01)

Hush is **not** a CON-06 `agent-runtime-contracts` consumer.

## Receipt

Machine-readable copy: `.ch5/mig-01-con-06-consumer.json`

| Field | Value |
| --- | --- |
| Program / ids | ELF-CH5 `MIG-01-IMPL-04` / `MISS-MIG01-08` |
| Matrix | CON-06 |
| Status | `NOT_ACTIVATED` |
| Pin | `null` |
| Binding | `null` |
| Spend | `0` (D08) |
| Import matrix | not present |
| Experimental imports | disabled |

Vocabulary matches the ch5-company MIG-01 lockfile (`status`, `pin`, `binding`). This receipt does not invent a pin, a binding, or an activation row.

## Why

Hush is absent from the CON-06 import matrix. It is not an experimental contracts consumer. Recording `NOT_ACTIVATED` with `pin: null` / `binding: null` is the honest state. Claiming integration would be false.

## Gate

`hush-cli/src/mig01/con-06-consumer.ts` is fail-closed:

- a status other than `NOT_ACTIVATED` is refused
- a non-null `pin` or `binding` is refused
- enabling `inImportMatrix` or `experimentalImports` is refused
- adding an `agent-runtime-contracts` dependency or import is refused by `hush-cli/tests/mig01/con-06-not-activated.test.ts`

Do not add an `agent-runtime-contracts` dependency. Do not enable experimental imports. Do not mint a binding for Hush.

## Out of scope

This receipt does not change Hush authority, spend, public cutover, or any bb wire beyond the existing SEC-02 sink.
