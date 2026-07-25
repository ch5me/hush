import { join } from 'node:path';
import pc from 'picocolors';
import { withMaterializedTarget } from '../index.js';
import { requireV3Repository, selectRuntimeTarget } from './v3-command-helpers.js';
import type { HushContext, RunOptions } from '../types.js';
import { globalStoreHint } from '../lib/global-store-hint.js';
import { writeJsonError } from '../lib/command-output.js';

function warnWranglerConflict(ctx: HushContext, cwd: string): void {
  const devVarsPath = join(cwd, '.dev.vars');
  if (!ctx.fs.existsSync(devVarsPath)) {
    return;
  }

  ctx.logger.warn('\n⚠️  Wrangler Conflict Detected');
  ctx.logger.warn(`   Found .dev.vars in ${cwd}`);
  ctx.logger.warn('   Wrangler may ignore injected environment values while this file exists.');
  ctx.logger.warn(pc.bold(`   Fix: rm ${devVarsPath}\n`));
}

export async function runCommand(ctx: HushContext, options: RunOptions): Promise<void> {
  const { store, cwd, target, command } = options;

  if (options.json) {
    writeJsonError(ctx, 'run', {
      code: 'UNSUPPORTED_MACHINE_MODE',
      message: '`run --json` is not supported because the child process owns stdout.',
      suggestion: 'Use `hush materialize --json` to obtain machine-readable environment metadata without executing a child process.',
    });
    ctx.process.exit(2);
  }

  if (!command || command.length === 0) {
    ctx.logger.error('Usage: hush run -- <command>');
    ctx.logger.error(pc.dim('Example: hush run -- npm start'));
    ctx.logger.error(pc.dim('         hush run -t runtime -- npm start'));
    ctx.process.exit(1);
  }

  let exitStatus: number;

  try {
    const repository = requireV3Repository(store, 'run');
    const { targetName, target: selectedTarget } = selectRuntimeTarget(repository, target);

    exitStatus = withMaterializedTarget(ctx, {
      store,
      repository,
      targetName,
      command: { name: 'run', args: [targetName, '--', ...command] },
      mode: 'memory',
      machineLocal: 'include',
    }, (materialization) => {
      const childEnv: NodeJS.ProcessEnv = {
        ...ctx.process.env,
        ...materialization.env,
      };

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

      if (result.error) {
        throw new Error(`Failed to execute: ${result.error.message}`);
      }

      return result.status ?? 1;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error(pc.red(message));

    // Emit a cross-store hint when a named target is missing and the global
    // store exists and contains that target name.
    if (target && store.mode !== 'global') {
      const hint = globalStoreHint(target, 'target', store.root);
      if (hint) {
        ctx.logger.warn(pc.yellow(`\nHint: ${hint}`));
      }
    }

    ctx.process.exit(1);
  }

  ctx.process.exit(exitStatus);
}
