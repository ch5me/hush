import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HushContext, StoreContext } from "../types.js";

export const HUSH_MACHINE_ROOT = join(homedir(), ".hush");
export const HUSH_STATE_DIRNAME = "state";
export const HUSH_STATE_PROJECTS_DIRNAME = "projects";
export const ACTIVE_IDENTITY_STATE_BASENAME = "active-identity.json";
export const AUDIT_LOG_BASENAME = "audit.jsonl";

export interface HushProjectStatePaths {
  projectSlug: string;
  stateRoot: string;
  projectsRoot: string;
  projectRoot: string;
  activeIdentityPath: string;
  auditLogPath: string;
}

function normalizeSlugPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getStoreStateSeed(store: StoreContext): string {
  if (store.mode === "global") {
    return store.keyIdentity ?? "hush-global";
  }

  return store.keyIdentity ?? store.root;
}

export function createProjectSlug(seed: string): string {
  const normalizedSeed = seed.trim();

  if (!normalizedSeed) {
    throw new Error("Project slug seed cannot be empty");
  }

  const base = normalizeSlugPart(normalizedSeed) || "project";
  const hash = createHash("sha256").update(normalizedSeed).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

export function getProjectStatePaths(store: StoreContext): HushProjectStatePaths {
  const projectSlug = store.projectSlug ?? createProjectSlug(getStoreStateSeed(store));
  const stateRoot = store.stateRoot ?? join(HUSH_MACHINE_ROOT, HUSH_STATE_DIRNAME);
  const projectsRoot = join(stateRoot, HUSH_STATE_PROJECTS_DIRNAME);
  const projectRoot = store.projectStateRoot ?? join(projectsRoot, projectSlug);
  const activeIdentityPath =
    store.activeIdentityPath ?? join(projectRoot, ACTIVE_IDENTITY_STATE_BASENAME);
  const auditLogPath = store.auditLogPath ?? join(projectRoot, AUDIT_LOG_BASENAME);

  return {
    projectSlug,
    stateRoot,
    projectsRoot,
    projectRoot,
    activeIdentityPath,
    auditLogPath,
  };
}

export function ensureProjectStateRoot(ctx: HushContext, store: StoreContext): string {
  const statePaths = getProjectStatePaths(store);
  ctx.fs.mkdirSync(statePaths.projectRoot, { recursive: true });
  return statePaths.projectRoot;
}

export function readStateJsonFile<T>(ctx: HushContext, filePath: string): T | null {
  if (!ctx.fs.existsSync(filePath)) {
    return null;
  }

  const raw = ctx.fs.readFileSync(filePath, "utf-8");
  const content = typeof raw === "string" ? raw : raw.toString("utf-8");
  return JSON.parse(content) as T;
}

export function writeStateJsonFile(ctx: HushContext, filePath: string, value: unknown): void {
  ctx.fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
