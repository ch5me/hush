# Hush — Context

> AI-native secrets manager. Start here before working with the codebase.

## Agent Start

Hush is a CLI (`@chriscode/hush`) that manages encrypted configuration. It replaces `.env` files with SOPS+age-encrypted documents. The CLI handles key management, secret CRUD, runtime injection, and deployment targets.

**Core invariant**: No plaintext secrets ever touch disk during `hush run`. Secrets are decrypted in memory, injected into the child process environment, and cleaned up on exit or signal.

**Local install delivery invariant**: `scripts/install-local.mjs` proves bare `hush` from a cold login shell with only the system PATH inherited. On zsh, it owns a marked block in `~/.zlogin` that puts the installed bin directory first after all other startup files; a failed delivery check rolls that edit back. Do not hand-edit this block.

**Release migration invariant**: Forgejo public release jobs must not guess missing authority. If `NPM_TOKEN` is absent, skip npm publish/tag/release/binary fanout and warn; public npm ownership is a deliberate product/security decision. If `SOPS_AGE_KEY` is absent, skip docs deploy and warn; docs deploy still uses Hush to inject Cloudflare secrets once the age key is present.

**Repository layout**:
```
hush/
├── hush-cli/           # CLI source (TypeScript, Bun)
│   ├── src/commands/   # Command implementations
│   ├── src/v3/         # V3 engine (resolver, domain, materialize)
│   ├── src/core/       # Core primitives (SOPS wrapper)
│   ├── src/lib/        # Infrastructure (age, fs)
│   ├── src/formats/    # Output formatters (dotenv, wrangler, json)
│   └── src/config/     # Config loader
├── docs/               # Astro Starlight documentation site
├── .hush/              # Encrypted repo documents (per-project usage)
└── .sops.yaml          # SOPS creation rules with age public key
```

## Tasks

| If you want to... | Read this file |
|-------------------|----------------|
| Understand how `hush run -- <command>` injects secrets | [topics/runtime-execution.md](./topics/runtime-execution.md) |
| Understand how encryption/decryption works | [topics/secret-encryption.md](./topics/secret-encryption.md) |
| Understand the manifest, files, bundles, targets | [topics/v3-repository-model.md](./topics/v3-repository-model.md) |
| Understand how a bundle resolves into key-value pairs | [topics/secrets-resolution-engine.md](./topics/secrets-resolution-engine.md) |
| Understand who can read which secrets | [topics/identity-based-access-control.md](./topics/identity-based-access-control.md) |
| Understand how local age keys are discovered and managed | [topics/age-key-management.md](./topics/age-key-management.md) |
| Understand the `.encrypted` file structure | [concepts/encrypted-file-format.md](./concepts/encrypted-file-format.md) |
| Understand how targets receive specific secrets | [concepts/target-isolation.md](./concepts/target-isolation.md) |
| Understand why no `.env` files exist | [concepts/secrets-as-code.md](./concepts/secrets-as-code.md) |
| Add a new CLI command | `hush-cli/src/cli.ts` (+ register command, update skill + docs per `AGENTS.md`) |
| Modify resolution logic | `hush-cli/src/v3/resolver.ts` |
| Modify domain types | `hush-cli/src/v3/domain.ts` |
| Modify SOPS encryption behavior | `hush-cli/src/core/sops.ts` |
| Modify key management | `hush-cli/src/commands/keys.ts` |
| Understand bootstrap behavior (nested repos, plan preview) | [topics/bootstrap-behavior.md](./topics/bootstrap-behavior.md) |
| Diagnose root/key resolution issues | `hush-cli/src/commands/doctor.ts` |
| Understand the full V3 architecture spec | `docs/HUSH_V3_SPEC.md` |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        HUSH CLI                                 │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Commands │  │   V3     │  │  Core    │  │   Lib          │  │
│  │ (run,    │→│ Engine   │→│ (SOPS)   │  │ (age, fs)      │  │
│  │ set,     │  │ (resolver│  │ encrypt/ │  │                │  │
│  │ keys...) │  │ ,domain, │  │ decrypt) │  │                │  │
│  │          │  │ material)│  │          │  │                │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────────┘  │
│       │              │                                          │
│       ▼              ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Dependency Injection (HushContext)           │    │
│  │  All commands receive ctx: HushContext for fs, exec,     │    │
  │  │  config loading. Enables testing with mock contexts       │    │
│  │  with mock contexts without global mocks.                │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   V3 ENCRYPTED REPOSITORY                        │
│                                                                 │
│  .hush/manifest.encrypted    Identities, bundles, targets, idx  │
│  .hush/files/*.encrypted     Encrypted config documents         │
│  .sops.yaml                  SOPS creation rules (public key)   │
└─────────────────────────────────────────────────────────────────┘
```

### Six Primitives (from `docs/HUSH_V3_SPEC.md`)

| Primitive | Role |
|-----------|------|
| **Identity** | Named actor (human, CI, automation) with roles |
| **File** | Encrypted config document; smallest ACL unit |
| **Path** | Logical address inside config tree (e.g., `env/apps/web/API_URL`) |
| **Bundle** | Organizational grouping of files + imports for runtime composition |
| **Target** | Named consumer surface (process, deploy, export) |
| **Artifact** | First-class materialized output (dotenv file, cert, binary) |

### Resolution Flow

1. **Resolve active identity** — from manifest pointer or machine-local context
2. **Collect bundle candidates** — files referenced by bundle + imports
3. **Partition by readability** — check file-scoped ACLs against identity roles
4. **Select winning candidates** — by precedence (local > imported by default)
5. **Interpolate** — resolve `${ref}` placeholders across the logical graph
6. **Split** — values vs artifacts
7. **Materialize** — shape output for target format and inject into child process

### Key Design Decisions

- **File-scoped ACLs only** — no path-glob readers, no per-path ACLs
- **No plaintext tier** — all config (secrets and non-secrets) lives encrypted at rest
- **Sensitive metadata** — `sensitive: true/false` controls redaction in inspection/diff/exports, never encryption or ACL behavior
- **Memory-only runtime** — `hush run` never writes plaintext to disk
- **Signal-safe cleanup** — temporary files cleaned up on normal exit AND interruption
- **Dependency Injection** — all commands use `HushContext`, enabling testability
