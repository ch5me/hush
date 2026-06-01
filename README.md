# @chriscode/hush

> **The AI-native secrets manager.** Secrets stay encrypted at rest. AI can help without seeing values.

[![npm](https://img.shields.io/npm/v/@chriscode/hush)](https://www.npmjs.com/package/@chriscode/hush)
[![Documentation](https://img.shields.io/badge/docs-hush--docs.pages.dev-blue)](https://hush-docs.pages.dev)

<img src="./hero.webp" alt="Hush - AI-native secrets manager" style="width: 100%; max-width: 1200px; height: auto; border-radius: 8px; margin: 1.5rem 0;">

Hush stores project authority in encrypted v3 repository documents. The current model is simple:

- `.hush/manifest.encrypted` defines identities, bundles, targets, and imports
- `.hush/files/**.encrypted` stores the actual secret entries and file-level readers
- `hush run -- <command>` is the normal runtime path

There are no plaintext secret files to teach an AI assistant to avoid. Hush decrypts only for the active process or materialized target, then cleans up.

**[Read the full documentation →](https://hush-docs.pages.dev)**

## Install

```bash
pnpm add -D @chriscode/hush
# or
npm install -D @chriscode/hush
```

### Prerequisites

```bash
brew install sops age
```

## Quick start

### 1. Bootstrap a v3 repository

```bash
npx hush bootstrap
```

That creates the encrypted repository shell, sets up keys, and writes the first v3 files:

```text
.hush/manifest.encrypted
.hush/files/env/project/shared.encrypted
```

### 2. Inspect the current config

```bash
npx hush config show
npx hush config active-identity
```

Use `hush config` to inspect repository state and update file readers.

### 3. Add secrets safely

```bash
npx hush set DATABASE_URL
npx hush set API_KEY --gui
```

`hush set` prompts for the value when needed, so the assistant never sees it.

### 4. Run your app

```bash
npx hush run -- npm start
npx hush run -e prod -- npm build
```

This is the normal runtime path. Hush decrypts to memory and passes values to the command.

## Current v3 repository model

Hush v3 keeps repository authority in encrypted YAML documents under `.hush/`.

| File | Purpose |
|------|---------|
| `.hush/manifest.encrypted` | Repository metadata, identities, bundles, targets, and imports |
| `.hush/files/**.encrypted` | Secret entries plus readers for each encrypted file |
| `.sops.yaml` | SOPS creation rules with the project public key |

`hush bootstrap` creates the shell. `hush config` inspects or updates it. `hush run` is how you use it day to day.

## Core commands

| Command | What it does |
|---------|---------------|
| `hush bootstrap` | Create the v3 repository shell and initial active identity |
| `hush config show [section]` | Show manifest, files, identities, targets, imports, or state |
| `hush config active-identity [name]` | Show or change the active identity |
| `hush config readers <file-path> --roles <csv>` | Update file readers |
| `hush set <KEY>` | Add or update one secret safely |
| `hush delete-key <KEY> --from <file>` | Remove a secret from an encrypted file |
| `hush copy-key <KEY>` | Copy one key between encrypted v3 files |
| `hush move-key <KEY>` | Move one key between encrypted v3 files |
| `hush edit [file]` | Edit all secrets in an editor |
| `hush inspect` | List secret names with masked values |
| `hush has <KEY>` | Check whether a secret exists |
| `hush run -- <command>` | Run with secrets in memory |
| `hush materialize` | Write secrets to files for CI/tooling |
| `hush push` | Push a target to Cloudflare |
| `hush keys setup` | Verify the local project key |
| `hush doctor` | Diagnose root, key, and store resolution |
| `hush skill` | Install the AI skill |

## Legacy v2 migration

If a repository still uses the old v2 layout, use the migration bridge:

```bash
npx hush migrate --from v2
npx hush migrate --from v2 --cleanup
```

That is the supported bridge from legacy repositories to the current v3 model.

## AI-safe workflow

For AI assistants, the safe loop is:

```bash
npx hush inspect
npx hush has DATABASE_URL
npx hush set DATABASE_URL
npx hush run -- npm start
```

You can also install the shipped skill:

```bash
npx hush skill
npx hush skill --global
npx hush skill --local
```

## Example workflow

```bash
# bootstrap the repo once
hush bootstrap

# inspect config and identities
hush config show
hush config active-identity owner-local

# add secrets
hush set DATABASE_URL
hush set STRIPE_SECRET_KEY

# run the app
hush run -- npm start
```

## Team setup

Copy the project age key into `~/.config/sops/age/keys/{project}.txt`. Hush auto-matches that file against the repo `.sops.yaml` recipient, or you can force it explicitly with `SOPS_AGE_KEY_FILE`. Then verify with:

```bash
hush config show state
```

## Troubleshooting

### SOPS or age is missing

```bash
brew install sops age
```

### The key does not match this repository

Run:

```bash
hush keys setup
```

### You need to convert a legacy repo

Run:

```bash
hush migrate --from v2
```

Add `--cleanup` after you validate the migrated state.

## License

MIT
