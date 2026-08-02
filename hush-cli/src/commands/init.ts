import pc from "picocolors";

import type { HushContext, InitOptions } from "../types.js";
import { bootstrapCommand } from "./bootstrap.js";

export async function initCommand(ctx: HushContext, options: InitOptions): Promise<void> {
  ctx.logger.warn(pc.yellow("`hush init` is deprecated. Use `hush bootstrap` instead."));
  await bootstrapCommand(ctx, { store: options.store, yes: true });
}
