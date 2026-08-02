import type { Environment, HushContext } from "../types.js";
import { createMigrationOnlyCommandError } from "./v3-command-helpers.js";

export interface ExpansionsOptions {
  root: string;
  env: Environment;
}

export async function expansionsCommand(
  ctx: HushContext,
  options: ExpansionsOptions,
): Promise<void> {
  void ctx;
  void options;
  throw createMigrationOnlyCommandError("expansions");
}
