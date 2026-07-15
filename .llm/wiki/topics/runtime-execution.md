# Topic: Runtime Execution

> Memory-only secret injection, signal-safe cleanup, child process execution.

## Overview

`hush run -- <command>` is the primary runtime command. It resolves a target's secrets, decrypts them in memory, injects them into a child process's environment, and cleans up after execution — all without writing plaintext to disk.

## CH5 Local Launcher

Fleet installs build with Node 24 from the managed Hush clone after `bun run
cli:build`, then stage complete runtime files under the managed runtime root.
The generated `~/.local/bin/hush` launcher pins the actual Node executable and
staged entrypoint. It must not invoke Bun or a mutable `~/src/ch5/hush`
checkout. `node scripts/install-local.mjs --check` fails on launcher drift.

## Entry Point (`hush-cli/src/commands/run.ts`)

```typescript
export async function runCommand(ctx, options): Promise<void> {
  const { store, cwd, target, command } = options;
  // Requires `-- <cmd>` after `run`
  
  const repository = requireV3Repository(store, 'run');
  const { targetName, target: selectedTarget } = selectRuntimeTarget(repository, target);
  
  exitStatus = withMaterializedTarget(ctx, {
    store, repository, targetName,
    command: { name: 'run', args: [...] },
    mode: 'memory',  // ← KEY: memory-only, no disk writes
  }, (materialization) => {
    const childEnv = { ...ctx.process.env, ...materialization.env };
    
    // Wrangler-specific handling
    if (selectedTarget.format === 'wrangler') {
      childEnv.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'true';
      warnWranglerConflict(ctx, cwd);
    }
    
    const [cmd, ...args] = command;
    const result = ctx.exec.spawnSync(cmd, args, {
      stdio: 'inherit',
      env: childEnv,
      cwd,
    });
    return result.status ?? 1;
  });
  
  ctx.process.exit(exitStatus);
}
```

## The `withMaterializedTarget` Pattern

`withMaterializedTarget` (from `hush-cli/src/index.ts`) is the core safety wrapper:

1. **Resolve target**: Calls `resolveV3Target()` to get the bundle resolution
2. **Shape artifacts**: Converts resolved values into the target's specified format (dotenv, env, wrangler, json, etc.)
3. **Set up materialization**: For `mode: 'memory'`, builds the env object directly
4. **Execute callback**: Passes materialization to the caller (run command, materialize command, etc.)
5. **Signal-safe cleanup**: Registers cleanup handlers for SIGTERM, SIGINT, SIGHUP, and normal exit

### Materialization Modes

| Mode | Description |
|------|-------------|
| `memory` | Secrets injected as env vars; nothing on disk. Used by `hush run`. |
| `file` | Secrets written to temp files with cleanup on exit. Used by `hush materialize`. |

## Wrangler Handling

Wrangler (Cloudflare Workers) has special handling:
- Sets `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` to ensure Wrangler picks up injected env vars
- Warns if `.dev.vars` exists in the cwd (Wrangler may prefer file-based config over env vars)

## Signal Safety

The materialization system ensures cleanup happens on:
- Normal completion
- SIGTERM
- SIGINT  
- SIGHUP
- Uncaught exceptions

This prevents plaintext temp files from persisting after:
- CI cancellation
- Editor/tool watcher restarts
- User pressing Ctrl+C

## Environment Variable Injection

Secrets are merged with the current process environment:
```typescript
const childEnv: NodeJS.ProcessEnv = {
  ...ctx.process.env,     // Parent environment (PATH, HOME, etc.)
  ...materialization.env, // Resolved secrets (may override existing vars)
};
```

Child process inherits:
- `stdio: 'inherit'` — output goes to the same terminal
- `cwd` — working directory for the command
- `env` — merged environment including secrets

## Error Handling

- Resolution failures (missing bundle, unreadable files) are caught and logged
- Process execution errors are caught and re-thrown with context
- Exit status propagates correctly from child process

## Source Attribution

> Sources: `hush-cli/src/commands/run.ts` (lines 1-72) — `runCommand`, `warnWranglerConflict`, `withMaterializedTarget` usage; `hush-cli/src/v3/materialize.ts` — materialization logic, signal handling, env shaping; `hush-cli/src/v3/temp.ts` — temp file management, cleanup handlers; `hush-cli/src/v3/resolver.ts` (lines 297-317) — `resolveV3Target`
