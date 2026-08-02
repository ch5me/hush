import type { HushContext, StoreContext, StoreMode } from "../types.js";
import type {
  HushIdentityName,
  HushLogicalPath,
  HushFilePath,
  HushTargetName,
  HushBundleName,
} from "./domain.js";
import { ensureProjectStateRoot, getProjectStatePaths } from "./state.js";

export const HUSH_AUDIT_EVENT_VERSION = 1;

export type HushAuditEventType =
  | "identity_change"
  | "read_attempt"
  | "write"
  | "metadata_change"
  | "import_resolution"
  | "materialize"
  | "access_denied";

export interface HushAuditCommandContext {
  name: string;
  args?: string[];
}

export interface HushAuditEvent {
  version: typeof HUSH_AUDIT_EVENT_VERSION;
  type: HushAuditEventType;
  timestamp: string;
  projectSlug: string;
  storeMode: StoreMode;
  storeRoot: string;
  activeIdentity?: HushIdentityName;
  success: boolean;
  command?: HushAuditCommandContext;
  files?: HushFilePath[];
  logicalPaths?: HushLogicalPath[];
  bundle?: HushBundleName;
  target?: HushTargetName;
  importProject?: string;
  requestedIdentity?: HushIdentityName;
  previousIdentity?: HushIdentityName;
  nextIdentity?: HushIdentityName;
  reason?: string;
  details?: Record<string, string | number | boolean | null | string[] | number[] | boolean[]>;
}

export interface AppendAuditEventInput {
  type: HushAuditEventType;
  activeIdentity?: HushIdentityName;
  success: boolean;
  command?: HushAuditCommandContext;
  files?: HushFilePath[];
  logicalPaths?: HushLogicalPath[];
  bundle?: HushBundleName;
  target?: HushTargetName;
  importProject?: string;
  requestedIdentity?: HushIdentityName;
  previousIdentity?: HushIdentityName;
  nextIdentity?: HushIdentityName;
  reason?: string;
  details?: Record<string, string | number | boolean | null | string[] | number[] | boolean[]>;
}

export function createAuditEvent(
  store: StoreContext,
  input: AppendAuditEventInput,
): HushAuditEvent {
  const statePaths = getProjectStatePaths(store);

  return {
    version: HUSH_AUDIT_EVENT_VERSION,
    type: input.type,
    timestamp: new Date().toISOString(),
    projectSlug: statePaths.projectSlug,
    storeMode: store.mode,
    storeRoot: store.root,
    activeIdentity: input.activeIdentity,
    success: input.success,
    command: input.command,
    files: input.files,
    logicalPaths: input.logicalPaths,
    bundle: input.bundle,
    target: input.target,
    importProject: input.importProject,
    requestedIdentity: input.requestedIdentity,
    previousIdentity: input.previousIdentity,
    nextIdentity: input.nextIdentity,
    reason: input.reason,
    details: input.details,
  };
}

export function serializeAuditEvent(event: HushAuditEvent): string {
  return JSON.stringify(event);
}

export function appendAuditEvent(
  ctx: HushContext,
  store: StoreContext,
  input: AppendAuditEventInput,
): HushAuditEvent {
  const statePaths = getProjectStatePaths(store);
  const event = createAuditEvent(store, input);

  try {
    ensureProjectStateRoot(ctx, store);
    ctx.fs.writeFileSync(statePaths.auditLogPath, `${serializeAuditEvent(event)}\n`, {
      encoding: "utf-8",
      flag: "a",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Audit telemetry must never turn an already-committed mutation into an
    // apparent command failure. Surface the degraded audit state loudly while
    // preserving the mutation's truthful outcome.
    ctx.logger.warn(`warning: unable to append Hush audit event: ${reason}`);
  }

  return event;
}
