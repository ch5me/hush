import type { HushContext, HushV3Repository, StoreContext } from "../types.js";
import type {
  HushArtifactDescriptor,
  HushArtifactShapeResult,
  HushTargetArtifactDescriptor,
} from "./artifacts.js";
import { shadowPolicyFromEnv, shapeBundleArtifacts, shapeResolvedArtifacts } from "./artifacts.js";
import { appendAuditEvent, type HushAuditCommandContext } from "./audit.js";
import type { HushBundleName, HushTargetName } from "./domain.js";
import type { HushImportRepositoryMap } from "./imports.js";
import type { HushBundleResolution, HushTargetResolution } from "./provenance.js";
import { resolveV3Bundle, resolveV3Target, type ResolveV3Options } from "./resolver.js";
import { HushTempController, type HushStagedArtifact } from "./temp.js";

export type HushMaterializationMode = "memory" | "staged" | "persisted";

export interface HushMaterializationOptions extends ResolveV3Options {
  store: StoreContext;
  repository: HushV3Repository;
  importedRepositories?: HushImportRepositoryMap;
  command?: HushAuditCommandContext;
  mode?: HushMaterializationMode;
  outputRoot?: string;
}

export interface HushMaterializeTargetOptions extends HushMaterializationOptions {
  targetName: HushTargetName;
}

export interface HushMaterializeBundleOptions extends HushMaterializationOptions {
  bundleName: HushBundleName;
}

export interface HushMaterialization {
  kind: "target" | "bundle";
  identity: string;
  bundle?: string;
  target?: string;
  repositoryRoot: string;
  files: string[];
  logicalPaths: string[];
  env: Record<string, string>;
  envVars: HushArtifactShapeResult["envVars"];
  targetArtifact: HushTargetArtifactDescriptor | null;
  artifacts: HushArtifactDescriptor[];
  stagedArtifacts: HushStagedArtifact[];
  mode: HushMaterializationMode;
  cleanup(): void;
  interruptedSignal(): "SIGINT" | "SIGTERM" | null;
}

export interface HushMaterializationFailure {
  target?: string;
  bundle?: string;
  reason: string;
}

export class HushMaterializationInterruptedError extends Error {
  readonly signal: "SIGINT" | "SIGTERM";

  constructor(signal: "SIGINT" | "SIGTERM") {
    super(`Materialization interrupted by ${signal}`);
    this.name = "HushMaterializationInterruptedError";
    this.signal = signal;
  }
}

function getMode(mode: HushMaterializationMode | undefined): HushMaterializationMode {
  return mode ?? "memory";
}

function toLogicalPaths(resolution: HushBundleResolution): string[] {
  return [...Object.keys(resolution.values), ...Object.keys(resolution.artifacts)].sort();
}

function buildBundleShape(resolution: HushBundleResolution): HushArtifactShapeResult {
  return shapeBundleArtifacts(resolution);
}

function stageArtifacts(
  controller: HushTempController,
  mode: HushMaterializationMode,
  targetArtifact: HushTargetArtifactDescriptor | null,
  artifacts: HushArtifactDescriptor[],
): HushStagedArtifact[] {
  if (mode === "memory") {
    return [];
  }

  const staged: HushStagedArtifact[] = [];

  if (targetArtifact) {
    staged.push(controller.writeArtifact(targetArtifact));
  }

  for (const artifact of artifacts) {
    staged.push(controller.writeArtifact(artifact));
  }

  return staged;
}

function createMaterialization(
  ctx: HushContext,
  options: HushMaterializationOptions,
  resolution: HushBundleResolution,
  shape: HushArtifactShapeResult,
  kind: "target" | "bundle",
): HushMaterialization {
  const mode = getMode(options.mode);
  const controller = new HushTempController(ctx, {
    persist: mode === "persisted",
    outputRoot: options.outputRoot,
  });

  controller.initialize();

  const stagedArtifacts = stageArtifacts(controller, mode, shape.targetArtifact, shape.artifacts);
  const target = kind === "target" ? (resolution as HushTargetResolution).target : undefined;

  return {
    kind,
    identity: resolution.identity,
    bundle: resolution.bundle,
    target,
    repositoryRoot: options.repository.projectRoot,
    files: resolution.files,
    logicalPaths: toLogicalPaths(resolution),
    env: shape.env,
    envVars: shape.envVars,
    targetArtifact: shape.targetArtifact,
    artifacts: shape.artifacts,
    stagedArtifacts,
    mode,
    cleanup: () => controller.cleanup(),
    interruptedSignal: () => controller.getInterruptedSignal(),
  };
}

function emitMaterializeAudit(
  ctx: HushContext,
  store: StoreContext,
  materialization: Pick<
    HushMaterialization,
    "identity" | "files" | "logicalPaths" | "bundle" | "target" | "repositoryRoot" | "mode"
  >,
  command: HushAuditCommandContext | undefined,
  success: boolean,
  reason?: string,
): void {
  appendAuditEvent(ctx, store, {
    type: "materialize",
    activeIdentity: materialization.identity,
    success,
    command,
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

function toFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function materializeV3Target(
  ctx: HushContext,
  options: HushMaterializeTargetOptions,
): HushMaterialization {
  const target = options.repository.manifest.targets?.[options.targetName];

  if (!target) {
    throw new Error(
      `Target "${options.targetName}" is not declared in repository ${options.repository.projectRoot}`,
    );
  }

  const resolution = resolveV3Target(ctx, options);
  const shape = shapeResolvedArtifacts(
    options.targetName,
    target,
    resolution,
    shadowPolicyFromEnv(ctx),
  );
  return createMaterialization(ctx, options, resolution, shape, "target");
}

export function materializeV3Bundle(
  ctx: HushContext,
  options: HushMaterializeBundleOptions,
): HushMaterialization {
  const resolution = resolveV3Bundle(ctx, options);
  const shape = buildBundleShape(resolution);
  return createMaterialization(ctx, options, resolution, shape, "bundle");
}

export function withMaterializedTarget<T>(
  ctx: HushContext,
  options: HushMaterializeTargetOptions,
  callback: (materialization: HushMaterialization) => T,
): T {
  let materialization: HushMaterialization | null = null;

  try {
    materialization = materializeV3Target(ctx, options);
    const result = callback(materialization);
    const interrupted = materialization.interruptedSignal();

    if (interrupted) {
      throw new HushMaterializationInterruptedError(interrupted);
    }

    emitMaterializeAudit(ctx, options.store, materialization, options.command, true);
    return result;
  } catch (error) {
    const failure = materialization ?? {
      identity: options.activeIdentity ?? "unknown",
      files: [] as string[],
      logicalPaths: [] as string[],
      bundle: undefined,
      target: options.targetName,
      repositoryRoot: options.repository.projectRoot,
      mode: getMode(options.mode),
    };
    emitMaterializeAudit(
      ctx,
      options.store,
      failure,
      options.command,
      false,
      toFailureReason(error),
    );
    throw error;
  } finally {
    materialization?.cleanup();
  }
}

export function withMaterializedBundle<T>(
  ctx: HushContext,
  options: HushMaterializeBundleOptions,
  callback: (materialization: HushMaterialization) => T,
): T {
  let materialization: HushMaterialization | null = null;

  try {
    materialization = materializeV3Bundle(ctx, options);
    const result = callback(materialization);
    const interrupted = materialization.interruptedSignal();

    if (interrupted) {
      throw new HushMaterializationInterruptedError(interrupted);
    }

    emitMaterializeAudit(ctx, options.store, materialization, options.command, true);
    return result;
  } catch (error) {
    const failure = materialization ?? {
      identity: options.activeIdentity ?? "unknown",
      files: [] as string[],
      logicalPaths: [] as string[],
      bundle: options.bundleName,
      target: undefined,
      repositoryRoot: options.repository.projectRoot,
      mode: getMode(options.mode),
    };
    emitMaterializeAudit(
      ctx,
      options.store,
      failure,
      options.command,
      false,
      toFailureReason(error),
    );
    throw error;
  } finally {
    materialization?.cleanup();
  }
}
