import type { HushContext, StoreContext } from "../types.js";
import { appendAuditEvent, type HushAuditCommandContext } from "./audit.js";
import type { HushIdentityName, HushIdentityRecord } from "./domain.js";
import {
  ensureProjectStateRoot,
  getProjectStatePaths,
  readStateJsonFile,
  writeStateJsonFile,
} from "./state.js";

export const ACTIVE_IDENTITY_STATE_VERSION = 1;

export interface ActiveIdentityStateDocument {
  version: typeof ACTIVE_IDENTITY_STATE_VERSION;
  identity: HushIdentityName;
  updatedAt: string;
}

export type DeclaredIdentities =
  | ReadonlyArray<HushIdentityName>
  | Record<HushIdentityName, HushIdentityRecord>;

export interface SetActiveIdentityOptions {
  store: StoreContext;
  identity: HushIdentityName;
  identities: DeclaredIdentities;
  command?: HushAuditCommandContext;
}

function normalizeIdentityName(identity: string, label: string): HushIdentityName {
  const normalized = identity.trim();

  if (!normalized) {
    throw new Error(`${label} cannot be empty`);
  }

  return normalized;
}

function getDeclaredIdentitySet(identities: DeclaredIdentities): Set<HushIdentityName> {
  return new Set(
    Array.isArray(identities)
      ? identities.map((value) => normalizeIdentityName(value, "Identity"))
      : Object.keys(identities).map((value) => normalizeIdentityName(value, "Identity")),
  );
}

function assertStoredIdentityDocument(
  value: ActiveIdentityStateDocument | null,
): ActiveIdentityStateDocument | null {
  if (!value) {
    return null;
  }

  if (value.version !== ACTIVE_IDENTITY_STATE_VERSION) {
    throw new Error(`Active identity state version must be ${ACTIVE_IDENTITY_STATE_VERSION}`);
  }

  return {
    ...value,
    identity: normalizeIdentityName(value.identity, "Stored active identity"),
  };
}

export function readActiveIdentityState(
  ctx: HushContext,
  store: StoreContext,
): ActiveIdentityStateDocument | null {
  const statePaths = getProjectStatePaths(store);
  return assertStoredIdentityDocument(
    readStateJsonFile<ActiveIdentityStateDocument>(ctx, statePaths.activeIdentityPath),
  );
}

export function getActiveIdentity(ctx: HushContext, store: StoreContext): HushIdentityName | null {
  return readActiveIdentityState(ctx, store)?.identity ?? null;
}

export function requireActiveIdentity(
  ctx: HushContext,
  store: StoreContext,
  identities: DeclaredIdentities,
  command?: HushAuditCommandContext,
): HushIdentityName {
  const declared = getDeclaredIdentitySet(identities);
  const activeIdentity = getActiveIdentity(ctx, store);

  if (!activeIdentity) {
    appendAuditEvent(ctx, store, {
      type: "access_denied",
      success: false,
      command,
      reason: "No active identity is configured for this project state",
    });

    throw new Error("No active identity is configured for this project state");
  }

  if (!declared.has(activeIdentity)) {
    appendAuditEvent(ctx, store, {
      type: "access_denied",
      activeIdentity,
      requestedIdentity: activeIdentity,
      success: false,
      command,
      reason: `Active identity "${activeIdentity}" is not declared in this repository`,
    });

    throw new Error(`Active identity "${activeIdentity}" is not declared in this repository`);
  }

  return activeIdentity;
}

export function setActiveIdentity(
  ctx: HushContext,
  options: SetActiveIdentityOptions,
): ActiveIdentityStateDocument {
  const declared = getDeclaredIdentitySet(options.identities);
  const identity = normalizeIdentityName(options.identity, "Active identity");
  const previousIdentity = getActiveIdentity(ctx, options.store) ?? undefined;

  if (!declared.has(identity)) {
    appendAuditEvent(ctx, options.store, {
      type: "access_denied",
      activeIdentity: previousIdentity,
      requestedIdentity: identity,
      success: false,
      command: options.command,
      reason: `Identity "${identity}" is not declared in this repository`,
    });

    throw new Error(`Identity "${identity}" is not declared in this repository`);
  }

  const statePaths = getProjectStatePaths(options.store);
  const document: ActiveIdentityStateDocument = {
    version: ACTIVE_IDENTITY_STATE_VERSION,
    identity,
    updatedAt: new Date().toISOString(),
  };

  ensureProjectStateRoot(ctx, options.store);
  writeStateJsonFile(ctx, statePaths.activeIdentityPath, document);

  appendAuditEvent(ctx, options.store, {
    type: "identity_change",
    activeIdentity: identity,
    previousIdentity,
    nextIdentity: identity,
    requestedIdentity: identity,
    success: true,
    command: options.command,
  });

  return document;
}
