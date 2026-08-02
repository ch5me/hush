import type { EncryptOptions, HushContext } from "../types.js";
import { createMigrationOnlyCommandError } from "./v3-command-helpers.js";

export async function encryptCommand(ctx: HushContext, options: EncryptOptions): Promise<void> {
  void ctx;
  void options;
  throw createMigrationOnlyCommandError("encrypt");
}
