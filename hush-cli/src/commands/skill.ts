import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import pc from 'picocolors';
import type { HushContext, SkillOptions } from '../types.js';

const SKILL_FILES = {
  'SKILL.md': `---
name: hush-secrets
description: Manage secrets safely with the Hush v3 CLI. Use when working with encrypted config, environment variables, API keys, credentials, or migrating a legacy hush.yaml repo. NEVER read .hush/** directly.
allowed-tools: Bash(hush inspect:*), Bash(hush has:*), Bash(hush set:*), Bash(hush run:*), Bash(hush config:*), Bash(hush doctor:*), Bash(hush status:*), Bash(hush check:*), Bash(hush verify-target:*), Bash(hush project:*), Bash(hush resolve:*), Bash(hush trace:*), Bash(hush diff:*), Bash(hush export-example:*), Bash(hush bootstrap:*), Bash(npx @chriscode/hush inspect:*), Bash(npx @chriscode/hush has:*), Bash(npx @chriscode/hush set:*), Bash(npx @chriscode/hush run:*), Bash(npx @chriscode/hush config:*), Bash(npx @chriscode/hush doctor:*), Bash(npx @chriscode/hush status:*), Bash(npx @chriscode/hush check:*), Bash(npx @chriscode/hush verify-target:*), Bash(npx @chriscode/hush project:*), Bash(npx @chriscode/hush resolve:*), Bash(npx @chriscode/hush trace:*), Bash(npx @chriscode/hush diff:*), Bash(npx @chriscode/hush export-example:*), Bash(npx @chriscode/hush bootstrap:*), Read, Grep, Glob
---

# Hush v3 skill

Never read ".hush/**" directly.

Use these commands instead:

- \
\`npx @chriscode/hush config show --json\` for machine-readable repository structure
- \
\`npx @chriscode/hush inspect\` for redacted readable values
- \
\`npx @chriscode/hush has <KEY>\` to check whether a target resolves a non-empty value
- \
\`npx @chriscode/hush run -- <cmd>\` to use secrets at runtime
- \
\`npx @chriscode/hush materialize --target <name> --json --to <dir>\` to write file or binary artifacts for CI/native tooling
- \
\`npx @chriscode/hush verify-target <target> --require <KEY>\` before deploys that sync remote runtime secrets
- \
\`npx @chriscode/hush project validate <stage> --skip-remote\` to reconcile a project contract against a Hush target, wrangler vars, remote Worker secret metadata, and provider checks
- \
\`npx @chriscode/hush doctor\` to diagnose root, key, and store resolution issues
- \
\`npx @chriscode/hush copy-key <KEY> --from <file> --to <file>\` to relocate target-visible secrets without printing values
- \
\`npx @chriscode/hush file add <namespaced-path> [--roles <csv>] [--identities <csv>]\` to create a new encrypted file
- \
\`npx @chriscode/hush file remove <namespaced-path> [--keep-file]\` to remove an encrypted file
- \
\`npx @chriscode/hush file list\` to list all encrypted files
- \
\`npx @chriscode/hush file readers <namespaced-path> [--roles <csv>] [--identities <csv>]\` to update file readers
- \
\`npx @chriscode/hush bundle add <name> --files <csv>\` to create a bundle from explicit file refs
- \
\`npx @chriscode/hush bundle add-file <bundle> <file>\` to add a file to a bundle
- \
\`npx @chriscode/hush bundle remove-file <bundle> <file>\` to remove a file from a bundle
- \
\`npx @chriscode/hush bundle remove <name>\` to remove a bundle
- \
\`npx @chriscode/hush bundle list\` to list all bundles
- \
\`npx @chriscode/hush target add <name> --bundle <bundle> --format <format>\` to create a target
- \
\`npx @chriscode/hush target remove <name>\` to remove a target
- \
\`npx @chriscode/hush target list\` to list all targets

## Current repository model

Hush v3 stores repository authority under:

\`\`\`text
.hush/manifest.encrypted
.hush/files/**.encrypted
~/.hush/state/projects/<project-slug>/active-identity.json
\`\`\`

\`hush.yaml\` is legacy input for migration only.

## First step

Run this first:

\`\`\`bash
npx @chriscode/hush config show
\`\`\`

If the repo is not set up yet:

\`\`\`bash
npx @chriscode/hush bootstrap
\`\`\`

If the repo still uses \`hush.yaml\`:

\`\`\`bash
npx @chriscode/hush migrate --from v2 --dry-run
npx @chriscode/hush migrate --from v2
npx @chriscode/hush migrate --from v2 --cleanup
\`\`\`

## Safe default workflows

### Inspect state

\`\`\`bash
npx @chriscode/hush config show
npx @chriscode/hush config show --json
npx @chriscode/hush inspect
npx @chriscode/hush inspect --json
npx @chriscode/hush status

npx @chriscode/hush status --json
npx @chriscode/hush doctor
npx @chriscode/hush doctor --json
npx @chriscode/hush project plan staging --json
npx @chriscode/hush project validate staging --skip-remote
npx @chriscode/hush has DATABASE_URL
npx @chriscode/hush has DATABASE_URL --json
\`\`\`

\`--json\` is available on \`inspect\`, \`status\`, and \`doctor\` for machine-readable output. \`inspect --json\` includes a \`value\` field **only** for entries where \`sensitive: false\`; sensitive entries are never exposed.

### Add or update one secret

\`\`\`bash
npx @chriscode/hush set DATABASE_URL "postgres://db"
npx @chriscode/hush set API_KEY --gui
npx @chriscode/hush set FEATURE_FLAG --local
npx @chriscode/hush copy-key RESEND_API_KEY --from env/project/production --to env/api/production
npx @chriscode/hush move-key RESEND_API_KEY --from env/project/production --to env/api/production
npx @chriscode/hush delete-key OLD_KEY --from env/project/shared --yes
\`\`\`

Prefer \`--gui\` or piped stdin for values: inline \`set KEY VALUE\` puts the value in shell history and the process table (the CLI warns when you do).

### Run with secrets

\`\`\`bash
npx @chriscode/hush run -- npm start
npx @chriscode/hush run -t api -- wrangler dev
\`\`\`

### Materialize file and binary artifacts

\`\`\`bash
npx @chriscode/hush materialize -t ios-signing --json --to /tmp/fitbot-signing
npx @chriscode/hush materialize -t ios-signing --to /tmp/fitbot-signing -- bash scripts/ci/install-ios-signing.sh /tmp/fitbot-signing
npx @chriscode/hush materialize --bundle fitbot-signing --to /tmp/fitbot-signing
npx @chriscode/hush materialize --cleanup --to /tmp/fitbot-signing
\`\`\`

### Review config safely

\`\`\`bash
npx @chriscode/hush resolve runtime
npx @chriscode/hush trace DATABASE_URL
npx @chriscode/hush verify-target runtime --require DATABASE_URL
npx @chriscode/hush diff
npx @chriscode/hush export-example
npx @chriscode/hush export-example --write
\`\`\`

Use \`export-example --write\` to write a redacted \`.env.example\` to the repo root. Commit it so new contributors can discover required environment variables without decrypting secrets.

## Topology Management

Files, bundles, and targets form a three-layer hierarchy. Build from the bottom up and tear down from the top.

### Files → Bundles → Targets lifecycle

\`\`\`bash
# 1. Create an encrypted file
npx @chriscode/hush file add env/api/production --roles owner,ci

# 2. Create a bundle that references it
npx @chriscode/hush bundle add api-production --files env/api/production

# 3. Create a target that consumes the bundle
npx @chriscode/hush target add api-production --bundle api-production --format dotenv

# 4. Verify the target resolves
npx @chriscode/hush verify-target api-production --require DATABASE_URL

# 5. Teardown in reverse order
npx @chriscode/hush target remove api-production
npx @chriscode/hush bundle remove api-production
npx @chriscode/hush file remove env/api/production
\`\`\`

### Safety semantics

- All topology mutations require the **owner role**. Members and CI identities cannot add, remove, or modify files, bundles, or targets.
- Removing a file that is still referenced by a bundle fails. Remove the bundle first.
- Removing a bundle that is still referenced by a target fails. Remove the target first.
- \`hush file remove\` deletes the encrypted disk file by default. Pass \`--keep-file\` to remove only the manifest entry.
- All mutations emit \`metadata_change\` audit events.

### Manage files

\`\`\`bash
npx @chriscode/hush file add env/api/production --roles owner,ci
npx @chriscode/hush file add env/api/staging --roles owner,member,ci
npx @chriscode/hush file list
npx @chriscode/hush file readers env/api/production --roles owner,ci --identities owner-local,ci
npx @chriscode/hush file remove env/api/staging
npx @chriscode/hush file remove env/api/production --keep-file
\`\`\`

### Manage bundles

\`\`\`bash
npx @chriscode/hush bundle add api-production --files env/api/production
npx @chriscode/hush bundle add-file api-production env/project/shared
npx @chriscode/hush bundle remove-file api-production env/project/shared
npx @chriscode/hush bundle list
npx @chriscode/hush bundle remove api-production
\`\`\`

### Manage targets

\`\`\`bash
npx @chriscode/hush target add api-production --bundle api-production --format dotenv
npx @chriscode/hush target add ios-signing --bundle ios-signing --format json --mode file
npx @chriscode/hush target list
npx @chriscode/hush target remove api-production
\`\`\`

## Commands to avoid

- \`cat .env\`
- \`cat .hush/**\`
- \`hush list --reveal\` (plaintext dump; \`hush list\` without it is masked and fine)
- \`hush decrypt --force\` unless the user explicitly needs the legacy bulk plaintext dump
- \`hush edit\`, \`hush push\`, and \`hush materialize\` are deliberately not pre-approved by this skill: they can persist or transmit plaintext, so they require explicit human approval

See [SETUP.md](SETUP.md), [REFERENCE.md](REFERENCE.md), and [examples/workflows.md](examples/workflows.md).
`,

  'SETUP.md': `# Hush v3 setup

## New repository

\`\`\`bash
npx @chriscode/hush bootstrap
npx @chriscode/hush config show
\`\`\`

This creates:

\`\`\`text
.hush/manifest.encrypted
.hush/files/env/project/shared.encrypted
.sops.yaml
~/.hush/state/projects/<project-slug>/active-identity.json
\`\`\`

Then add values safely:

\`\`\`bash
npx @chriscode/hush set DATABASE_URL "postgres://db"
npx @chriscode/hush inspect
\`\`\`

## Existing legacy repository

If the project still has \`hush.yaml\`, migrate it in one big bang:

\`\`\`bash
npx @chriscode/hush migrate --from v2 --dry-run
npx @chriscode/hush migrate --from v2
npx @chriscode/hush migrate --from v2 --cleanup
\`\`\`

Migration writes v3 repo state under \`.hush/**\` and machine-local overrides under:

\`\`\`text
~/.hush/state/projects/<project-slug>/user/local-overrides.encrypted
\`\`\`

## Team member setup

\`\`\`bash
npx @chriscode/hush keys setup
npx @chriscode/hush config show
npx @chriscode/hush inspect
\`\`\`

Hush prefers explicit SOPS env when present, then the expected repo-scoped key in \`~/.config/sops/age/keys/<project>.txt\`, then any local project key that matches the \`.sops.yaml\` recipient, then the standard SOPS keyring (\`~/Library/Application Support/sops/age/keys.txt\` on macOS, \`~/.config/sops/age/keys.txt\` on Linux), and finally the legacy compatibility path \`~/.config/sops/age/key.txt\`.

## Age key recovery from Vercel

If the operator key was stored only in Vercel (as \`SOPS_AGE_KEY\`), recover it with:

\`\`\`bash
# Requires VERCEL_TOKEN in env or --token; project is the Vercel project ID
npx @chriscode/hush keys pull --from vercel --project prj_123
npx @chriscode/hush keys pull --from vercel --project prj_123 --team team_abc
npx @chriscode/hush keys pull --from vercel --project prj_123 --force  # overwrite existing
\`\`\`

The command fetches \`SOPS_AGE_KEY\` with \`decrypt=true\`, verifies the value looks like an age private key, derives the public key safely (without printing the private key), and saves to \`~/.config/sops/age/keys/<project>.txt\`. Run \`hush doctor\` after recovery to confirm resolution.

## Global store

\`\`\`bash
npx @chriscode/hush keys generate --global
npx @chriscode/hush set --global OPENAI_API_KEY
npx @chriscode/hush inspect --global
\`\`\`
`,

  'REFERENCE.md': `# Hush v3 command reference

## Current model

Repository authority lives in \`.hush/manifest.encrypted\` and \`.hush/files/**.encrypted\`.
Legacy \`hush.yaml\` repos must go through \`hush migrate --from v2\` before normal runtime commands are used.

## Core commands

### hush bootstrap

Create a new v3 repository.

\`\`\`bash
hush bootstrap
hush bootstrap --global
hush bootstrap --new-repo
hush bootstrap --yes
\`\`\`

When package metadata does not declare a project identifier, bootstrap falls back to the repo basename instead of inventing a nested \`local/<repo>\` key identity.

By default, bootstrap walks upward to find an existing parent \`.hush/\` repository and joins it. Use \`--new-repo\` to force a child-local repository even when a parent exists. Use \`--yes\` (or \`-y\`) to skip interactive confirmation in non-interactive mode.

A fresh bootstrap should leave both \`hush status\` and \`hush inspect\` ready to run without extra repair steps.

### hush doctor

Diagnose root discovery, key resolution, and store configuration for the current directory.

\`\`\`bash
hush doctor
hush doctor --new-repo
\`\`\`

Use this when bootstrap fails, key resolution fails, or you need to understand why Hush picks a particular repository root.

### hush config

Inspect or update structural v3 config.

\`\`\`bash
hush config show
hush config show --json
hush config show files
hush config active-identity
hush config active-identity member-local
hush config readers env/project/shared --roles owner,member,ci
\`\`\`

Machine-readable config output is structural only; it never includes decrypted values.

### hush file

Manage encrypted file documents in the v3 repository.

\`\`\`bash
hush file add <namespaced-path> [--roles <csv>] [--identities <csv>]
hush file remove <namespaced-path> [--keep-file]
hush file list [--json]
hush file readers <file-path> [--roles <csv>] [--identities <csv>]
\`\`\`

### hush bundle

Manage bundles of encrypted file references.

\`\`\`bash
hush bundle add <name> [--files <csv>]
hush bundle add-file <bundle-name> <file-path>
hush bundle remove-file <bundle-name> <file-path>
hush bundle remove <name>
hush bundle list [--json]
\`\`\`

All bundle mutations require the owner role and emit \`metadata_change\` audit events.

### hush target

Manage targets in the v3 repository.

\`\`\`bash
hush target add <name> --bundle <bundle> --format <format> [--mode process|file|example] [--filename <name>] [--subpath <path>] [--materialize-as <name>]
hush target remove <name>
hush target list [--json]
\`\`\`

### hush migrate --from v2

Convert a legacy \`hush.yaml\` repo into the v3 \`.hush/\` layout.

\`\`\`bash
hush migrate --from v2 --dry-run
hush migrate --from v2
hush migrate --from v2 --cleanup
\`\`\`

### hush set

Write one secret into a v3 file document or machine-local override document.

Before using an unfamiliar command or option, run \`hush <command> --help\`. Command help is repository-free, lists only accepted options, and shows value domains and safe alternatives.

\`\`\`bash
hush set DATABASE_URL "postgres://db"
hush set API_KEY --gui
hush set DEBUG --local
\`\`\`

\`hush set\` accepts exactly one destination selector. Use \`--file <namespaced-path>\`, \`--repo-local\`/\`--local\`, or \`--env <development|production>\`. It intentionally rejects \`--target\`; inspect target precedence with \`hush resolve <target>\`, then choose the destination file explicitly.

#### Storage classes

The first path segment names where a secret is stored, and a selector's meaning never depends on repository state:

- \`user/**\` — machine-local override store (\`~/.hush/state/projects/<slug>/user/local-overrides.encrypted\`). Never committed, readable only on this machine. \`user/local\` is the only destination in it; write it with \`--repo-local\`, \`--local\`, \`--file local\`, or \`--file user/local\`.
- everything else (\`env/**\`, \`artifacts/**\`, ...) — repository file under \`.hush/files/\`. Committed, and decryptable by every identity in that file's reader set.

\`user/**\` can never be declared as a repository file: \`hush file add user/...\` fails, and \`copy-key\`/\`move-key\`/\`delete-key\` reject the namespace rather than reinterpreting it as machine-local.

#### Machine-local overrides in resolution

The machine-local store is a resolver layer, not a per-command extra. Commands that resolve for **this machine** include it: \`run\`, \`materialize\`, \`decrypt --force\`, \`push\`, \`has\`, \`list\`, \`project\`, and the diagnostics that must agree with \`run\` — \`resolve\`, \`trace\`, \`verify-target\`. Commands that describe **committed repository content** exclude it: \`diff\` and \`export-example\`.

An override wins at the environment-variable layer: \`hush set DATABASE_URL --repo-local\` shadows \`env/project/shared/DATABASE_URL\` because both produce \`DATABASE_URL\`. The shadowed repository value stays addressable by its own logical path, so \`\${env/project/shared/DATABASE_URL}\` interpolation still reads the repository value.

An override resolves a collision with exactly one repository value. Two repository files colliding on one environment key stay a hard error with or without an override, so the ambiguity cannot be visible on one machine and broken everywhere else.

An override that shadows a repository value is **refused** by every command that hands values to a process (\`run\`, \`materialize\`, \`push\`, …). Only this machine sees the override, so allowing it silently means the same command yields a different value here than in CI or on any other machine — and for a secret that surfaces downstream as an auth failure, which points diagnosis at the authority instead of at the secret store. The error names both sources and the exact \`hush delete-key\` / \`hush trace\` commands that resolve it. To keep an override for one invocation, set \`HUSH_ALLOW_LOCAL_OVERRIDES=1\`; there is deliberately no persisted "allow", because a stored one would be the same invisible state this guard removes.

The diagnostics still resolve so they can show you the shadowing: \`hush set --repo-local\` names what it displaces at write time, \`hush resolve <target>\` lists overrides under "Machine-local overrides" (\`shadowed\` in \`--json\`), and \`hush trace <KEY>\` attributes an override to \`user/local\`. When a secret works for one person and nobody else, run \`hush trace <KEY>\` first.

\`env/project/local\` is an ordinary **repository** path — committed and readable by the whole team, despite the name. It is not an alias for machine-local storage. \`hush set --file env/project/local\` writes the repository file when it is declared, and hard-errors when it is not (it never silently falls back to the machine-local store). \`hush doctor\` flags any repository file still named \`local\`; if a value there was meant to stay on one machine, treat it as disclosed and rotate it.

\`hush set\` verifies every write by reading the value back from durable storage before reporting success, and fails loudly ("Write verification failed for ...") if it did not persist. Treat that error as "the secret is NOT saved". If the write persists but the active target does not resolve the destination file, \`hush set\` still succeeds and warns that \`hush get\` will not return the key there — run \`hush trace <KEY>\` to see which targets select it.

### hush import add

Bind a bundle or file from another Hush repository. Hush persists the absolute source root inside the encrypted manifest; commands that resolve the import require the source repository's age key to be available locally.

\`\`\`bash
hush import add --source-root /absolute/path/to/source --bundle shared-runtime
\`\`\`

### hush edit

Edit one v3 document through a decrypted temporary YAML file that Hush re-encrypts on save.
Accepts the repository aliases (\`shared\`/\`development\`/\`production\`), the machine-local store
(\`local\`/\`user/local\`), or any file declared in the repository manifest (see \`hush file list\`).
An unknown path hard-errors instead of editing a fallback file.

\`\`\`bash
hush edit
hush edit development
hush edit local
hush edit env/targets/media/runtime
\`\`\`

### hush run

Materialize a v3 target into memory and execute a child process.

\`\`\`bash
hush run -- npm start
hush run -t api -- wrangler dev
\`\`\`

If the working directory has a valid exact-version \`.nvmrc\`, Hush keeps a matching Node
already present on the parent \`PATH\` ahead of any \`PATH\` supplied by the target. This also applies
inside \`sh\`/\`bash\`/\`zsh\` command strings, while retaining the target's other \`PATH\` entries.


### hush push

Project a resolved Hush target into configured Cloudflare or Vercel runtimes.

\`\`\`bash
hush push --dry-run
hush push -t api
hush push --vercel -t web --project prj_123 --environment production --dry-run
# Stage-scoped Cloudflare Workers push (passes --env <name> to wrangler secret put)
hush push -t worker --wrangler-env staging --dry-run
hush push -t worker --wrangler-env production
\`\`\`

Configured Vercel targets map each env key to \`sensitive\` or \`encrypted\` before calling the Vercel REST API. Explicit \`--vercel\` mode is for ad-hoc projection when the manifest does not already declare \`push_to.type: vercel\`.

\`--wrangler-env\` passes \`--env <name>\` to every \`wrangler secret put\` call for the target, enabling staging vs production stage routing without separate target declarations.

### hush verify-target

Verify that a target resolves and contains required keys before release automation syncs remote runtime secrets.

\`\`\`bash
hush verify-target api-production --require JWT_SECRET --require RESEND_API_KEY
hush verify-target api-production --require RESEND_API_KEY --json
\`\`\`

JSON output contains target, bundle, files, logical paths, required keys, and missing keys only. It does not contain secret values.

### hush project

Reconcile a project runtime contract against a Hush target, Wrangler vars, remote worker secret metadata, and provider checks.

\`\`\`bash
hush project plan staging
hush project validate staging --skip-remote
hush project sync production --dry-run
\`\`\`

Use \`--config <path>\` when the contract file lives outside the default discovery paths, and \`--surface <name>\` when one repo declares multiple deploy surfaces.

### hush materialize

Write a v3 target or bundle to explicit file paths for CI, native build tooling, or other file-based consumers.

\`\`\`bash
hush materialize -t ios-signing --json --to /tmp/fitbot-signing
hush materialize -t ios-signing --to /tmp/fitbot-signing -- bash scripts/ci/install-ios-signing.sh /tmp/fitbot-signing
hush materialize --bundle fitbot-signing --to /tmp/fitbot-signing
hush materialize --cleanup --to /tmp/fitbot-signing
\`\`\`

Artifact entries may declare \`filename\`, \`subpath\`, or \`materializeAs\` to control their output path under the chosen root.

Prefer the \`-- <command>\` form when the files should only exist for the lifetime of one CI/native step. Use this instead of \`hush decrypt --force\` when you need a maintained, CI-friendly file materialization workflow.

### hush inspect / hush has

Safe read-only diagnostics.

\`\`\`bash
hush inspect
hush has DATABASE_URL
hush has DATABASE_URL -q
\`\`\`

\`hush has\` returns success only when the selected target resolves a non-empty value. It does not distinguish real credentials from placeholder/example strings.

### hush resolve / hush trace / hush diff / hush export-example

Safe debugging and review surfaces.

\`\`\`bash
hush resolve runtime
hush trace DATABASE_URL
hush resolve runtime --json
hush trace DATABASE_URL --json
hush diff --ref HEAD~1
hush export-example --bundle project
\`\`\`

### Service × environment topology

Use concrete service/environment names for target bundles: \`api-development\`, \`api-staging\`, \`api-production\`, \`root-production\`. Use \`project-*\` only for intentionally shared material.

Hush does not use ambient inheritance. If \`RESEND_API_KEY\` exists in \`project-production\` but \`api-production\` does not import that bundle/file, the API target should not see it. Fix by adding an explicit import or by copying/moving the key into the API-owned file with \`hush copy-key\` or \`hush move-key\`.

### hush encrypt

Legacy helper for source-file repos. Not part of the normal v3 repository workflow.

### hush init

Deprecated alias for \`hush bootstrap\`.
`,

  'examples/workflows.md': `# Hush workflows

## Bootstrap a repo

\`\`\`bash
npx @chriscode/hush bootstrap
npx @chriscode/hush config show
npx @chriscode/hush config show --json
npx @chriscode/hush set DATABASE_URL "postgres://db"
npx @chriscode/hush inspect
\`\`\`

## Bootstrap a nested repo (child-local)

When inside a git repo that's nested under a parent Hush repo, use \`--new-repo\` to create a child-local repository instead of joining the parent. Use \`--yes\` in non-interactive contexts.

\`\`\`bash
npx @chriscode/hush bootstrap --new-repo --yes
npx @chriscode/hush doctor
npx @chriscode/hush config show
\`\`\`

## Diagnose root/key issues

\`\`\`bash
npx @chriscode/hush doctor
npx @chriscode/hush doctor --new-repo
\`\`\`

## Migrate a legacy repo

\`\`\`bash
npx @chriscode/hush migrate --from v2 --dry-run
npx @chriscode/hush migrate --from v2
npx @chriscode/hush config show
npx @chriscode/hush inspect
npx @chriscode/hush migrate --from v2 --cleanup
\`\`\`

## Change readers on one file

\`\`\`bash
npx @chriscode/hush config readers env/project/shared --roles owner,member,ci
npx @chriscode/hush config readers env/project/shared --identities owner-local,ci
\`\`\`

## Run an app

\`\`\`bash
npx @chriscode/hush run -- npm start
npx @chriscode/hush run -t api -- wrangler dev
npx @chriscode/hush verify-target api-production --require RESEND_API_KEY
npx @chriscode/hush copy-key RESEND_API_KEY --from env/project/production --to env/api/production
\`\`\`

## Materialize a signing bundle

\`\`\`bash
npx @chriscode/hush materialize -t ios-signing --json --to /tmp/fitbot-signing
npx @chriscode/hush materialize -t ios-signing --to /tmp/fitbot-signing -- bash scripts/ci/install-ios-signing.sh /tmp/fitbot-signing
npx @chriscode/hush materialize --cleanup --to /tmp/fitbot-signing
\`\`\`

## Review before commit

\`\`\`bash
npx @chriscode/hush diff
npx @chriscode/hush export-example
\`\`\`
`,
};

type InstallLocation = 'global' | 'local';

function getSkillPath(ctx: HushContext, location: InstallLocation, root: string): string {
  if (location === 'global') {
    return ctx.path.join(homedir(), '.claude', 'skills', 'hush-secrets');
  }
  return ctx.path.join(root, '.claude', 'skills', 'hush-secrets');
}

async function promptForLocation(ctx: HushContext): Promise<InstallLocation> {
  const rl = createInterface({
    input: ctx.process.stdin,
    output: ctx.process.stdout,
  });

  return new Promise((resolve) => {
    ctx.logger.log(pc.bold('\nWhere would you like to install the Claude skill?\n'));
    ctx.logger.log(`  ${pc.cyan('1)')} ${pc.bold('Global')} ${pc.dim('(~/.claude/skills/)')}`);
    ctx.logger.log('     Works across all your projects. Recommended for personal use.\n');
    ctx.logger.log(`  ${pc.cyan('2)')} ${pc.bold('Local')} ${pc.dim('(.claude/skills/)')}`);
    ctx.logger.log('     Bundled with this project. Recommended for teams.\n');

    rl.question(`${pc.bold('Choice')} ${pc.dim('[1/2]')}: `, (answer: string) => {
      rl.close();
      const choice = answer.trim();
      if (choice === '2' || choice.toLowerCase() === 'local') {
        resolve('local');
      } else {
        resolve('global');
      }
    });
  });
}

function writeSkillFiles(ctx: HushContext, skillPath: string): void {
  ctx.fs.mkdirSync(skillPath, { recursive: true });
  ctx.fs.mkdirSync(ctx.path.join(skillPath, 'examples'), { recursive: true });

  for (const [filename, content] of Object.entries(SKILL_FILES)) {
    const filePath = ctx.path.join(skillPath, filename);
    ctx.fs.writeFileSync(filePath, content, 'utf-8');
  }
}

export async function skillCommand(ctx: HushContext, options: SkillOptions): Promise<void> {
  const { global: isGlobal, local: isLocal } = options;

  let location: InstallLocation;

  if (isGlobal) {
    location = 'global';
  } else if (isLocal) {
    location = 'local';
  } else {
    location = await promptForLocation(ctx);
  }

  const skillPath = getSkillPath(ctx, location, ctx.process.cwd());

  const alreadyInstalled = ctx.fs.existsSync(ctx.path.join(skillPath, 'SKILL.md'));
  if (alreadyInstalled) {
    ctx.logger.log(pc.yellow(`\nSkill already installed at: ${skillPath}`));
    ctx.logger.log(pc.dim('To reinstall, delete the directory first.\n'));
    return;
  }

  ctx.logger.log(pc.blue(`\nInstalling Claude skill to: ${skillPath}`));

  writeSkillFiles(ctx, skillPath);

  ctx.logger.log(pc.green('\n✓ Skill installed successfully!\n'));

  if (location === 'global') {
    ctx.logger.log(pc.dim('The skill is now active for all projects using Claude Code.\n'));
  } else {
    ctx.logger.log(pc.dim('The skill is now bundled with this project.'));
    ctx.logger.log(pc.dim('Commit the .claude/ directory to share with your team.\n'));
    ctx.logger.log(pc.bold('Suggested:'));
    ctx.logger.log('  git add .claude/');
    ctx.logger.log('  git commit -m "chore: add Hush Claude skill"\n');
  }

  ctx.logger.log(pc.bold('What the skill does:'));
  ctx.logger.log(`  • Teaches AI to use ${pc.cyan('hush inspect')} instead of reading secret files`);
  ctx.logger.log('  • Keeps the current .hush/ v3 repository model front and center');
  ctx.logger.log(`  • Guides AI through ${pc.cyan('hush migrate --from v2')} for legacy repos\n`);
}
