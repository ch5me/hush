---
type: development guide
title: Testing and Change Conventions
description: Hush uses dependency injection through `HushContext`, focused Vitest suites, encrypted fixtures with isolated SOPS setup, and separate packaging/installer verifiers. This page maps high-risk behavior to the smallest useful validation and records conventions that prevent silent security regressions.
tags: [testing, validation, conventions, security]
---

# Testing and Change Conventions

Commands take `ctx: HushContext`; tests provide filesystem, process, exec, SOPS, age, logger, and config adapters. Prefer `mockContext`-style injected contexts over global filesystem/process mocks. Do not add `as any`, `@ts-ignore`, or `@ts-expect-error`. Run tests before commits and build before releases.

## Behavior-to-test map

- **Schema and path invariants:** `hush-cli/tests/v3/schema.test.ts`, `v3/paths.test.ts`, `v3/repository.test.ts`.
- **ACL, imports, precedence, interpolation, conflicts, provenance:** `hush-cli/tests/v3/resolver.test.ts`, `v3/fixtures.test.ts`, and `core/interpolate.test.ts`.
- **Memory-only runtime, private modes, signal cleanup, topology lifecycle:** `runtime-v3.test.ts`, `v3/materialize.test.ts`, `v3/topology-lifecycle.test.ts`.
- **Masking and machine contracts:** `inspect-json.test.ts`, `doctor-json.test.ts`, `status-json.test.ts`, `command-output.test.ts`; verify values never appear in JSON diagnostics. `global-runtime.test.ts` covers target-scoped `has`/`inspect` selection and unknown-target failures.
- **Reader/recipient integrity:** `hush-cli/tests/reader-recipient-drift.test.ts` proves owner-only and healthy files do not false-positive, while drift makes `check` and `doctor` fail with `READER_RECIPIENT_DRIFT` and the expected nonzero behavior.
- **Encryption and key lookup:** `core/sops.test.ts`, `lib/age.test.ts`, `keys.test.ts`; these need SOPS/age and isolated test key setup from `tests/helpers/sops-test.ts`.
- **Migration and legacy boundary:** `migrate.test.ts`, `legacy-command-retirement.test.ts`, `run.test.ts`.
- **Provider and project side effects:** `push.test.ts`, `project-command.test.ts`; assert dry-run does not write and failures are represented without leaking values.
- **Package delivery:** `hush-cli/scripts/verify-pack-install.mjs` checks source and packed installation; `verify-local-install.mjs` checks detached runtime delivery, concurrency, rollback, stale stages, and login-shell publication.

## Validation routing

For a CLI parser or help change, run `bun run cli:test -- cli-help` or the focused Vitest file, then `bun run cli:build`. For resolver/schema changes, run the relevant `tests/v3/*.test.ts` file with SOPS/age available. For runtime cleanup, run materialization/runtime suites. For docs-only changes, run `bun run docs:build`; for a command contract, also run the command test. Before release, use `bun run build`, `bun run type-check`, `bun run cli:test`, `bun run format:check`, and the package/local-install verifiers as applicable.

Repository-wide checks are `bun run test`, `bun run type-check`, `bun run lint`, and `bun run format:check`; root `test` filters all workspaces, though the docs workspace has no test script. Keep complete failure output when diagnosing external-tool or provider failures.

## Sharp edges

Use encrypted fixtures, never real credentials or personal data. `sensitive` is redaction metadata, not an ACL. `user/**` is machine-local and must not become a repository file. `machineLocal` is intentionally required by resolver APIs. `run --json` is unsupported because child stdout is uncontrolled. Provider dry-run and installer rollback are safety contracts; do not weaken them to make tests pass.
