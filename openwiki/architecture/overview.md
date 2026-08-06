---
type: architecture overview
title: Hush Repository Architecture
description: Hush is a Bun and Node monorepo containing the @chriscode/hush encrypted-config CLI and an Astro Starlight documentation site. This page defines the boundary between the shipped package, the docs application, repository-local development services, and external SOPS, age, Cloudflare, Vercel, npm, and Forgejo systems.
tags: [architecture, boundaries, monorepo]
---

# Hush Repository Architecture

Hush is a local, zero-server secrets manager. The shipped product is the `@chriscode/hush` package in `hush-cli/`; it stores repository authority in encrypted SOPS YAML and exposes the `hush` executable. `docs/` is a separate private Astro/Starlight workspace that documents and deploys the product. The root is orchestration: Bun workspaces, lint/format scripts, CI/release configuration, and Grove/Pitchfork service declarations.

## Boundaries and entrypoints

- **CLI product:** `hush-cli/package.json` publishes `bin/hush.js`, `dist`, and `schema.json`; `hush-cli/src/cli.ts` parses arguments and dispatches commands. `hush-cli/src/index.ts` is the package's public import surface.
- **Encrypted repository:** A consumer repository owns `.hush/manifest.encrypted`, `.hush/files/**.encrypted`, and `.sops.yaml`; Hush reads and mutates those files but does not own the consuming application's source or deployment runtime.
- **Documentation:** `docs/astro.config.mjs` configures Starlight at `https://hush.ch5.me`; `docs/wrangler.toml` deploys `docs/dist` to Cloudflare Pages. Docs are not a runtime dependency of the CLI.
- **External tools:** SOPS and age perform cryptography. Wrangler, Vercel HTTP APIs, npm/CH5 Verdaccio, and Forgejo Actions are integration surfaces, not libraries implemented by this repository.
- **Development service:** `pitchfork.toml` declares `docs` and an optional `openwiki` visualizer. Use the repo's `ch5-svc` front door rather than choosing ports manually; see `AGENTS.md`.

```mermaid
flowchart TD
  CLI["hush-cli package"] --> DISPATCH["hush-cli/src/cli.ts"]
  DISPATCH --> V3["v3 resolver and materializer"]
  V3 --> SOPS["SOPS and age"]
  V3 --> REPO["consumer .hush repository"]
  V3 --> CHILD["application child process or artifact"]
  DOCS["docs Astro Starlight"] --> PAGES["Cloudflare Pages"]
  CI["Forgejo workflow"] --> CLI
  CI --> DOCS
```

This map is grounded in `hush-cli/src/cli.ts`, `hush-cli/src/index.ts`, `hush-cli/src/v3/resolver.ts`, `hush-cli/src/v3/materialize.ts`, `docs/astro.config.mjs`, and `.forgejo/workflows/release.yaml`.

## Public surface

The CLI has no server API. Its public contracts are command stdout/stderr/exit codes, `--json` documents for read-only commands, the `hush` binary, and TypeScript exports from `hush-cli/src/index.ts`. Changes to command behavior must update implementation, generated AI skill content from `hush-cli/src/commands/skill.ts`, and user reference docs in `docs/src/content/docs/reference/commands.mdx` together, per `AGENTS.md`.

The package's dependency direction is intentionally one-way: command modules depend on `HushContext`, V3/domain modules, core SOPS/format helpers, and filesystem/provider adapters. Tests inject those dependencies rather than globally mocking process state; see [testing and conventions](../development/testing-and-conventions.md).

## Neighbor boundaries

`README.md` is product-facing onboarding and comparison material; `docs/src/content/docs/` is the maintained full user manual; `.llm/wiki/` is prior internal context used for discovery. This wiki is an independent engineering map and should point to those canonical sources without becoming their replacement. Generated `dist/`, `node_modules/`, screenshots, and fixtures are not architecture ownership.
