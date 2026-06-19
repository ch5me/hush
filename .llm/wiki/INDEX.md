# Hush — LLM Wiki Index

> AI-native secrets manager. Encrypted-at-rest hierarchical config with file-scoped ACLs.

**Package**: `@chriscode/hush`
**Repository**: https://git.ch5.me/ch5/hush
**Tech**: TypeScript, SOPS+age encryption, local age key workflow, Cloudflare Workers deploy

## Structure

| File | Description |
|------|-------------|
| [CONTEXT.md](./CONTEXT.md) | Start Here, task-based quick-start, architecture overview |
| [public-release-audit-2026-06.md](./public-release-audit-2026-06.md) | Pre-publication adversarial audit: P0 blockers, P1/P2 fixes, refuted findings |
| [schema.md](./schema.md) | Writing rules — normative vs implementation separation |
| [topics/secret-encryption.md](./topics/secret-encryption.md) | SOPS+age wrapper, encrypted file format |
| [topics/v3-repository-model.md](./topics/v3-repository-model.md) | Encrypted document system, manifest, file documents |
| [topics/secrets-resolution-engine.md](./topics/secrets-resolution-engine.md) | resolveV3Bundle, interpolation, conflict detection |
| [topics/identity-based-access-control.md](./topics/identity-based-access-control.md) | File-scoped ACLs, reader roles |
| [topics/age-key-management.md](./topics/age-key-management.md) | Local age key discovery, generation, and verification |
| [topics/vendor-catalog.md](./topics/vendor-catalog.md) | Third-party vendor integrations: OAuth apps, API keys, GitHub OAuth + GitHub Apps |
| [topics/runtime-execution.md](./topics/runtime-execution.md) | Memory-only secret injection, signal-safe cleanup |
| [concepts/encrypted-file-format.md](./concepts/encrypted-file-format.md) | SOPS-encrypted YAML, no plaintext at rest |
| [concepts/target-isolation.md](./concepts/target-isolation.md) | Named consumers receive only bundle-defined secrets |
| [concepts/secrets-as-code.md](./concepts/secrets-as-code.md) | Encrypted config at rest, no .env files, AI-safe management |

## Source Files Referenced

Key source files grounding this entire wiki:

- `hush-cli/src/cli.ts` — CLI entry point, argument parsing, command routing
- `hush-cli/src/v3/resolver.ts` — Bundle and target resolution engine
- `hush-cli/src/v3/domain.ts` — Domain types: Identity, File, Bundle, Target, Readers
- `hush-cli/src/v3/schema.ts` — Config namespace validation, reserved paths
- `hush-cli/src/v3/interpolation.ts` — Variable interpolation engine
- `hush-cli/src/v3/imports.ts` — Cross-bundle and cross-project imports
- `hush-cli/src/v3/materialize.ts` — Artifact materialization (env, dotenv, etc.)
- `hush-cli/src/v3/repository.ts` — V3 repository loading and parsing
- `hush-cli/src/v3/audit.ts` — Local activity log (best-effort; not tamper-evident)
- `hush-cli/src/core/sops.ts` — SOPS encrypt/decrypt wrapper
- `hush-cli/src/commands/run.ts` — Runtime command execution
- `hush-cli/src/commands/keys.ts` — Key management (setup, generate, pull, push, list)
- `hush-cli/src/commands/set.ts` — Secret creation
- `hush-cli/src/commands/bootstrap.ts` — V3 repo initialization
- `hush-cli/src/commands/migrate.ts` — V2-to-V3 migration
- `hush-cli/src/lib/age.ts` — Age key management
- `hush-cli/src/types.ts` — Central type definitions
- `hush-cli/src/context.ts` — Dependency injection context
- `docs/HUSH_V3_SPEC.md` — Canonical architecture specification
