import pc from 'picocolors';
import { maskValue } from '../core/mask.js';
import { appendCommandReadAudit, resolveTargetEnvView } from './v3-command-helpers.js';
import type { ListOptions, HushContext } from '../types.js';
import { writeJsonError, writeJsonSuccess } from '../lib/command-output.js';

export async function listCommand(ctx: HushContext, options: ListOptions): Promise<void> {
  try {
    const view = resolveTargetEnvView(ctx, options.store, undefined, {
      name: 'list',
      args: options.reveal ? ['--reveal'] : [],
    });

    appendCommandReadAudit(ctx, options.store, view, {
      name: 'list',
      args: options.reveal ? ['--reveal'] : [],
    });

    if (options.json) {
      writeJsonSuccess(ctx, 'list', {
        target: view.targetName,
        reveal: options.reveal ?? false,
        variables: view.envVars.map(({ key, value }) => ({
          key,
          value: options.reveal ? value : maskValue(value),
        })),
        count: view.envVars.length,
      });
      return;
    }

    ctx.logger.log(pc.blue(`Variables for target ${view.targetName}:\n`));

    if (options.reveal) {
      ctx.logger.error(pc.yellow('Warning: --reveal prints plaintext secret values to stdout.'));
    }

    for (const { key, value } of view.envVars) {
      const displayValue = options.reveal ? value : maskValue(value);
      ctx.logger.log(`${pc.cyan(key)}=${pc.dim(displayValue)}`);
    }

    ctx.logger.log(pc.dim(`\nTotal: ${view.envVars.length} variables`));
    if (!options.reveal) {
      ctx.logger.log(pc.dim('Values are masked. Use --reveal to print plaintext (avoid in AI sessions).'));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) writeJsonError(ctx, 'list', { code: 'RESOLUTION_FAILED', message });
    else ctx.logger.error(pc.red(message));
    ctx.process.exit(1);
  }
}
