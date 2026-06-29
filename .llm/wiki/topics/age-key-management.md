# Topic: Age Key Management

> Local age key discovery, generation, and verification for Hush.

## Overview

Hush uses local age private keys for project and global stores. The canonical per-project path is `~/.config/sops/age/keys/{project}.txt`. Hush no longer integrates with 1Password or the `op` CLI.

## Key Storage Locations

| Location | Purpose |
|----------|---------|
| `~/.config/sops/age/keys/{project}.txt` | Canonical local private key file for a project store |
| `~/.hush/.sops.yaml` | Public key recipient rules for the global store |
| `.sops.yaml` (committed) | Public key recipient rules for a project store |
| `~/.hush/state/projects/<project-slug>/active-identity.json` | Machine-local active identity state |

## Commands (`hush-cli/src/commands/keys.ts`)

### `hush keys setup`

Verification workflow for a local machine:

1. Resolves the project identifier for the current store.
2. Checks whether a local key already exists.
3. If the key exists, exits successfully.
4. If the key is missing, tells the operator to run `hush keys generate` or copy the private key into the expected local path.

```
keys.ts lines 44-55:
  → getProject(...)
  → ctx.age.keyExists(project) → return if exists
  → print expected local path + next steps
```

### `hush keys generate`

Local key creation workflow:

1. Validates that the `age` CLI is available.
2. Generates a new age key pair.
3. Saves the private key locally.
4. Bootstraps the global store when running with `--global`.
5. Creates `.sops.yaml` for a project store when missing, or prints the public key if the file already exists.

```
keys.ts lines 58-97:
  → ageAvailable → ageGenerate → keySave
  → optional global bootstrap
  → optional .sops.yaml creation/update hint
```

### `hush keys pull --from vercel`

Recovers the project age key from a Vercel project env var (`SOPS_AGE_KEY`) and installs it locally.
Closes the gap exposed when the key was stored only in Vercel CI and was not backed up to an operator machine.

Workflow:
1. Resolves token from `--token` flag or `VERCEL_TOKEN` env var.
2. Calls `GET /v10/projects/{projectId}/env?decrypt=true` on the Vercel API.
3. Finds the entry with `key === "SOPS_AGE_KEY"`.
4. Validates the value starts with `AGE-SECRET-KEY-`.
5. Derives the public key via `ctx.age.agePublicFromPrivate()` — never prints the private key.
6. Saves to `~/.config/sops/age/keys/{project}.txt` via `ctx.age.keySave()`.
7. Refuses to overwrite an existing key unless `--force` is passed.

```
hush keys pull --from vercel --project prj_123
hush keys pull --from vercel --project prj_123 --team team_abc [--token tok]
hush keys pull --from vercel --project prj_123 --force
```

After recovery, run `hush doctor` to confirm the key resolves correctly.

`keys pull` without `--from` exits 1 with an error; the only supported platform is `vercel` for now.
`hush keys push` still exits 1 (removed; 1Password integration no longer exists).

### `hush keys list`

Lists only local keys via `keysList()` from `hush-cli/src/lib/age.ts`.

## Age Key Management

`hush-cli/src/lib/age.ts`:

- **`keyExists(project)`** — Checks whether the expected local key file exists.
- **`keyPath(project)`** — Returns the canonical per-project key path.
- **`keySave(project, keyPair)`** — Writes the private key with `0o600` permissions.
- **`keyLoad(project)`** — Reads and returns the stored key pair.
- **`keysList()`** — Lists local key files with public key prefixes.
- **`ageGenerate()`** — Generates a new age key pair via `age-keygen`.
- **`agePublicFromPrivate(priv)`** — Derives the public key from a private key.
- **`ageAvailable()`** — Checks whether the `age` CLI is installed.

## Resolution Order

For normal CLI flows, Hush prefers:

1. Explicit SOPS env configuration.
2. The expected repo-scoped key at `~/.config/sops/age/keys/{project}.txt`.
3. Any local project key that matches the `.sops.yaml` recipient.
4. The standard SOPS keyring.
5. The legacy compatibility path `~/.config/sops/age/key.txt`.

## CI Integration

CI uses `SOPS_AGE_KEY` as the private key secret. Hush does not require a password-manager bridge for CI.

## Operator Guidance

- Share private keys with teammates using an approved secure channel outside Hush.
- Keep the committed `.sops.yaml` as the public-key source of truth.
- Use `hush keys setup`, `hush status`, or `hush doctor` to verify local key resolution.

> Sources: `hush-cli/src/commands/keys.ts`; `hush-cli/src/lib/age.ts`; `docs/src/content/docs/reference/commands.mdx`; `AGENTS.md`
