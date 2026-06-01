# Firefly Cloud Google OAuth Hush Friction

- Date: 2026-06-01
- Repo under migration/use: `firefly-cloud`
- Maintainer: Codex
- Scenario: fix real Google Drive MCP OAuth inputs for `mcporter` using Hush-backed local runtime values

## Goal

Update `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in repo-backed Hush state for `root-runtime-local`, then prove live OAuth token exchange and a live MCP read.

## Friction Log

### 1. `hush set` defaults to `shared` too quietly

What happened:
- `hush set GOOGLE_CLIENT_SECRET` wrote to `env/project/shared`.
- In this repo, correct durable target was `env/project/local`.
- Command success output did not surface target file path. Audit log showed it later, but that is too late.

What should have happened:
- Hush should have shown planned destination before writing.
- Hush should have warned when writing a key into `shared` if a same-named key already exists in `env/project/local`, `development`, `staging`, or `production`.

What Hush could do:
- Print `will write GOOGLE_CLIENT_SECRET -> env/project/shared` before mutation.
- Add `--file <path-or-alias>` support for `set`.
- Add conflict prompt: `key also exists in env/project/local; write shared anyway?`.

### 2. `--local` meaning is easy to misunderstand

What happened:
- I needed repo file `env/project/local`.
- `hush set --local GOOGLE_CLIENT_ID ...` writes to machine-local overrides, not repo file `env/project/local`.
- That is valid behavior, but name collision between repo file `local` and machine-local `--local` is confusing.

What should have happened:
- CLI should make `machine-local override` vs `repo env/project/local` unmistakable.

What Hush could do:
- Rename `--local` to `--machine-local`.
- Reserve `local` file alias for repo file only.
- Add explicit `--repo-file local` or `--file env/project/local`.

### 3. `hush set local KEY VALUE` silently does wrong thing

What happened:
- I tried positional `local` assuming file selection.
- Parser treated `local` as key and wrote key `local` into shared store.
- Success output only said `local set (16 chars, encrypted-at-rest v3 doc)`, which is easy to miss in a busy flow.

What should have happened:
- Command should have rejected ambiguous positional `local`.
- At minimum, if first positional matches known file aliases (`shared`, `local`, `development`, `production`), CLI should suggest correct syntax.

What Hush could do:
- Hard error on `hush set local ...` with hint:
  - `Did you mean --local for machine-local overrides?`
  - `Did you mean --file env/project/local once supported?`
- Add typo/shape detection for common file-alias mistakes.

### 4. No obvious direct write path to repo `env/project/local`

What happened:
- `set` has easy surfaces for `shared`, env-based files, and machine-local overrides.
- There was no obvious first-class command for `env/project/local`.
- Safe workaround was awkward:
  1. write to `shared`
  2. `move-key` from `env/project/shared` to `env/project/local`

What should have happened:
- Repo `local` file should be first-class like other repo files.

What Hush could do:
- Support `hush set --file env/project/local KEY VALUE`.
- Support `hush set --repo-local KEY VALUE`.
- Document repo-local write examples in command help.

### 5. Duplicate-key runtime error lacks fix hint

What happened:
- After accidental shared write plus existing local value, `hush run -t root-runtime-local -- ...` failed with:
  - `Multiple logical paths resolve to environment key "GOOGLE_CLIENT_SECRET": env/project/local/GOOGLE_CLIENT_SECRET, env/project/shared/GOOGLE_CLIENT_SECRET`
- Error was accurate, but did not say how to resolve safely.

What should have happened:
- Error should point to remediation path, not only failure.

What Hush could do:
- Add hint:
  - `Use hush move-key GOOGLE_CLIENT_SECRET --from env/project/shared --to env/project/local`
  - or `remove one duplicate entry`
- Show precedence order for that target.

### 6. No simple delete-key command surfaced during recovery

What happened:
- Accidental key creation left cleanup uncertainty.
- `move-key` fixed duplicate cases, but stray accidental keys still need removal flow.
- I did not find an obvious `delete-key` / `rm-key` command from normal help.

What should have happened:
- Cleanup path should be first-class and discoverable.

What Hush could do:
- Add `hush delete-key <KEY> --from <file>`.
- Mention delete/removal path in `set` and `move-key` docs.

### 7. `trace` / `resolve` ergonomics are weak for single-key debugging

What happened:
- `resolve root-runtime-local --json` returned huge output.
- `trace GOOGLE_CLIENT_SECRET` was slow/noisy enough that I fell back to audit logs plus targeted runtime probes.
- For real incident work, I needed a compact answer:
  - where does this key come from?
  - what target sees it?
  - what duplicates exist?

What should have happened:
- There should be a compact, AI-safe, single-key debug view.

What Hush could do:
- Add `hush trace GOOGLE_CLIENT_SECRET --json --compact`.
- Add `hush resolve root-runtime-local --only GOOGLE_CLIENT_SECRET`.
- Add `hush doctor-key GOOGLE_CLIENT_SECRET --target root-runtime-local`.

### 8. Success output hides important context

What happened:
- `GOOGLE_CLIENT_SECRET set (36 chars, encrypted-at-rest v3 doc)` does not say destination file.
- In incident work, destination is often more important than char count.

What should have happened:
- Success output should include destination file and scope every time.

What Hush could do:
- Print:
  - `GOOGLE_CLIENT_SECRET set in env/project/shared (36 chars)`
  - `GOOGLE_CLIENT_ID set in machine-local overrides (72 chars)`

### 9. TTY secret entry preserved trailing newline

What happened:
- Interactive TTY `hush set GOOGLE_CLIENT_SECRET` stored one trailing newline byte (`0x0A`).
- Runtime secret length became 36 instead of copied 35.
- Google token endpoint then rejected the secret with `invalid_client`.
- Rewriting same secret inline without TTY fixed it immediately.

What should have happened:
- Interactive entry should strip terminal submit newline before persistence.

What Hush could do:
- Trim trailing `\r` / `\n` in TTY secret capture path.
- Offer `--show-length` verification before write when secret comes from prompt.

### 10. Materialized dotenv is not shell-sourceable when values are multiline

What happened:
- I materialized `root-runtime-local` to a temp `.env.local`.
- Sourcing it in `bash` failed because PEM/private-key style values span multiple lines and are not valid shell assignment syntax.
- For live incident work, I only needed two vars and had to fall back to `grep`/`xargs` extraction.

What should have happened:
- Hush should provide a shell-safe export mode for automation.

What Hush could do:
- Add `hush env --target root-runtime-local --format shell`.
- Add `hush materialize --format shell-export`.
- Add docs warning that dotenv artifacts are not guaranteed to be `source`-safe shell scripts.

### 11. `materialize --json` is too noisy for simple automation

What happened:
- I needed one thing: artifact path.
- `hush materialize -t root-runtime-local --json` returned a very large payload with every logical path and provenance entry.
- That made simple scripting noisy and expensive.

What should have happened:
- There should be a compact mode for automation.

What Hush could do:
- Add `--compact-json` or `--json-path targetArtifact.path`.
- Make full provenance opt-in with a separate `--include-provenance`.

### 12. `hush edit` did not honor attempted `EDITOR` override in this flow

What happened:
- I tried to use `hush edit shared` with an explicit `EDITOR` override so I could clean one accidental key non-interactively.
- Hush still attempted to launch `zed --wait ...` and failed there.
- That blocked safe scripted cleanup during incident response.

What should have happened:
- `hush edit` should honor explicit per-process `EDITOR`.

What Hush could do:
- Add a startup log line showing exact editor command Hush resolved.
- Add `--editor <command>` for one-shot overrides.
- Add a test that `EDITOR=cat hush edit shared` actually executes `cat`.

### 13. No clean portable secret-export path for non-repo local tools

What happened:
- I needed same Google OAuth client secret for a non-repo local MCP wrapper under `~/.local/bin` / `~/.mcporter`.
- Hush target/value already existed in repo-backed config context, but there was no obvious safe compact flow to export one key for another local tool without either:
  - coupling wrapper to repo-specific Hush runtime resolution every launch, or
  - duplicating secret into another local file.
- For immediate reliability, I duplicated secret into `~/.mcporter/google-drive-local.env` with `0600` permissions.

What should have happened:
- There should be a first-class way to bridge one secret from Hush into another local tool/runtime without awkward repo coupling or plaintext duplication.

What Hush could do:
- Add `hush export-key KEY --target <target> --format shell` for single-key local-tool wiring.
- Add `hush exec --target <target> --env KEY -- command ...` for tight scoped one-key injection.
- Add docs/patterns for `mcporter`, local MCP wrappers, and other non-repo home-directory tools.

## Net Effect

All issues above are survivable, but together they make a simple secret correction slower and riskier than it should be. Biggest problems:

1. `shared` default is too implicit.
2. `--local` meaning collides with repo `local`.
3. No first-class repo-local write command.
4. Duplicate-key failures do not tell operator exact next fix.
