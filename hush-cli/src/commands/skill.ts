import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import pc from 'picocolors';
import type { HushContext, SkillOptions } from '../types.js';

const SKILL_FILES = {
  'SKILL.md': `---
name: hush-secrets
description: Manage secrets safely with the Hush v3 CLI. Use when working with encrypted config, environment variables, API keys, credentials, or migrating a legacy hush.yaml repo. NEVER read .hush/** directly.
allowed-tools: Bash(hush:*), Bash(npx hush:*), Bash(brew:*), Bash(npm:*), Bash(pnpm:*), Read, Grep, Glob, Write
---

# Hush v3 skill

Never read ".hush/**" directly.

Use these commands instead:

- \
\`npx hush config show --json\` for machine-readable repository structure
- \
\`npx hush inspect\` for redacted readable values
- \
\`npx hush has <KEY>\` to check whether a target resolves a non-empty value
- \
\`npx hush run -- <cmd>\` to use secrets at runtime
- \
\`npx hush materialize --target <name> --json --to <dir>\` to write file or binary artifacts for CI/native tooling
- \
\`npx hush verify-target <target> --require <KEY>\` before deploys that sync remote runtime secrets
- \
\`npx hush doctor\` to diagnose root, key, and store resolution issues
- \
\`npx hush copy-key <KEY> --from <file> --to <file>\` to relocate target-visible secrets without printing values
- \
\`npx hush file add <namespaced-path> [--roles <csv>] [--identities <csv>]\` to create a new encrypted file
- \
\`npx hush file remove <namespaced-path> [--keep-file]\` to remove an encrypted file
- \
\`npx hush file list\` to list all encrypted files
- \
\`npx hush file readers <namespaced-path> [--roles <csv>] [--identities <csv>]\` to update file readers
- \
\`npx hush bundle add <name> --files <csv>\` to create a bundle from explicit file refs
- \
\`npx hush bundle add-file <bundle> <file>\` to add a file to a bundle
- \
\`npx hush bundle remove-file <bundle> <file>\` to remove a file from a bundle
- \
\`npx hush bundle remove <name>\` to remove a bundle
- \
\`npx hush bundle list\` to list all bundles
- \
\`npx hush target add <name> --bundle <bundle> --format <format>\` to create a target
- \
\`npx hush target remove <name>\` to remove a target
- \
\`npx hush target list\` to list all targets

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
npx hush config show
\`\`\`

If the repo is not set up yet:

\`\`\`bash
npx hush bootstrap
\`\`\`

If the repo still uses \`hush.yaml\`:

\`\`\`bash
npx hush migrate --from v2 --dry-run
npx hush migrate --from v2
npx hush migrate --from v2 --cleanup
\`\`\`

## Safe default workflows

### Inspect state

\`\`\`bash
npx hush config show
npx hush config show --json
npx hush inspect
npx hush has DATABASE_URL
\`\`\`

### Add or update one secret

\`\`\`bash
npx hush set DATABASE_URL "postgres://db"
npx hush set API_KEY --gui
npx hush set FEATURE_FLAG --local
npx hush copy-key RESEND_API_KEY --from env/project/production --to env/api/production
npx hush move-key RESEND_API_KEY --from env/project/production --to env/api/production
\`\`\`

### Run with secrets

\`\`\`bash
npx hush run -- npm start
npx hush run -t api -- wrangler dev
\`\`\`

### Materialize file and binary artifacts

\`\`\`bash
npx hush materialize -t ios-signing --json --to /tmp/fitbot-signing
npx hush materialize -t ios-signing --to /tmp/fitbot-signing -- bash scripts/ci/install-ios-signing.sh /tmp/fitbot-signing
npx hush materialize --bundle fitbot-signing --to /tmp/fitbot-signing
npx hush materialize --cleanup --to /tmp/fitbot-signing
\`\`\`

### Review config safely

\`\`\`bash
npx hush resolve runtime
npx hush trace DATABASE_URL
npx hush verify-target runtime --require DATABASE_URL
npx hush diff
npx hush export-example
\`\`\`

## Topology Management

Files, bundles, and targets form a three-layer hierarchy. Build from the bottom up and tear down from the top.

### Files → Bundles → Targets lifecycle

\`\`\`bash
# 1. Create an encrypted file
npx hush file add env/api/production --roles owner,ci

# 2. Create a bundle that references it
npx hush bundle add api-production --files env/api/production

# 3. Create a target that consumes the bundle
npx hush target add api-production --bundle api-production --format dotenv

# 4. Verify the target resolves
npx hush verify-target api-production --require DATABASE_URL

# 5. Teardown in reverse order
npx hush target remove api-production
npx hush bundle remove api-production
npx hush file remove env/api/production
\`\`\`

### Safety semantics

- All topology mutations require the **owner role**. Members and CI identities cannot add, remove, or modify files, bundles, or targets.
- Removing a file that is still referenced by a bundle fails. Remove the bundle first.
- Removing a bundle that is still referenced by a target fails. Remove the target first.
- \`hush file remove\` deletes the encrypted disk file by default. Pass \`--keep-file\` to remove only the manifest entry.
- All mutations emit \`metadata_change\` audit events.

### Manage files

\`\`\`bash
npx hush file add env/api/production --roles owner,ci
npx hush file add env/api/staging --roles owner,member,ci
npx hush file list
npx hush file readers env/api/production --roles owner,ci --identities owner-local,ci
npx hush file remove env/api/staging
npx hush file remove env/api/production --keep-file
\`\`\`

### Manage bundles

\`\`\`bash
npx hush bundle add api-production --files env/api/production
npx hush bundle add-file api-production env/project/shared
npx hush bundle remove-file api-production env/project/shared
npx hush bundle list
npx hush bundle remove api-production
\`\`\`

### Manage targets

\`\`\`bash
npx hush target add api-production --bundle api-production --format dotenv
npx hush target add ios-signing --bundle ios-signing --format json --mode file
npx hush target list
npx hush target remove api-production
\`\`\`

## Commands to avoid

- \`cat .env\`
- \`cat .hush/**\`
- \`hush list\`
- \`hush decrypt --force\` unless the user explicitly needs the legacy bulk plaintext dump

See [SETUP.md](SETUP.md), [REFERENCE.md](REFERENCE.md), and [examples/workflows.md](examples/workflows.md).
`,

  'SETUP.md': `# Hush v3 setup

## New repository

\`\`\`bash
npx hush bootstrap
npx hush config show
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
npx hush set DATABASE_URL "postgres://db"
npx hush inspect
\`\`\`

## Existing legacy repository

If the project still has \`hush.yaml\`, migrate it in one big bang:

\`\`\`bash
npx hush migrate --from v2 --dry-run
npx hush migrate --from v2
npx hush migrate --from v2 --cleanup
\`\`\`

Migration writes v3 repo state under \`.hush/**\` and machine-local overrides under:

\`\`\`text
~/.hush/state/projects/<project-slug>/user/local-overrides.encrypted
\`\`\`

## Team member setup

\`\`\`bash
npx hush keys setup
npx hush config show
npx hush inspect
\`\`\`

Hush prefers explicit SOPS env when present, then the expected repo-scoped key in \`~/.config/sops/age/keys/<project>.txt\`, then any local project key that matches the \`.sops.yaml\` recipient, then the standard SOPS keyring (\`~/Library/Application Support/sops/age/keys.txt\` on macOS, \`~/.config/sops/age/keys.txt\` on Linux), and finally the legacy compatibility path \`~/.config/sops/age/key.txt\`.

## Global store

\`\`\`bash
npx hush keys generate --global
npx hush set --global OPENAI_API_KEY
npx hush inspect --global
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

\`\`\`bash
hush set DATABASE_URL "postgres://db"
hush set API_KEY --gui
hush set DEBUG --local
\`\`\`

### hush edit

Edit one v3 document through a decrypted temporary YAML file that Hush re-encrypts on save.

\`\`\`bash
hush edit
hush edit development
hush edit local
\`\`\`

### hush run

Materialize a v3 target into memory and execute a child process.

\`\`\`bash
hush run -- npm start
hush run -t api -- wrangler dev
\`\`\`

### hush verify-target

Verify that a target resolves and contains required keys before release automation syncs remote runtime secrets.

\`\`\`bash
hush verify-target api-production --require JWT_SECRET --require RESEND_API_KEY
hush verify-target api-production --require RESEND_API_KEY --json
\`\`\`

JSON output contains target, bundle, files, logical paths, required keys, and missing keys only. It does not contain secret values.

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
npx hush bootstrap
npx hush config show
npx hush config show --json
npx hush set DATABASE_URL "postgres://db"
npx hush inspect
\`\`\`

## Bootstrap a nested repo (child-local)

When inside a git repo that's nested under a parent Hush repo, use \`--new-repo\` to create a child-local repository instead of joining the parent. Use \`--yes\` in non-interactive contexts.

\`\`\`bash
npx hush bootstrap --new-repo --yes
npx hush doctor
npx hush config show
\`\`\`

## Diagnose root/key issues

\`\`\`bash
npx hush doctor
npx hush doctor --new-repo
\`\`\`

## Migrate a legacy repo

\`\`\`bash
npx hush migrate --from v2 --dry-run
npx hush migrate --from v2
npx hush config show
npx hush inspect
npx hush migrate --from v2 --cleanup
\`\`\`

## Change readers on one file

\`\`\`bash
npx hush config readers env/project/shared --roles owner,member,ci
npx hush config readers env/project/shared --identities owner-local,ci
\`\`\`

## Run an app

\`\`\`bash
npx hush run -- npm start
npx hush run -t api -- wrangler dev
npx hush verify-target api-production --require RESEND_API_KEY
npx hush copy-key RESEND_API_KEY --from env/project/production --to env/api/production
\`\`\`

## Materialize a signing bundle

\`\`\`bash
npx hush materialize -t ios-signing --json --to /tmp/fitbot-signing
npx hush materialize -t ios-signing --to /tmp/fitbot-signing -- bash scripts/ci/install-ios-signing.sh /tmp/fitbot-signing
npx hush materialize --cleanup --to /tmp/fitbot-signing
\`\`\`

## Review before commit

\`\`\`bash
npx hush diff
npx hush export-example
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
