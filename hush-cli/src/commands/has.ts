import pc from "picocolors";

import { writeJsonError, writeJsonSuccess } from "../lib/command-output.js";
import { globalStoreHint } from "../lib/global-store-hint.js";
import type { Environment, HushContext, StoreContext } from "../types.js";
import { appendCommandReadAudit, resolveTargetEnvView } from "./v3-command-helpers.js";

export interface HasOptions {
  store: StoreContext;
  env: Environment;
  key: string;
  target?: string;
  quiet: boolean;
  json?: boolean;
}

export async function hasCommand(ctx: HushContext, options: HasOptions): Promise<void> {
  const { store, key, target, quiet, json } = options;
  let exitStatus = 2;

  try {
    const view = resolveTargetEnvView(ctx, store, target, {
      name: "has",
      args: target ? [key, "--target", target] : [key],
      supportsTargetFlag: true,
    });
    const found = view.envVars.find((variable) => variable.key === key);
    const exists = found !== undefined && found.value.length > 0;

    appendCommandReadAudit(ctx, store, view, {
      name: "has",
      args: target ? [key, "--target", target] : [key],
    });

    if (json) {
      writeJsonSuccess(ctx, "has", {
        key,
        target: view.targetName,
        exists,
        declared: found !== undefined,
      });
    } else if (!quiet) {
      if (exists) {
        ctx.logger.log(pc.green(`${key} is set (${found!.value.length} chars)`));
      } else if (found) {
        ctx.logger.log(pc.yellow(`${key} exists but is empty`));
      } else {
        ctx.logger.log(pc.red(`${key} not found in target ${view.targetName}`));
        if (store.mode !== "global") {
          const hint = globalStoreHint(key, "key", store.root);
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
      writeJsonError(ctx, "has", {
        code: "RESOLUTION_FAILED",
        message,
        rejectedInput: key,
        details: { key, exists: false },
      });
    } else if (!quiet) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error(pc.red(message));
    }
  }

  ctx.process.exit(exitStatus);
}
