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

// .nvmrc accepts the same specificity nvm/fnm do: a bare major ("24"), a
// major.minor ("24.19"), or a full major.minor.patch ("24.19.0"). Whatever
// precision the repo declares is the precision that must match — a full
// triple still demands an exact installed patch (unchanged, reproducible
// pin); a bare major floats across any patch of that major, which is what a
// repo whose toolchain manifest already declares a floating major (e.g.
// `.mise.toml`'s `node = "24"`) actually wants. This does not weaken the
// exact-pin case: it only makes the previously-rejected floating forms
// resolvable, so a repo can make its .nvmrc match what it already declared
// elsewhere instead of carrying an accidental exact pin nothing maintains.
const NODE_VERSION_PATTERN = /^v?(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/;
const INSTALLED_NODE_VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;

interface NodeVersionSpec {
  raw: string;
  major: number;
  minor: number | null;
  patch: number | null;
}

/** @internal exported for unit tests only */
export function parseNodeVersionSpec(pin: string): NodeVersionSpec {
  const match = NODE_VERSION_PATTERN.exec(pin);
  if (!match) throw new Error(`Invalid .nvmrc Node version: ${pin || "(empty)"}`);
  return {
    raw: pin,
    major: Number(match[1]),
    minor: match[2] === undefined ? null : Number(match[2]),
    patch: match[3] === undefined ? null : Number(match[3]),
  };
}

/** @internal exported for unit tests only */
export function nodeVersionMatchesSpec(
  installed: { major: number; minor: number; patch: number },
  spec: NodeVersionSpec,
): boolean {
  if (installed.major !== spec.major) return false;
  if (spec.minor !== null && installed.minor !== spec.minor) return false;
  if (spec.patch !== null && installed.patch !== spec.patch) return false;
  return true;
}

function quoteShellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
/** @internal exported for unit tests only */
export function findPinnedNodeBin(ctx: HushContext, cwd: string): string | null {
  const pinPath = join(cwd, ".nvmrc");
  if (!ctx.fs.existsSync(pinPath)) return null;

  const pin = String(ctx.fs.readFileSync(pinPath, "utf-8")).trim();
  const spec = parseNodeVersionSpec(pin);

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
    if (result.status !== 0) continue;
    const versionMatch = INSTALLED_NODE_VERSION_PATTERN.exec(String(result.stdout).trim());
    if (!versionMatch) continue;
    const installed = {
      major: Number(versionMatch[1]),
      minor: Number(versionMatch[2]),
      patch: Number(versionMatch[3]),
    };
    if (nodeVersionMatchesSpec(installed, spec)) {
      return candidate === process.execPath ? join(process.execPath, "..") : candidate;
    }
  }

  throw new Error(
    `No Node matching .nvmrc pin "${pin}" was found on the parent PATH or running Hush launcher.`,
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
