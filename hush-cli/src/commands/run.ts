import { basename, delimiter, join } from "node:path";

import pc from "picocolors";

import { withMaterializedTarget } from "../index.js";
import { writeJsonError } from "../lib/command-output.js";
import { globalStoreHint } from "../lib/global-store-hint.js";
import type { HushContext, RunOptions } from "../types.js";
import { requireV3Repository, selectRuntimeTarget } from "./v3-command-helpers.js";

function warnWranglerConflict(ctx: HushContext, cwd: string): void {
  const devVarsPath = join(cwd, ".dev.vars");
  if (!ctx.fs.existsSync(devVarsPath)) {
    return;
  }

  ctx.logger.warn("\n⚠️  Wrangler Conflict Detected");
  ctx.logger.warn(`   Found .dev.vars in ${cwd}`);
  ctx.logger.warn("   Wrangler may ignore injected environment values while this file exists.");
  ctx.logger.warn(pc.bold(`   Fix: rm ${devVarsPath}\n`));
}

const NODE_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

function quoteShellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function findPinnedNodeBin(ctx: HushContext, cwd: string): string | null {
  const pinPath = join(cwd, ".nvmrc");
  if (!ctx.fs.existsSync(pinPath)) return null;

  const pin = String(ctx.fs.readFileSync(pinPath, "utf-8")).trim();
  const match = NODE_VERSION_PATTERN.exec(pin);
  if (!match) throw new Error(`Invalid .nvmrc Node version: ${pin || "(empty)"}`);
  const expected = `v${match[1]}.${match[2]}.${match[3]}`;

  const candidates = [
    ...(ctx.process.env.PATH ?? "").split(delimiter).filter(Boolean),
    process.execPath,
  ];
  for (const candidate of candidates) {
    const node =
      candidate === process.execPath
        ? process.execPath
        : join(candidate, process.platform === "win32" ? "node.exe" : "node");
    if (!ctx.fs.existsSync(node)) continue;
    const result = ctx.exec.spawnSync(node, ["--version"], { encoding: "utf-8" });
    if (result.status === 0 && String(result.stdout).trim() === expected) {
      return candidate === process.execPath ? join(process.execPath, "..") : candidate;
    }
  }

  throw new Error(
    `No Node ${expected} executable from .nvmrc was found on the parent PATH or running Hush launcher.`,
  );
}

function preserveShellPath(command: string[], path: string): string[] {
  const shell = basename(command[0] ?? "");
  if (!["sh", "bash", "zsh"].includes(shell)) return command;

  const commandIndex = command.findIndex((arg, index) => index > 0 && /^-[^-]*c/.test(arg));
  if (commandIndex < 0 || command[commandIndex + 1] === undefined) return command;

  const preserved = [...command];
  preserved[commandIndex + 1] =
    `export PATH=${quoteShellValue(path)}; ${preserved[commandIndex + 1]}`;
  return preserved;
}

export async function runCommand(ctx: HushContext, options: RunOptions): Promise<void> {
  const { store, cwd, target, command } = options;

  if (options.json) {
    writeJsonError(ctx, "run", {
      code: "UNSUPPORTED_MACHINE_MODE",
      message: "`run --json` is not supported because the child process owns stdout.",
      suggestion:
        "Use `hush materialize --json` to obtain machine-readable environment metadata without executing a child process.",
    });
    ctx.process.exit(2);
  }

  if (!command || command.length === 0) {
    ctx.logger.error("Usage: hush run -- <command>");
    ctx.logger.error(pc.dim("Example: hush run -- npm start"));
    ctx.logger.error(pc.dim("         hush run -t runtime -- npm start"));
    ctx.process.exit(1);
  }

  let exitStatus: number;

  try {
    const repository = requireV3Repository(store, "run");
    const { targetName, target: selectedTarget } = selectRuntimeTarget(repository, target);

    exitStatus = withMaterializedTarget(
      ctx,
      {
        store,
        repository,
        targetName,
        command: { name: "run", args: [targetName, "--", ...command] },
        mode: "memory",
        machineLocal: "include",
      },
      (materialization) => {
        const pinnedNodeBin = findPinnedNodeBin(ctx, cwd);
        const childEnv: NodeJS.ProcessEnv = {
          ...ctx.process.env,
          ...materialization.env,
        };
        if (pinnedNodeBin) {
          childEnv.PATH = [pinnedNodeBin, childEnv.PATH].filter(Boolean).join(delimiter);
        }

        if (selectedTarget.format === "wrangler") {
          childEnv.CLOUDFLARE_INCLUDE_PROCESS_ENV = "true";
          warnWranglerConflict(ctx, cwd);
        }

        const [cmd, ...args] = pinnedNodeBin
          ? preserveShellPath(command, childEnv.PATH ?? "")
          : command;
        const result = ctx.exec.spawnSync(cmd, args, {
          stdio: "inherit",
          env: childEnv,
          cwd,
        });

        if (result.error) {
          throw new Error(`Failed to execute: ${result.error.message}`);
        }

        return result.status ?? 1;
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error(pc.red(message));

    // Emit a cross-store hint when a named target is missing and the global
    // store exists and contains that target name.
    if (target && store.mode !== "global") {
      const hint = globalStoreHint(target, "target", store.root);
      if (hint) {
        ctx.logger.warn(pc.yellow(`\nHint: ${hint}`));
      }
    }

    ctx.process.exit(1);
  }

  ctx.process.exit(exitStatus);
}
