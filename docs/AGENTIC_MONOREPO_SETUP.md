# Agentic Monorepo Setup Guide

> Current setup guide for an AI-maintained monorepo that uses the Hush v3 repository model.

This guide no longer uses legacy `hush.yaml`, `hush init`, or `hush encrypt` as the primary architecture. The current model keeps repository authority in encrypted v3 documents under `.hush/` and uses `hush bootstrap`, `hush config`, `hush set`, and `hush run` as the normal workflow.

## Overview

### What you get

| Feature | Description |
|---------|-------------|
| **Hush v3 repository** | Encrypted manifest plus file-scoped ACL documents under `.hush/` |
| **Auto-release** | Every push to main can build, test, publish, tag, and deploy docs |
| **AGENTS.md** | Repo-local contract for AI agents |
| **Local age keys** | Project age keys live under `~/.config/sops/age/keys/` and are backed up outside Hush |
| **Docs site** | Astro Starlight docs deployed from `docs/` |
| **Conventional commits** | Commit types drive release automation |

### Current architecture

```text
your-project/
├── packages/ or apps/          # Your code packages
├── docs/                       # Astro Starlight docs
├── .github/workflows/          # CI and release workflows
├── AGENTS.md                   # AI agent instructions
├── .hush/
│   ├── manifest.encrypted      # Identities, bundles, targets, imports
│   └── files/**/*.encrypted    # File-scoped config and secrets
├── .sops.yaml                  # SOPS creation rules with the public key
└── README.md
```

## Step 1: Create the repo structure

Create the package layout, docs folder, workflow folder, and repo-local `AGENTS.md` that your project needs. The package manager and workspace layout are project-specific. Hush only requires a repository root where `.hush/` and `.sops.yaml` can live.

## Step 2: Install Hush prerequisites

```bash
# macOS
brew install sops age
```

Then add Hush to the repo:

```bash
pnpm add -D @chriscode/hush
```

## Step 3: Bootstrap the v3 repository

```bash
npx hush bootstrap
```

This creates the current repository authority:

- `.hush/manifest.encrypted`
- `.hush/files/env/project/shared.encrypted`
- `.sops.yaml`
- active identity state under the machine state directory

## Step 4: Inspect and update config

Use `hush config` to inspect repository state and update metadata:

```bash
npx hush config show
npx hush config show files
npx hush config active-identity
npx hush config readers env/project/shared --roles owner,ci --identities member-local
```

`hush config readers` updates file-level readers in the encrypted v3 file documents. It is a metadata mutation, not a legacy path-glob ACL workflow.

## Step 5: Add secrets safely

```bash
npx hush set CLOUDFLARE_API_TOKEN
npx hush set CLOUDFLARE_ACCOUNT_ID
```

For local machine overrides, use:

```bash
npx hush set API_KEY --local
```

Secrets stay encrypted at rest in `.hush/files/**.encrypted`. There is no separate `hush encrypt` step in the normal v3 flow.

## Step 6: Run the app with resolved config

```bash
npx hush run -- pnpm dev
npx hush run -- pnpm test
```

`hush run` is the normal runtime path. Hush resolves the active target, decrypts what the active identity can read, and cleans up after the process exits.

## Step 7: CI setup

Store the private key as `SOPS_AGE_KEY` in GitHub secrets. The workflow can then decrypt the v3 repository files under `.hush/` during build and release jobs.

Recommended high-level CI steps:

1. Install dependencies
2. Run build
3. Run tests
4. Run type-check
5. On `main`, publish and deploy after checks pass

## Step 8: Git ignore rules

Keep generated plaintext and local state out of the repo. A typical `.gitignore` should include local materialization output and machine-local state if your tooling creates them.

```gitignore
.hush-materialized/
.machine-state/
.state-root/
```

Do not ignore `.hush/manifest.encrypted`, `.hush/files/**.encrypted`, or `.sops.yaml`. Those are the current source of truth.

## Hush-safe AI workflow

Safe commands for agents:

```bash
hush config show
hush config show files
hush has DATABASE_URL
hush set DATABASE_URL
hush run -- pnpm test
hush keys setup
```

Avoid:

- reading plaintext `.env` files directly
- echoing secret values into logs
- committing materialized outputs
- treating legacy migration commands as the default setup path

## Legacy note

If you are migrating an older repository that still uses `hush.yaml` or legacy encrypted `.env` files, treat that as migration-only work. Use the migration bridge explicitly:

```bash
npx hush migrate --from v2
npx hush migrate --from v2 --cleanup
```

Do not teach the legacy layout as the default setup for new repositories.
