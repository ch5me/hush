import { join } from "node:path";

import pc from "picocolors";

import {
  appendAuditEvent,
  getActiveIdentity,
  materializeV3Bundle,
  materializeV3Target,
} from "../index.js";
import { writeJsonError, writeJsonSuccess } from "../lib/command-output.js";
import type {
  EnvVar,
  HushArtifactDescriptor,
  HushContext,
  HushMaterialization,
  HushTargetArtifactDescriptor,
  MaterializeOptions,
} from "../types.js";
import {
  DEFAULT_PERSISTED_OUTPUT_DIRNAME,
  requireV3Repository,
  selectRuntimeTarget,
} from "./v3-command-helpers.js";

interface MaterializedArtifactRecordBase {
  logicalPath: string;
  kind: "file" | "binary";
  format: string;
  sensitive: boolean;
  path: string;
  relativePath: string;
  suggestedName: string;
  sha256: string;
  source: "target" | "artifact";
}

interface MaterializedArtifactRecordWithProvenance extends MaterializedArtifactRecordBase {
  provenance: HushArtifactDescriptor["provenance"];
  resolvedFrom: HushArtifactDescriptor["resolvedFrom"];
}

type MaterializedArtifactRecord =
  | MaterializedArtifactRecordWithProvenance
  | MaterializedArtifactRecordBase;

interface MaterializeCommandResultBase {
  kind: "target" | "bundle";
  identity: string;
  target?: string;
  bundle?: string;
  repositoryRoot: string;
  outputRoot: string;
  mode: "persisted";
  files: string[];
  logicalPaths: string[];
  targetArtifact: MaterializedArtifactRecord | null;
  artifacts: MaterializedArtifactRecord[];
  cleanupCommand: string;
}

interface MaterializeCompactArtifactRecord {
  logicalPath: string;
  path: string;
  relativePath: string;
  source: "target" | "artifact";
}

interface MaterializeCompactCommandResult {
  kind: "target" | "bundle";
  identity: string;
  target?: string;
  bundle?: string;
  outputRoot: string;
  status: "materialized";
  targetArtifact: MaterializeCompactArtifactRecord | null;
  artifacts: MaterializeCompactArtifactRecord[];
  cleanupCommand: string;
}

type MaterializeCommandResult = MaterializeCommandResultBase | MaterializeCompactCommandResult;

class MaterializeChildCommandError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`Materialized command exited with code ${exitCode}`);
    this.name = "MaterializeChildCommandError";
    this.exitCode = exitCode;
  }
}

function materializationCommandArgs(
  materialization: HushMaterialization,
  childCommand: string[],
): string[] {
  const args = createCommandArgs(materialization);
  if (childCommand.length > 0) {
    args.push("--", ...childCommand);
  }
  return args;
}

function createCommandArgs(materialization: HushMaterialization): string[] {
  const args: string[] = [];

  if (materialization.target) {
    args.push("--target", materialization.target);
  }

  if (materialization.bundle && !materialization.target) {
    args.push("--bundle", materialization.bundle);
  }

  return args;
}

function toOutputRoot(storeRoot: string, outputRoot?: string): string {
  return outputRoot ?? join(storeRoot, DEFAULT_PERSISTED_OUTPUT_DIRNAME);
}

function createDescriptorMap(
  materialization: HushMaterialization,
): Map<string, HushArtifactDescriptor | HushTargetArtifactDescriptor> {
  const map = new Map<string, HushArtifactDescriptor | HushTargetArtifactDescriptor>();

  if (materialization.targetArtifact) {
    map.set(materialization.targetArtifact.logicalPath, materialization.targetArtifact);
  }

  for (const artifact of materialization.artifacts) {
    map.set(artifact.logicalPath, artifact);
  }

  return map;
}

function toArtifactRecord(
  materialization: HushMaterialization,
  logicalPath: string,
  source: "target" | "artifact",
  includeProvenance: boolean,
): MaterializedArtifactRecord | null {
  const staged = materialization.stagedArtifacts.find(
    (artifact) => artifact.logicalPath === logicalPath,
  );
  const descriptor = createDescriptorMap(materialization).get(logicalPath);

  if (!staged || !descriptor) {
    return null;
  }

  const base: MaterializedArtifactRecordBase = {
    logicalPath,
    kind: staged.kind,
    format: staged.format,
    sensitive: staged.sensitive,
    path: staged.path,
    relativePath: descriptor.relativePath,
    suggestedName: descriptor.suggestedName,
    sha256: descriptor.sha256,
    source,
  };

  return includeProvenance
    ? {
        ...base,
        provenance: descriptor.provenance,
        resolvedFrom: descriptor.resolvedFrom,
      }
    : base;
}

function toCompactArtifactRecord(
  record: MaterializedArtifactRecord | null,
): MaterializeCompactArtifactRecord | null {
  if (!record) {
    return null;
  }

  return {
    logicalPath: record.logicalPath,
    path: record.path,
    relativePath: record.relativePath,
    source: record.source,
  };
}

function toCommandResult(
  materialization: HushMaterialization,
  outputRoot: string,
  options: Pick<MaterializeOptions, "compactJson" | "includeProvenance">,
): MaterializeCommandResult {
  const includeProvenance = options.includeProvenance ?? false;
  const targetArtifact = materialization.targetArtifact
    ? toArtifactRecord(
        materialization,
        materialization.targetArtifact.logicalPath,
        "target",
        includeProvenance,
      )
    : null;
  const artifacts = materialization.artifacts
    .map((artifact) =>
      toArtifactRecord(materialization, artifact.logicalPath, "artifact", includeProvenance),
    )
    .filter((artifact): artifact is MaterializedArtifactRecord => artifact !== null);
  const cleanupCommand = `hush materialize --cleanup --output-root ${outputRoot}`;

  if (options.compactJson) {
    return {
      kind: materialization.kind,
      identity: materialization.identity,
      target: materialization.target,
      bundle: materialization.bundle,
      outputRoot,
      status: "materialized",
      targetArtifact: toCompactArtifactRecord(targetArtifact),
      artifacts: artifacts
        .map((artifact) => toCompactArtifactRecord(artifact))
        .filter((artifact): artifact is MaterializeCompactArtifactRecord => artifact !== null),
      cleanupCommand,
    };
  }

  return {
    kind: materialization.kind,
    identity: materialization.identity,
    target: materialization.target,
    bundle: materialization.bundle,
    repositoryRoot: materialization.repositoryRoot,
    outputRoot,
    mode: "persisted",
    files: materialization.files,
    logicalPaths: materialization.logicalPaths,
    targetArtifact,
    artifacts,
    cleanupCommand,
  };
}

function formatText(result: MaterializeCommandResultBase): string {
  const lines: string[] = [pc.blue("Hush materialize\n")];
  const selection = result.target ? `target ${result.target}` : `bundle ${result.bundle}`;

  lines.push(`Selection: ${pc.cyan(selection)}`);
  lines.push(`Active identity: ${pc.green(result.identity)}`);
  lines.push(`Output root: ${pc.dim(result.outputRoot)}`);
  lines.push(`Resolved files: ${pc.cyan(String(result.files.length))}`);
  lines.push("");

  if (result.targetArtifact) {
    lines.push("Target artifact:");
    lines.push(`  ${result.targetArtifact.logicalPath}`);
    lines.push(`    ${pc.dim(result.targetArtifact.path)}`);
    lines.push(`    ${pc.dim(`sha256=${result.targetArtifact.sha256}`)}`);
    lines.push("");
  }

  lines.push("Artifacts:");
  if (result.artifacts.length === 0) {
    lines.push(`  ${pc.dim("(none)")}`);
  } else {
    for (const artifact of result.artifacts) {
      lines.push(`  ${artifact.logicalPath} ${pc.dim(`(${artifact.kind}:${artifact.format})`)}`);
      lines.push(`    ${pc.dim(artifact.path)}`);
      lines.push(`    ${pc.dim(`sha256=${artifact.sha256}`)}`);
    }
  }

  lines.push("");
  lines.push(pc.yellow("Cleanup:"));
  lines.push(`  ${pc.dim(result.cleanupCommand)}`);
  return lines.join("\n");
}

function escapeShellAnsiCString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\f/g, "\\f")
    .replace(/\v/g, "\\v")
    .replace(/\0/g, "\\0");
}

function formatShellExportValue(value: string): string {
  return value.includes("\n") ? `$'${escapeShellAnsiCString(value)}'` : JSON.stringify(value);
}

function formatShellExport(envVars: readonly EnvVar[]): string {
  return envVars
    .map((variable) => `export ${variable.key}=${formatShellExportValue(variable.value)}`)
    .join("\n");
}

function auditSuccess(
  ctx: HushContext,
  options: MaterializeOptions,
  materialization: HushMaterialization,
): void {
  appendAuditEvent(ctx, options.store, {
    type: "materialize",
    activeIdentity: materialization.identity,
    success: true,
    command: { name: "materialize", args: createCommandArgs(materialization) },
    files: materialization.files,
    logicalPaths: materialization.logicalPaths,
    bundle: materialization.bundle,
    target: materialization.target,
    details: {
      repositoryRoot: materialization.repositoryRoot,
      materializationMode: materialization.mode,
    },
  });
}

function auditFailure(
  ctx: HushContext,
  options: MaterializeOptions,
  materialization: HushMaterialization,
  reason: string,
): void {
  const childCommand = options.command ?? [];
  appendAuditEvent(ctx, options.store, {
    type: "materialize",
    activeIdentity: materialization.identity,
    success: false,
    command: {
      name: "materialize",
      args: materializationCommandArgs(materialization, childCommand),
    },
    files: materialization.files,
    logicalPaths: materialization.logicalPaths,
    bundle: materialization.bundle,
    target: materialization.target,
    reason,
    details: {
      repositoryRoot: materialization.repositoryRoot,
      materializationMode: materialization.mode,
    },
  });
}

function cleanupPersistedRoot(ctx: HushContext, outputRoot: string): void {
  if (ctx.fs.existsSync(outputRoot)) {
    ctx.fs.rmSync?.(outputRoot, { recursive: true, force: true });
  }
}

function runChildCommand(
  ctx: HushContext,
  options: MaterializeOptions,
  materialization: HushMaterialization,
  outputRoot: string,
): void {
  const childCommand = options.command ?? [];

  if (childCommand.length === 0) {
    return;
  }

  const [command, ...args] = childCommand;
  const childEnv: NodeJS.ProcessEnv = {
    ...ctx.process.env,
    ...materialization.env,
    HUSH_MATERIALIZE_OUTPUT_ROOT: outputRoot,
  };

  if (materialization.targetArtifact) {
    const stagedTarget = materialization.stagedArtifacts.find(
      (artifact) => artifact.logicalPath === materialization.targetArtifact?.logicalPath,
    );
    if (stagedTarget) {
      childEnv.HUSH_MATERIALIZE_TARGET_PATH = stagedTarget.path;
    }
  }

  const result = ctx.exec.spawnSync(command, args, {
    cwd: ctx.process.cwd(),
    env: childEnv,
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(`Failed to execute materialized command: ${result.error.message}`);
  }

  const interrupted = materialization.interruptedSignal();
  if (interrupted) {
    throw new Error(`Materialized command interrupted by ${interrupted}`);
  }

  if ((result.status ?? 1) !== 0) {
    throw new MaterializeChildCommandError(result.status ?? 1);
  }
}

function createMaterialization(
  ctx: HushContext,
  options: MaterializeOptions,
  outputRoot: string,
): HushMaterialization {
  const repository = requireV3Repository(options.store, "materialize");
  const identity = getActiveIdentity(ctx, options.store);

  return options.bundle
    ? materializeV3Bundle(ctx, {
        store: options.store,
        repository,
        bundleName: options.bundle,
        activeIdentity: identity ?? undefined,
        command: { name: "materialize", args: ["--bundle", options.bundle] },
        mode: "persisted",
        machineLocal: "include",
        outputRoot,
      })
    : (() => {
        const { targetName } = selectRuntimeTarget(repository, options.target);
        return materializeV3Target(ctx, {
          store: options.store,
          repository,
          targetName,
          activeIdentity: identity ?? undefined,
          command: { name: "materialize", args: ["--target", targetName] },
          mode: "persisted",
          machineLocal: "include",
          outputRoot,
        });
      })();
}

export async function materializeCommand(
  ctx: HushContext,
  options: MaterializeOptions,
): Promise<void> {
  const childCommand = options.command ?? [];
  const outputRoot = toOutputRoot(options.store.root, options.outputRoot);

  if (options.cleanup) {
    cleanupPersistedRoot(ctx, outputRoot);
    const payload = { cleaned: true, outputRoot };
    if (options.json) writeJsonSuccess(ctx, "materialize", payload);
    else ctx.logger.log(`${pc.green("Cleaned materialized artifacts")}\n${pc.dim(outputRoot)}`);
    return;
  }

  if (options.target && options.bundle) {
    const message = "Use either --target or --bundle, not both.";
    if (options.json) writeJsonError(ctx, "materialize", { code: "CONFLICTING_SCOPE", message });
    else ctx.logger.error(pc.red(message));
    ctx.process.exit(1);
  }

  if (options.json && childCommand.length > 0) {
    writeJsonError(ctx, "materialize", {
      code: "CONFLICTING_OUTPUT_MODE",
      message: "Use either --json output or a child command after --, not both.",
    });
    ctx.process.exit(1);
  }

  if (options.format && options.format !== "dotenv" && options.format !== "shell-export") {
    const message = `Unsupported materialize format: ${options.format}`;
    if (options.json)
      writeJsonError(ctx, "materialize", {
        code: "UNSUPPORTED_FORMAT",
        message,
        rejectedInput: options.format,
      });
    else ctx.logger.error(pc.red(message));
    ctx.process.exit(1);
  }

  if (!options.json && options.compactJson) {
    ctx.logger.error(pc.red("--compact-json requires --json."));
    ctx.process.exit(1);
  }

  if (!options.json && options.includeProvenance) {
    ctx.logger.error(pc.red("--include-provenance requires --json."));
    ctx.process.exit(1);
  }

  let materialization: HushMaterialization | null = null;
  try {
    materialization = createMaterialization(ctx, options, outputRoot);

    if (childCommand.length > 0) {
      runChildCommand(ctx, { ...options, command: childCommand }, materialization, outputRoot);
      auditSuccess(ctx, options, materialization);
      return;
    }

    auditSuccess(ctx, options, materialization);
    const result = toCommandResult(materialization, outputRoot, options);
    if (options.json) {
      writeJsonSuccess(ctx, "materialize", result);
    } else if (options.format === "shell-export") {
      ctx.logger.log(formatShellExport(materialization.envVars));
    } else {
      ctx.logger.log(formatText(result as MaterializeCommandResultBase));
    }
  } catch (error) {
    if (error instanceof MaterializeChildCommandError) {
      if (materialization) {
        auditFailure(ctx, { ...options, command: childCommand }, materialization, error.message);
      }
      ctx.process.exit(error.exitCode);
    }

    const message = error instanceof Error ? error.message : String(error);
    if (materialization) {
      auditFailure(ctx, { ...options, command: childCommand }, materialization, message);
    }
    if (options.json)
      writeJsonError(ctx, "materialize", { code: "MATERIALIZATION_FAILED", message });
    else ctx.logger.error(pc.red(message));
    ctx.process.exit(1);
  } finally {
    if (childCommand.length > 0) {
      cleanupPersistedRoot(ctx, outputRoot);
    }
  }
}
