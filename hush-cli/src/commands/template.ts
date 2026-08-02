import type { Environment, HushContext } from "../types.js";
import { createMigrationOnlyCommandError } from "./v3-command-helpers.js";

export interface TemplateOptions {
  root: string;
  env: Environment;
}

export async function templateCommand(ctx: HushContext, options: TemplateOptions): Promise<void> {
  void ctx;
  void options;
  throw createMigrationOnlyCommandError("template");
}
