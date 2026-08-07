---
type: configuration and secrets topology
title: Configuration, Stores, and Key Resolution
description: Hush discovers a project or global store, selects shipped v3 versus legacy authority, derives project identity, and supplies SOPS with an age key without reading secrets into wiki content. Runtime state lives outside the repository under the Hush machine store.
tags: [configuration, secrets, keys, state]
---

# Configuration, Stores, and Key Resolution

`hush-cli/src/config/loader.ts` and `hush-cli/src/store.ts` define discovery. Project mode walks upward from the start directory, prefers `.hush/manifest.encrypted` as v3, then `hush.yaml` or `hush.yml` as legacy v2. By default it stops at a Git boundary encountered above the starting directory; `--new-repo`/`ignoreAncestors` checks only the current directory. A v3 root disables legacy `hush.yaml` runtime loading.

Global mode is `~/.hush`, with key identity `hush-global`. Project state is derived under the machine state root at `~/.hush/state/projects/<project-slug>/` (exact root constants are in `hush-cli/src/store.ts` and `hush-cli/src/v3/state.ts`), including `active-identity.json` and `audit.jsonl`. These files are operational state, not committed repository authority.

`resolveStoreContext(startDir, mode, options)` returns a `StoreContext` with `mode`, `root`, `configPath`, `keyIdentity`, and `displayLabel`, then adds `projectSlug`, `stateRoot`, `projectStateRoot`, `activeIdentityPath`, and `auditLogPath` from `getProjectStatePaths`. `createProjectSlug` combines a sanitized project identity/root label with a stable hash suffix, preventing collisions between similarly named worktrees; `getStoreStateSeed` chooses the identity seed from global mode, v3 metadata, matched SOPS identity, package metadata, or root fallback. In project mode the root is `--root` when explicit, otherwise the discovered project root or start directory; in global mode the root is always `GLOBAL_STORE_ROOT`. `--global` selects the global branch, while `--new-repo` reaches `findProjectRoot(..., { ignoreAncestors: true })` so bootstrap cannot accidentally modify an ancestor repository. Focused evidence includes `hush-cli/tests/project.test.ts` for ancestor and Git-boundary discovery, `bootstrap-config.test.ts` for `--root` and `--new-repo` bootstrap boundaries, and `global-runtime.test.ts` for global mode.

## Precedence and ownership

| Concern | Resolution order / owner |
|---|---|
| Store | Explicit `--global`; otherwise project discovery from `--root` or cwd |
| Repository kind | v3 manifest first, otherwise legacy `hush.yaml`; v3 never falls back to legacy runtime |
| Active identity | Explicit command choice, manifest active identity, then machine state; must be declared |
| Key source | `SOPS_AGE_KEY_FILE`, `SOPS_AGE_KEY_CMD`, `SOPS_AGE_KEY`; then project-matched key, SOPS recipient match, platform keyring, legacy key path |
| Repository/local data | Committed namespaces are `env`, `artifacts`, `bundles`, `imports`; `user/**` is machine-local and included only when the command opts in |
| Bundle precedence | Local wins by default; imported can be configured to win; equal precedence is an error |
| Shadow policy | Local override shadowing is rejected unless `HUSH_ALLOW_LOCAL_OVERRIDES=1` |
| SOPS network behavior | Hush injects `SOPS_DISABLE_VERSION_CHECK=1` unless caller already chose a value; preflight is bounded |

Do not place private key contents, tokens, or secret values in documentation. The safe operational facts are the key locations and environment variable names. `hush keys setup`, `hush doctor`, and `hush config show state` diagnose state without requiring an agent to reveal values.

Active identity changes are validated by `setActiveIdentity`: the name must be declared, the persisted state is versioned, and changing repository configuration requires an identity with the `owner` role; the change is recorded in audit state. Global bootstrap uses the fixed `hush-global` store identity, creates the global encrypted manifest/shared file and initial owner identity, then writes the global active-identity state. Because all commands receive the same `StoreContext`, `set`, `has`, `run`, `resolve`, and `config` address the same project slug/state paths when given the same root and mode. `hush-cli/tests/keys.test.ts`, `global-store-hint.test.ts`, `global-runtime.test.ts`, `runtime-v3.test.ts`, and `bootstrap-config.test.ts` are the focused cross-command checks. `hush-cli/tests/v3/resolver.test.ts` and `runtime-v3.test.ts` also cover compatibility normalization of legacy `env/project/local` machine-local data into the reserved `user/local` behavior, ensuring the same override is observed by resolution and runtime commands rather than treated as a committed file.

## SOPS and age boundary

`hush-cli/src/core/sops.ts` shells out to `sops` for encryption/decryption and `hush-cli/src/lib/age.ts` handles age key generation and project key paths. Hush parses recipients from the project `.sops.yaml`, matches local project keys where possible, and reports attempted key paths when decryption fails. `readEncryptedFileRecipients` separately reads the recipients embedded in an encrypted file's unencrypted SOPS footer; this is the ground truth for current decryption and is used by reader/recipient drift checks. CI supplies `SOPS_AGE_KEY` as an Actions secret; local operators may use a project key path such as `~/.config/sops/age/keys/{project}.txt` or an explicit SOPS variable. Hush must not invoke 1Password or `op`.

Required runtime tools are Node 24, Bun 1.3.14 for repository workflows, `sops`, and `age`. Tests that exercise encrypted fixtures use isolated SOPS setup in `hush-cli/tests/helpers/sops-test.ts`; they are not proof that a production key exists.

## Diagnostics and sharp edges

A nested Git repository will not silently inherit a parent Hush repository under default discovery. Use `--new-repo` intentionally. A v3 repository with a stale or present `hush.yaml` must be debugged as v3. Global and project state can contain the same target names; `run` emits a global-store hint when a named project target is missing. `hush doctor --json` and `hush status --json` are safer agent diagnostics than reading state files directly.
