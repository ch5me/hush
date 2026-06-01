# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`hush delete-key` command**: Safely remove secrets from encrypted files with confirmation prompt and audit trail
- **`hush set --file` flag**: Explicitly target a specific file (e.g., `--file env/project/local`)
- **`hush set --repo-local` flag**: Shorthand for `--file env/project/local`
- **`hush set --show-length` flag**: Verify secret length before writing (useful for TTY input)
- **`hush edit --editor` flag**: Override editor for one session without changing environment
- **`hush materialize --format shell-export`**: Emit shell-safe `export KEY="value"` statements for sourced workflows
- **`hush materialize --compact-json`**: Minimal JSON output with just artifact paths
- **`hush materialize --include-provenance`**: Opt-in detailed provenance for JSON output
- **`hush resolve --compact`**: Minimal human-readable output for quick checks
- **`hush resolve --only <key>`**: Filter resolution to specific key
- **`hush resolve --json-compact`**: Minimal machine-readable records
- **`hush trace --compact`**: Minimal human-readable output for quick checks
- **`hush trace --json-compact`**: Minimal machine-readable records

### Changed

- **`hush set` now shows destination before writing**: Displays `will write KEY -> env/project/shared` before mutation
- **`hush set` warns on conflicts**: Alerts when writing to `shared` if key exists in other files
- **`hush set` rejects ambiguous positional `local`**: Hard error with hints when `hush set local KEY VALUE` is used
- **`hush set` success output includes file path**: Shows destination file and scope (e.g., `KEY set in env/project/shared`)
- **`hush set` trims TTY newlines**: Automatic trimming of trailing `\r` and `\n` in interactive input
- **`hush edit` honors `EDITOR` env var**: Resolves editor from `--editor` flag, then `EDITOR` env, then `vi` fallback
- **`hush edit` logs resolved editor**: Shows exact editor command for debugging
- **Duplicate-key errors now include remediation**: Error messages show move-key/delete-key commands and precedence order

### Fixed

- **TTY secret entry no longer preserves trailing newline**: Prevents `invalid_client` errors from trailing whitespace in secrets
- **Materialized dotenv format warning**: Added documentation that dotenv artifacts may not be shell-sourceable with multiline values
- **`hush edit` now honors `EDITOR` override**: Previously attempted to launch `zed --wait` even when `EDITOR` was set

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
