# Migration Note: archive/automation-town-os

**Date:** 2026-04-21
**Project path:** `/Users/hassoncs/Workspaces/Personal/archive/automation-town-os`
**Status:** Migrated to v3 via bootstrap

---

## Legacy evidence found

- `hush.yaml` with `version: 2`, 8 targets (root, evals, homeassistant, nanoclaw, openclaw, openclaw-inventory, openclaw-sam-status-fix, radmedia)
- Sources declared: `.hush`, `.hush.development`, `.hush.production`, `.hush.local`
- Zero encrypted source files — none of the declared source paths existed on disk
- No `.sops.yaml`, no age key for this project
- `.gitignore` had bare `.hush/` entry — would block v3 commits (known hazard)
- This is a git worktree (`.git` is a file, not a directory); `git status` fails with worktree error

---

## Commands run

```bash
# 1. Inspect state
hush status
# → Repository: legacy-v2 (migration required)

hush migrate --from v2 --dry-run
# → FAILED: opaque ENOENT error on missing .tmp-fly-profiles file
# → Root cause: known defect — migrate fails on keyless repos with zero encrypted files

# 2. Bootstrap instead
hush bootstrap
# → Generated key: local/automation-town-os → ~/.config/sops/age/keys/local-automation-town-os.txt
# → 1Password backup FAILED with 409 Conflict (key likely already exists from a prior run)
# → Created .sops.yaml, .hush/manifest.encrypted, .hush/files/env/project/shared.encrypted

# 3. Set active identity
SOPS_AGE_KEY_FILE=~/.config/sops/age/keys/local-automation-town-os.txt hush config active-identity owner-local

# 4. Validate
SOPS_AGE_KEY_FILE=~/.config/sops/age/keys/local-automation-town-os.txt hush status
# → Repository: v3, Active identity: owner-local

SOPS_AGE_KEY_FILE=~/.config/sops/age/keys/local-automation-town-os.txt hush inspect
# → Readable files: 1 (env/project/shared), Unreadable: 0
```

---

## Cleanup performed

- `.gitignore` fixed: removed bare `.hush/` entry (would have blocked v3 `.hush/manifest.encrypted` from being committed), kept `.hush.*/` to block legacy v2 plaintext source dirs
- `hush.yaml` retained (cleanup marker not set via bootstrap path; manual removal is safe but left for owner)
- No stale `hush decrypt` / `hush unsafe:decrypt` script references found in .sh/.js/.mjs/.ts files

---

## Migration result

Completed via `hush bootstrap` because:
- Zero encrypted source files — nothing to re-encrypt into v3
- `hush migrate --from v2 --dry-run` failed with opaque ENOENT (known defect: attempts to stat unrelated `.tmp-fly-profiles` file)
- `hush bootstrap` succeeded and created full v3 layout

---

## Validation result

- `hush status` → `Repository: v3`, `Active identity: owner-local`
- `hush inspect` → 1 readable file, 0 unreadable files

---

## Project-specific quirks

- Git worktree — `.git` is a file pointing to `automation/.git/worktrees/automation-town-os`. Standard `git status` fails outside the worktree context. Does not block hush operations.
- 1Password backup returned 409 Conflict during bootstrap. Local key at `~/.config/sops/age/keys/local-automation-town-os.txt` is valid. The conflict suggests an older bootstrap attempt may have created the backup item already.
- `.sops.yaml` created with single age recipient (owner key). No CI key added yet.

---

## Hush defects observed

### Defect: `hush migrate --from v2 --dry-run` fails with opaque ENOENT on unrelated file

**Severity:** Medium — misleading error, forces bootstrap path discovery via trial-and-error.

**Repro steps:**
1. Repo has `hush.yaml` version 2, zero encrypted source files, no `.sops.yaml`
2. Run: `hush migrate --from v2 --dry-run`

**Exact error:**
```
Error: ENOENT: no such file or directory, stat '/Users/hassoncs/Workspaces/Personal/archive/automation-town-os/.tmp-fly-profiles/ctx-tunnel-test/RunningChromeVersion'
```

**Expected behavior:** Should detect no encrypted files and emit: "No encrypted secrets found. Run `hush bootstrap` to initialize v3." or at minimum, not crash on unrelated directory stat.

**Actual behavior:** Appears to be iterating directory contents to inventory encrypted files and crashes when it encounters a broken symlink or missing nested path in `.tmp-fly-profiles/`.

**Workaround:** Use `hush bootstrap` instead.
