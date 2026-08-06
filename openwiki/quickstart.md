---
type: wiki entrypoint
title: Hush Engineering Wiki Quickstart
description: Navigation and task-routing guide for the Hush monorepo. Start here to locate the owning source symbols, focused tests, exact validation commands, runtime state, and safe change boundaries.
tags: [quickstart, navigation, operations]
---

# Hush Engineering Wiki Quickstart

Hush is a local, zero-server encrypted configuration manager. The shipped product is the `@chriscode/hush` CLI in `hush-cli/`; the `docs/` workspace is a separate Astro/Starlight user site. Consumer repositories, not this monorepo, own `.hush/manifest.encrypted`, `.hush/files/**.encrypted`, and `.sops.yaml`. Start with [architecture overview](architecture/overview.md) for boundaries, then use the pages below to route an edit.

## Map

- [Architecture overview](architecture/overview.md) — product boundary, dependencies, public surface, and module diagram.
- [Shipped v3 model](architecture/v3-model.md) — encrypted manifest/file schema, namespaces, ACL units, and current-versus-planning authority.
- [Resolution and materialization](architecture/resolution-and-materialization.md) — ACL filtering, imports, precedence, interpolation, output modes, cleanup, and audit.
- [CLI entrypoints](cli/entrypoints.md) — launcher, parser, command registration, JSON/error contracts, and package exports.
- [Runtime secret injection](cli/runtime.md) — `hush run`, child process environment, Node pinning, Wrangler conflicts, and memory-only cleanup.
- [Configuration and keys](cli/configuration-and-keys.md) — project/global discovery, state paths, active identities, SOPS/age lookup, and environment controls.
- [Commands and migrations](cli/commands-and-migrations.md) — bootstrap, mutation/inspection, v2 bridge, Cloudflare/Vercel push, and project synchronization.
- [Build/test/release](operations/build-test-release.md) — exact Bun commands, CI gates, package release, docs deploy, and missing script sharp edges.
- [Detached local install](operations/local-install.md) — runtime staging, login shell publication, rollback, and installer verification.
- [Documentation site](docs/site.md) — Astro/Starlight composition, content ownership, sync boundary, and Cloudflare Pages.
- [Testing and conventions](development/testing-and-conventions.md) — DI, behavior-to-test map, focused validation, and security-sensitive invariants.

## Task routing

| Intent | Canonical page | Owning source and focused test | Minimal validation |
|---|---|---|---|
| Add/change a CLI command | [CLI entrypoints](cli/entrypoints.md) and [commands](cli/commands-and-migrations.md) | `hush-cli/src/cli.ts`, `hush-cli/src/commands/`, `hush-cli/src/commands/skill.ts`; `hush-cli/tests/cli-help.test.ts` plus command suite | `bun run cli:test` and `bun run cli:build` |
| Change v3 schema or repository layout | [V3 model](architecture/v3-model.md) | `hush-cli/src/v3/schema.ts`, `domain.ts`, `repository.ts`; `hush-cli/tests/v3/schema.test.ts`, `repository.test.ts` | focused `bun x vitest run tests/v3/schema.test.ts` from `hush-cli` |
| Change ACL, imports, precedence, interpolation | [Resolution](architecture/resolution-and-materialization.md) | `hush-cli/src/v3/resolver.ts`, `imports.ts`, `interpolation.ts`; `hush-cli/tests/v3/resolver.test.ts`, `fixtures.test.ts` | focused resolver/fixture tests |
| Change `hush run` behavior | [Runtime](cli/runtime.md) | `hush-cli/src/commands/run.ts`, `hush-cli/src/v3/materialize.ts`; `hush-cli/tests/run.test.ts`, `runtime-v3.test.ts` | focused runtime tests, then `bun run cli:build` |
| Change root/global state or keys | [Configuration and keys](cli/configuration-and-keys.md) | `hush-cli/src/config/loader.ts`, `store.ts`, `v3/state.ts`, `core/sops.ts`; project/global/keys tests | `bun run cli:test` with `sops` and `age` available |
| Change provider push or stage sync | [Commands and migrations](cli/commands-and-migrations.md) | `hush-cli/src/commands/push.ts`, `project.ts`; `hush-cli/tests/push.test.ts`, `project-command.test.ts` | focused provider tests; use dry-run for side effects |
| Change docs content or navigation | [Documentation site](docs/site.md) | `docs/astro.config.mjs`, `docs/src/content.config.ts`, `docs/src/content/docs/`; docs build | `bun run docs:build` |
| Change packaging or local `hush` delivery | [Build/release](operations/build-test-release.md) and [local install](operations/local-install.md) | `hush-cli/package.json`, `scripts/install-local.mjs`; pack/local verifiers | `bun run --filter @chriscode/hush verify:pack-install` or `bun run cli:verify-local-install` |
| Prepare a release | [Build/test/release](operations/build-test-release.md) | `.forgejo/workflows/release.yaml`, `hush-cli/package.json`; CI workflow | `bun run build`, `bun run type-check`, `bun run cli:test`, package verifier |

## First commands

Use Node `>=24 <25`, Bun `1.3.14`, and install dependencies with `bun install --frozen-lockfile`. Install `sops` and `age` for encrypted fixture/runtime work. Run the docs service through `ch5-svc up` rather than guessing ports; `AGENTS.md` is the repo-local operating contract.

For the CLI, `node hush-cli/bin/hush.js --help` shows the command surface. A consumer starts with `hush bootstrap`, inspects using `hush config show` or `hush inspect`, and runs an application with `hush run -- <command>`. Never use secret values as test fixtures or include them in logs, wiki pages, commits, or command examples.

## Non-obvious invariants

- `hush run` resolves v3 only, injects values into memory, and cleans temporary state on exit or signal; it is not a sandbox against a child that can inspect its own environment.
- `user/**` is machine-local override storage; repository files must not claim it. `machineLocal` is explicit in resolver APIs.
- `sensitive` controls redaction/projection, not encryption or ACL authorization.
- A CLI command change must update implementation, AI skill docs, and `docs/src/content/docs/reference/commands.mdx` together.
- Prefer injected `HushContext` in tests; do not add `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Do not expose credentials. CI uses secret names such as `SOPS_AGE_KEY` and `NPM_TOKEN`; this wiki documents topology and commands only.

## Backlog

No source-grounded documentation backlog remains for the requested scope. Generated artifacts, `node_modules`, screenshots, fixtures, and transient handoffs are intentionally excluded from the main concept set.
