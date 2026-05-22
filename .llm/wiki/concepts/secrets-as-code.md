# Concept: Secrets-as-Code

> Encrypted config at rest, no `.env` files, AI-safe management workflow.

## What It Is

Hush treats secrets as **code** — they live in encrypted documents version-controlled alongside the source code, not in untracked `.env` files or external secret managers. This makes the entire configuration graph auditable, diffable, and reproducible.

## Problem Solved

Traditional `.env` approaches have these issues:

| Problem | `.env` files | Hush approach |
|---------|-------------|---------------|
| Plaintext on disk | Yes | Never |
| Git tracking | `.gitignore`d (lost history) | Committed (encrypted) |
| AI visibility | Reads full values | Only masked output |
| Team sharing | Manual/unsafe | Via local age key exchange + committed recipient rules |
| Diff capability | No | `hush diff` with redaction |
| Access control | File permissions only | File-scoped ACLs per document |
| Audit trail | None | Append-only audit log |

## Core Principles

### 1. Everything Encrypted at Rest
All config (secrets AND non-secrets) lives in encrypted documents. There is no plaintext config tier. If a value belongs to the Hush config graph, it is encrypted on disk.

### 2. AI-Safe Inspection
`hush inspect` shows masked values:
```
DATABASE_URL  = pos****://****/app
API_KEY       = sk-****...
NEXT_PUBLIC_API_URL = https://api.example.com  # not sensitive, value shown
```
The `sensitive: true/false` metadata controls redaction. Non-sensitive values (like public API URLs) can be shown in full.

### 3. Prompt-Safe Secret Setting
`hush set KEY` prompts for the value interactively, so the AI assistant never sees the plaintext. For AI agents, `hush set KEY --gui` opens a macOS dialog.

### 4. Runtime Isolation
`hush run -- <command>` is the only way secrets become plaintext, and only in the child process's memory. No `.env` files are written.

## The Safe Loop

For AI assistants working with Hush:
```bash
hush inspect              # See what secrets exist (masked)
hush has DATABASE_URL     # Check if a specific secret exists
hush set DATABASE_URL     # Add/update (prompts for value)
hush run -- npm start     # Run with secrets in memory
```

The AI never reads plaintext `.env` files because none exist. It never echoes secret values because `inspect` masks them. It never writes secrets to disk because `run` uses memory injection.

## No .env Files in the Repository

The repository contains:
- `.hush/manifest.encrypted` — committed
- `.hush/files/**/*.encrypted` — committed
- `.sops.yaml` — committed (public key only)
- No `.env`, no `.env.local`, no `.env.production`

These are tracked by `.gitignore` to prevent accidental commits:
```
.hush/files/**/*.decrypted
*.decrypted
.env
```

## Migration from Legacy

Repositories using v2 (`hush.yaml` + mixed plaintext) can migrate:
```bash
hush migrate --from v2 --dry-run   # Preview
hush migrate --from v2             # Execute
hush migrate --from v2 --cleanup   # Remove old files after validation
```

The migration converts all plaintext and encrypted values into the unified encrypted v3 model.

## Comparison to Other Approaches

| Approach | Encrypted at rest | AI-safe | Diff capability | Team sharing |
|----------|-------------------|---------|-----------------|--------------|
| `.env` + `.gitignore` | No | No (AI reads all) | No | Manual |
| Git-crypt | Yes (files) | No (AI reads decrypted) | No | SSH key mgmt |
| Vault | Yes (server) | Partial (API-based) | Server-side | ACL policies |
| **Hush** | **Yes (SOPS+age)** | **Yes (masked inspect)** | **Yes (`hush diff`)** | **Local age keys** |

> Sources: `README.md` (lines 10-17, 123-132) — AI-safe workflow, no plaintext files; `hush-cli/src/commands/inspect.ts` — masked inspection; `hush-cli/src/commands/run.ts` (lines 34-64) — memory-only runtime; `docs/HUSH_V3_SPEC.md` (lines 148-150, 326-338) — unified encrypted config, threat model; `AGENTS.md` (lines 1-7, 46-52) — non-negotiables: no secrets in commits
