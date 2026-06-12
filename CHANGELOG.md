# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are automated: conventional commits pushed to `main` are versioned,
published to npm with provenance, and given a GitHub Release by CI.

## [Unreleased]

### Added

- `hush completion <bash|zsh|fish>` shell completions
- `--json` output for `inspect`, `status`, and `doctor` (no secret values)
- `hush export-example --write`: committable redacted `.env.example` so fresh
  clones can discover required keys before having the decryption key
- Standalone single-file binaries (Linux/macOS/Windows + SHA256SUMS) attached
  to GitHub Releases
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
- GitHub Actions are SHA-pinned and sops/age CI downloads are checksum-verified
- Key names are validated before reaching any subprocess
- Masked output no longer reveals value prefixes or exact lengths

### Added

- `hush delete-key` is now registered in the CLI (it was previously documented
  but not wired)
- `hush has --json` machine-readable output for agents
- Per-OS install guidance when sops or age is missing
- SECURITY.md and a published threat-model guide

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

[Unreleased]: https://github.com/hassoncs/hush/compare/v7.2.4...HEAD
[7.2.4]: https://github.com/hassoncs/hush/compare/v7.2.3...v7.2.4
[7.2.3]: https://github.com/hassoncs/hush/compare/v7.2.2...v7.2.3
[7.2.2]: https://github.com/hassoncs/hush/compare/v7.2.1...v7.2.2
[7.2.1]: https://github.com/hassoncs/hush/compare/v7.2.0...v7.2.1
[7.2.0]: https://github.com/hassoncs/hush/compare/v7.1.0...v7.2.0
[7.1.0]: https://github.com/hassoncs/hush/compare/v7.0.0...v7.1.0
[7.0.0]: https://github.com/hassoncs/hush/compare/v6.0.0...v7.0.0
[6.0.0]: https://github.com/hassoncs/hush/releases/tag/v6.0.0
