import pc from 'picocolors';
import { appendCommandReadAudit, resolveTargetEnvView } from './v3-command-helpers.js';
import type { Environment, HushContext, StoreContext } from '../types.js';
import { globalStoreHint } from '../lib/global-store-hint.js';

export interface HasOptions {
  store: StoreContext;
  env: Environment;
  key: string;
  quiet: boolean;
  json?: boolean;
}

export async function hasCommand(ctx: HushContext, options: HasOptions): Promise<void> {
  const { store, key, quiet, json } = options;
  let exitStatus = 2;

  try {
    const view = resolveTargetEnvView(ctx, store, undefined, {
      name: 'has',
      args: [key],
    });
    const found = view.envVars.find((variable) => variable.key === key);
    const exists = found !== undefined && found.value.length > 0;

    appendCommandReadAudit(ctx, store, view, { name: 'has', args: [key] });

    if (json) {
      ctx.logger.log(JSON.stringify({
        key,
        target: view.targetName,
        exists,
        declared: found !== undefined,
      }, null, 2));
    } else if (!quiet) {
      if (exists) {
        ctx.logger.log(pc.green(`${key} is set (${found!.value.length} chars)`));
      } else if (found) {
        ctx.logger.log(pc.yellow(`${key} exists but is empty`));
      } else {
        ctx.logger.log(pc.red(`${key} not found in target ${view.targetName}`));
        if (store.mode !== 'global') {
          const hint = globalStoreHint(key, 'key', store.root);
          if (hint) {
            ctx.logger.warn(pc.yellow(`\nHint: ${hint}`));
          }
        }
      }
    }

    exitStatus = exists ? 0 : 1;
  } catch (error) {
    if (json) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.log(JSON.stringify({ key, exists: false, error: message }, null, 2));
    } else if (!quiet) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error(pc.red(message));
    }
  }

  ctx.process.exit(exitStatus);
}
