---
title: CLI Commands
last_compiled: 2026-04-22
sources: 8
coverage: high
topic_type: stable
---

# CLI Commands

## Summary [coverage: high -- 8 sources]

Hush ships a single CLI binary (`@chriscode/hush`) with 25+ commands covering the full secrets lifecycle: repository bootstrapping, secret management, runtime execution, key management, debugging, and migration. The CLI uses a hand-rolled argument parser with explicit subcommands, environment flags (`-e`), and global/project mode switching (`--global`). Every command receives a `HushContext` dependency-injected context for isolation and testability. Version: 6.0.0.

## Architecture [coverage: high -- 3 sources]

The CLI architecture is organized in layers:

```
cli.ts (entry point + arg parsing)
  └── commands/*.ts (25 command implementations)
        └── core/*.ts (parse, merge, mask, interpolate, sops, template)
              └── v3/*.ts (repository, resolver, materialize, domain, schema)
                    └── lib/*.ts (fs wrapper, age helpers)
```

- **Entry point** (`cli.ts`): Parses CLI args via `parseArgs()`, resolves store context (project vs global), checks migration status, dispatches to command handlers via switch/case.
- **Commands** (`commands/`): Each command receives `(ctx: HushContext, options)` and performs its work through the context's DI surfaces (fs, exec, sops, logger, process, config, age).
- **Core logic** (`core/`): Parses dotenv content, merges variable arrays, masks sensitive values for display, wraps SOPS CLI calls, handles variable interpolation.
- **V3 domain** (`v3/`): Repository model, resolution engine, materialization, domain types, schema constants, path resolution, identity management, and cross-repository imports.

**Sources:**
- [cli.ts](../../hush-cli/src/cli.ts)
- [context.ts](../../hush-cli/src/context.ts)
- [types.ts](../../hush-cli/src/types.ts)

## Key Decisions [coverage: high -- 5 sources]

- **No interactive prompts in commands** — All commands work non-interactively; `set` prompts via the context layer only. This enables full automation by AI agents.
- **Dependency Injection over global mocks** — Commands access filesystem, child process, and config ONLY through `ctx: HushContext`. Tests construct mock contexts instead of using `vi.mock` for `fs` or `child_process`.
- **Hand-rolled argument parser** — No yargs/commander dependency. The parser in `cli.ts` handles all flags, positional args, subcommands, and the `--` separator for shell commands.
- **Project vs global store mode** — `--global` switches to `~/.hush` store instead of project-local `.hush/`. The store context carries paths for active identity, audit log, and project state.
- **Three-command rule** — Adding or modifying any CLI command requires updating three files in the same commit: implementation, skill documentation, and user-facing docs.

## API Surface [coverage: high -- 2 sources]

### Runtime Commands
| Command | Description |
|---------|-------------|
| `hush run -- <cmd>` | Execute command with secrets injected into environment (memory-only, AI-safe) |
| `hush set <KEY> [VALUE]` | Add or update a secret (prompts if no value provided) |
| `hush edit [file]` | Edit all secrets in `$EDITOR` (shared/dev/prod/local) |
| `hush has <key>` | Check if a secret exists (exit 0/1) |

### Repository Commands
| Command | Description |
|---------|-------------|
| `hush bootstrap` | Create v3 `.hush/` repository shell and initial active identity |
| `hush config show [section]` | Show manifest, files, identities, targets, imports, or state |
| `hush config active-identity [name]` | Show or change the active identity |
| `hush config readers <file> --roles <csv>` | Update file readers |
| `hush status` | Show configuration and status |

### Key Management
| Command | Description |
|---------|-------------|
| `hush keys setup` | Verify local key exists or show the expected path |
| `hush keys generate` | Generate a new local key and update `.sops.yaml` guidance |
| `hush keys list` | List local keys |

### Debugging
| Command | Description |
|---------|-------------|
| `hush resolve <target>` | Show what variables a target receives |
| `hush trace <key>` | Trace a variable through sources and targets |
| `hush diff [--ref] [--bundle]` | Compare current state against git ref |
| `hush export-example [--bundle]` | Emit a redacted target/bundle example |

### Safety & CI
| Command | Description |
|---------|-------------|
| `hush inspect` | List all variables with masked values (AI-safe) |
| `hush check [--warn] [--json]` | Verify secrets are encrypted (pre-commit hook) |
| `hush push --dry-run` | Preview push to Cloudflare Workers/Pages |
| `hush materialize -t <target> --json` | Write target artifacts to disk for CI/tooling |

### Migration
| Command | Description |
|---------|-------------|
| `hush migrate --from v2 [--cleanup]` | Convert legacy `hush.yaml` repo to v3 |

**Sources:**
- [cli.ts](../../hush-cli/src/cli.ts) (full command table + help text)
- [commands/run.ts](../../hush-cli/src/commands/run.ts)

## Usage Patterns [coverage: medium -- 3 sources]

### Initial Setup
```bash
# Bootstrap a repo
hush bootstrap
hush keys setup          # Verify the expected local key
hush config show         # Verify structure
```

### Daily Workflow
```bash
hush inspect               # List secrets (masked)
hush has DATABASE_URL      # Check existence
hush set STRIPE_SECRET_KEY # Add/edit
hush run -- npm start      # Run with secrets in memory
```

### CI/CD Integration
```bash
hush check              # Pre-commit: verify encrypted state
hush materialize -t api --to /tmp/out -- npm run build  # Materialize artifacts
hush push --dry-run     # Preview Cloudflare push
```

### Global Secrets
```bash
hush set --global OPENAI_API_KEY   # Store at ~/.hush
hush run --global -- npm start     # Use global secrets only
```

## Troubleshooting [coverage: medium -- 4 sources]

### Migration Banner
If you see the "Migration Required" banner, the repo still uses `hush.yaml`. Run `hush migrate --from v2 --dry-run` first to preview, then `hush migrate --from v2` to convert.

### SOPS/Age Key Issues
- "SOPS decryption failed: No matching age key" → Run `hush keys setup` to verify the expected local key at `~/.config/sops/age/keys/{project}.txt`.
- "No active identity is configured" → Run `hush config active-identity owner-local` to set identity, or `hush bootstrap` for new repos.

### Wrangler Conflict
When using `hush run` with Cloudflare Workers, existing `.dev.vars` files cause Wrangler to ignore injected values. Remove `.dev.vars` before running.

## Related Topics [coverage: high -- 6 sources]

- [v3-repository-model](v3-repository-model.md)
- [secrets-resolution](secrets-resolution.md)
- [key-management](key-management.md)
- [materialization](materialization.md)
- [ai-safe-workflow](ai-safe-workflow.md)
- [dependency-injection](../concepts/dependency-injection.md)

## Sources

- [cli.ts](../../hush-cli/src/cli.ts) — Entry point, argument parsing, command dispatch
- [context.ts](../../hush-cli/src/context.ts) — Default HushContext implementation
- [types.ts](../../hush-cli/src/types.ts) — All option types, HushContext interface
- [run.ts](../../hush-cli/src/commands/run.ts) — Runtime execution command
- [set.ts](../../hush-cli/src/commands/set.ts) — Secret writing command
- [bootstrap.ts](../../hush-cli/src/commands/bootstrap.ts) — Repository initialization
- [check.ts](../../hush-cli/src/commands/check.ts) — Encryption verification
- [keys.ts](../../hush-cli/src/commands/keys.ts) — Key management command
