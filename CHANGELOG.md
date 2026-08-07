# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are automated: conventional commits pushed to `main` are versioned,
published to npm, and given a Forgejo Release by CI.

## [Unreleased]

### Fixed

- **`hush run` now sees machine-local overrides.** `hush set --repo-local KEY value`
  reported success and `hush has KEY` confirmed it, but `hush run -- <cmd>` injected
  nothing: the override store was merged onto resolver output inside one command-layer
  wrapper that `run` does not call. Machine-local participation is now a property of
  resolution, not of which wrapper a command happens to use, so `run`, `materialize`,
  `decrypt --force`, `resolve`, `trace`, and `verify-target` all see overrides.
  - Overrides win at the environment-variable layer, as before. The repository value
    they displace stays addressable by its own logical path, so
    `${env/project/shared/KEY}` interpolation still reads the repository value.
  - An override resolves a collision with exactly one repository value. Two repository
    files colliding on one environment key remain a hard error with or without an
    override.
  - `diff` and `export-example` deliberately exclude overrides: they describe committed
    repository content, which machine-local state is not part of.
  - `hush trace <KEY>` now finds machine-local-only keys and attributes overrides to
    `user/local` instead of reporting only repository provenance.
  - Overrides are no longer silent: `hush set --repo-local` names the repository values
    it displaces, and `hush resolve <target>` lists them under **Machine-local
    overrides** (`shadowed` in `--json`).

### Changed

- **BREAKING: one path, one storage location.** The first path segment now names
  the storage class: `user/**` is the machine-local override store (never
  committed, this machine only), everything else is a repository file under
  `.hush/files/` (committed, readable by every identity in its reader set).
  Previously `env/project/local` meant *either*, chosen by whether the manifest
  declared a file there — and both stores keyed entries under the same logical
  path, so a machine-local value could silently shadow a committed one.
  - The machine-local document moved from `env/project/local` to `user/local`.
    No migration is required: the store is normalized on read and rewritten on
    the next write, and older Hush versions still read the new form.
  - `hush set --file env/project/local` writes the repository file when it is
    declared, and now hard-errors when it is not, instead of silently writing
    machine-local overrides.
  - `--repo-local` / `--local` / `--file local` / `--file user/local` all mean
    the machine-local store, unconditionally.
  - `user/**` cannot be declared as a repository file; `hush file add`,
    `copy-key`, `move-key`, and `delete-key` reject it rather than
    reinterpreting it.
  - Machine-local logical paths in `trace`/`resolve`/audit output are now
    `user/local/<KEY>`. Environment variable names are unchanged.
  - See [Migration: v7 to v8](https://hush.ch5.me/migrations/v7-to-v8/).

### Added

- `hush doctor` and `hush check` now detect **reader/recipient drift**: a file
  whose `readers.identities` names an identity that is not recorded as `owner`,
  but whose actual age recipients leave no room for that identity to hold a
  distinct key. Previously `hush config readers`/`hush file add --identities`
  could record a reader promise with no corresponding age recipient, and both
  `check` and `doctor` reported clean — the repository's own access-control
  metadata was silently false. `hush doctor` fails (exit 5) and `hush check`
  reports `status: "error"` with `error: "READER_RECIPIENT_DRIFT"` naming the
  file, the unaccounted identities, and the actual recipient list. This is a
  necessary-condition check (Hush has no identity-to-age-key registry), not a
  full per-identity proof; files that only widen `readers.roles` are out of
  scope, since every file defaults to all three roles regardless of intent.

- `hush doctor` check `storage_class_separation`: reports any committed
  repository file still named `env/project/local`, with its entry count and
  whether a bundle selects it. `hush set` and `hush edit` emit the same warning
  when they write to one. Such a file is encrypted to every reader and stored in
  git, so values meant to be machine-local must be rotated, not just renamed.

- `hush completion <bash|zsh|fish>` shell completions
- `--json` output for `inspect`, `status`, and `doctor` (no secret values)
- `hush export-example --write`: committable redacted `.env.example` so fresh
  clones can discover required keys before having the decryption key
- Standalone single-file binaries (Linux/macOS/Windows + SHA256SUMS) attached
  to Forgejo Releases
- Windows smoke job and a coverage gate in CI; docs now build on every PR
- Documentation moved to https://hush.ch5.me

## [7.3.1] - 2026-06-12

Security-focused release preparing Hush for public launch.

### Security

- `hush list` masks values by default; plaintext requires the new `--reveal` flag
- All child processes are spawned with argument arrays instead of shell strings
  (sops, age-keygen, GUI prompts, `$EDITOR`); the age private key is passed via
  stdin and never appears in the process table
- `hush set` GUI prompts use masked input fields on Linux (`zenity --password`,
  `kdialog --password`) and Windows (`UseSystemPasswordChar`)
- Materialized artifacts are created with mode `0600` atomically; `hush bootstrap`
  adds `.hush-materialized/` to `.gitignore`; `hush check` flags leftover
  materialized plaintext
- The daily update check can be disabled (`HUSH_NO_UPDATE_CHECK=1`, also honors
  `NO_UPDATE_NOTIFIER` and `CI`) and no longer inherits secret-bearing
  environment variables
- CI actions are SHA-pinned and sops/age CI downloads are checksum-verified
- Key names are validated before reaching any subprocess
- Masked output no longer reveals value prefixes or exact lengths

### Added

- `hush delete-key` is now registered in the CLI (it was previously documented
  but not wired)
- `hush has --json` machine-readable output for agents
- Per-OS install guidance when sops or age is missing
- SECURITY.md and a published threat-model guide

### Fixed

- `hush set --file <path>` / `--target` now actually route the write to the
  named file. Previously an explicit selector for a registered namespaced path
  (e.g. `env/targets/media/runtime`) was silently dropped and the secret landed
  in `env/project/shared`. An unhonorable selector now hard-errors instead of
  silently writing elsewhere.
- `hush edit <file>` accepts any file declared in the manifest (everything
  `hush file list` shows), not just the four hardcoded aliases
  (`shared`/`development`/`production`/`local`). Undeclared paths hard-error with
  a clear message instead of being rejected with a misleading "Use: shared, …"
  hint. `set` and `edit` now share one destination resolver.

### Changed

- Unknown flags and unexpected positional arguments are rejected loudly instead
  of being silently ignored
- `hush run -e/--env` and `hush materialize --format` are hard errors with
  guidance (`--target` selects what to inject; format belongs to the target)
- `hush set KEY VALUE` warns that inline values are visible in shell history and
  the process table
- Bootstrap "next steps" now point at the newcomer path (set → run → inspect)
- Internal "v3" version jargon removed from user-facing output

### Removed

- Documented-but-unwired flags removed from docs and the AI skill:
  `--compact-json`, `--json-compact`, `--compact`, `--only`,
  `--include-provenance`, `--show-length`, `materialize --format shell-export`

## [7.3.0] - 2026-06-01

CLI friction fixes from real-world migration use.

### Added

- `hush set --file <path>`: target a declared v3 file path explicitly
- `hush set --repo-local`: write machine-local overrides
- `hush edit --editor <cmd>`: one-shot editor override (also honors `EDITOR`)

### Changed

- `hush set` shows the destination before writing and warns on conflicts
- `hush set` success output includes the destination file and scope
- TTY secret entry trims trailing newlines (prevents `invalid_client`-style bugs)
- Duplicate-key errors include remediation commands and precedence order

## [7.2.4] - 2026-05-15

### Fixed

- CI workflow node version standardization

## [7.2.3] - 2026-05-10

### Fixed

- Resolver conflict error messages

## [7.2.2] - 2026-05-05

### Added

- Bundle conflict detection and resolution

## [7.2.1] - 2026-05-01

### Fixed

- Materialize cleanup on child command failure

## [7.2.0] - 2026-04-28

### Added

- Materialize command with target/bundle support
- Persisted mode for CI/tooling workflows

## [7.1.0] - 2026-04-20

### Added

- Copy-key and move-key commands for secret ownership changes
- Trace and resolve commands for debugging

## [7.0.0] - 2026-04-15

### Added

- V3 repository model with encrypted YAML documents
- Bundle and target system for secret organization
- Identity and role-based access control

### Changed

- Migrated from v2 plaintext files to v3 encrypted documents

## [6.0.0] - 2026-04-01

### Added

- Initial v2 implementation with SOPS encryption

[Unreleased]: https://git.ch5.me/ch5/hush/compare/v7.2.4...main
[7.2.4]: https://git.ch5.me/ch5/hush/compare/v7.2.3...v7.2.4
[7.2.3]: https://git.ch5.me/ch5/hush/compare/v7.2.2...v7.2.3
[7.2.2]: https://git.ch5.me/ch5/hush/compare/v7.2.1...v7.2.2
[7.2.1]: https://git.ch5.me/ch5/hush/compare/v7.2.0...v7.2.1
[7.2.0]: https://git.ch5.me/ch5/hush/compare/v7.1.0...v7.2.0
[7.1.0]: https://git.ch5.me/ch5/hush/compare/v7.0.0...v7.1.0
[7.0.0]: https://git.ch5.me/ch5/hush/compare/v6.0.0...v7.0.0
[6.0.0]: https://git.ch5.me/ch5/hush/releases/tag/v6.0.0
