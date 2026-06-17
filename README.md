# @chriscode/hush

> **The AI-native secrets manager.** Secrets stay encrypted at rest. AI can help without seeing values.

[![npm](https://img.shields.io/npm/v/@chriscode/hush)](https://www.npmjs.com/package/@chriscode/hush)
[![Documentation](https://img.shields.io/badge/docs-hush.ch5.me-blue)](https://hush.ch5.me)

<img src="./hero.webp" alt="Hush - AI-native secrets manager" style="width: 100%; max-width: 1200px; height: auto; border-radius: 8px; margin: 1.5rem 0;">

Hush stores project authority in encrypted v3 repository documents. The current model is simple:

- `.hush/manifest.encrypted` defines identities, bundles, targets, and imports
- `.hush/files/**.encrypted` stores the actual secret entries and file-level readers
- `hush run -- <command>` is the normal runtime path

There are no plaintext secret files to teach an AI assistant to avoid. Hush decrypts only for the active process or materialized target, then cleans up.

**[Read the full documentation →](https://hush.ch5.me)**

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
npx @chriscode/hush bootstrap
```

That creates the encrypted repository shell, sets up keys, and writes the first v3 files:

```text
.hush/manifest.encrypted
.hush/files/env/project/shared.encrypted
```

### 2. Inspect the current config

```bash
npx @chriscode/hush config show
npx @chriscode/hush config active-identity
```

Use `hush config` to inspect repository state and update file readers.

### 3. Add secrets safely

```bash
npx @chriscode/hush set DATABASE_URL
npx @chriscode/hush set API_KEY --gui
```

`hush set` prompts for the value when needed, so the assistant never sees it.

### 4. Run your app

```bash
npx @chriscode/hush run -- npm start
npx @chriscode/hush run --target prod -- npm build
```

This is the normal runtime path. Hush decrypts to memory and passes values to the command.

## Why Hush?

**Short answer:** Hush adds structured identity/ACL, agent-safe commands, provenance, and AI skill packaging on top of raw sops+age.

| Tool | Encrypted at rest | Per-file ACLs | Agent-safe commands | Local/zero-server |
|------|:-----------------:|:-------------:|:-------------------:|:-----------------:|
| **Hush** | yes | yes | yes (`inspect`, `has`, `set`, `--gui`) | yes |
| raw sops+age | yes | manual | no | yes |
| dotenvx | yes (in repo) | no | values flow through agent context | yes |
| Doppler / Infisical | yes | yes | partial | no (SaaS) |

- **vs raw sops+age**: If you just need encrypted env files, raw sops works fine. Hush adds per-file reader ACLs, identity/bundle/target resolution, provenance/trace, AI-agent skill packaging, and `--gui` value isolation so a human types the secret and the agent never sees it.
- **vs dotenvx**: dotenvx encrypts `.env` files in the repo, but values still flow through the agent's context when the agent edits or reads them. Hush keeps values out of the agent surface entirely.
- **vs Doppler/Infisical**: Both are excellent SaaS options. Hush is local and zero-server — no cloud dependency, no SaaS account required.

## Security

Hush delegates all cryptographic operations to [sops](https://github.com/getsops/sops) and [age](https://github.com/FiloSottile/age). No home-rolled crypto. Hush itself is a single-maintainer project and has not yet been externally audited — use it accordingly and report issues via [SECURITY.md](./SECURITY.md).

**Threat model in brief:** Hush removes standing plaintext secret files and narrows the surface through which an agent can accidentally expose values. However, an agent that can execute arbitrary commands (`hush run -- env`) can still read injected values at runtime. Hush's protections for AI workflows are guardrails and auditability, not a sandbox. See the [threat model docs](https://hush.ch5.me/guides/threat-model/) for details.

### Update check

Hush checks for new versions once per day via a standard HTTP request to the npm registry. No telemetry is sent — only a version check. To disable:

```bash
HUSH_NO_UPDATE_CHECK=1 hush run -- npm start
```

Also respects `NO_UPDATE_NOTIFIER=1` and any `CI` environment variable.

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
| `hush inspect` | List secret names (values masked) |
| `hush list` | List variable names (values masked; `--reveal` to show) |
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
npx @chriscode/hush migrate --from v2
npx @chriscode/hush migrate --from v2 --cleanup
```

That is the supported bridge from legacy repositories to the current v3 model.

## AI-safe workflow

For AI assistants, the safe loop is:

```bash
npx @chriscode/hush inspect
npx @chriscode/hush has DATABASE_URL
npx @chriscode/hush set DATABASE_URL
npx @chriscode/hush run -- npm start
```

You can also install the shipped skill:

```bash
npx @chriscode/hush skill
npx @chriscode/hush skill --global
npx @chriscode/hush skill --local
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

## Shell completions

```bash
hush completion zsh > ~/.zsh/completions/_hush   # also: bash, fish
```

## Scripting and agents

Machine-readable output is available on the read-only surface — `has`, `check`,
`inspect`, `status`, `doctor`, `resolve`, `trace`, `verify-target` all take
`--json` and never emit secret values. `hush export-example --write` produces a
committable `.env.example` so a fresh clone can see which keys it needs before
it has the decryption key.

Standalone single-file binaries (Linux, macOS, Windows; with SHA256SUMS) are
attached to each [Forgejo Release](https://git.ch5.me/ch5/hush/releases) as an
alternative to the npm package.

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
