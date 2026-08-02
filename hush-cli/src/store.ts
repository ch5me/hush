import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { findConfigPath, findProjectRoot, type FindProjectRootOptions } from "./config/loader.js";
import { findKeysByPublicKey } from "./lib/age.js";
import { fs } from "./lib/fs.js";
import { getProjectIdentifier } from "./project.js";
import type { StoreContext, StoreMode } from "./types.js";
import { loadV3Repository } from "./v3/repository.js";
import { getProjectStatePaths } from "./v3/state.js";

export interface ResolveStoreContextOptions extends FindProjectRootOptions {
  /**
   * Force the repository root to this absolute path, skipping all upward
   * discovery. Used by `hush bootstrap --root <dir>` and `hush doctor --root`.
   */
  explicitRoot?: string;
}

export const GLOBAL_STORE_ROOT = join(homedir(), ".hush");
export const GLOBAL_STORE_KEY_IDENTITY = "hush-global";
export const GLOBAL_STORE_STATE_ROOT = join(GLOBAL_STORE_ROOT, "state");

function getSopsPublicKeys(projectRoot: string): string[] {
  const sopsPath = join(projectRoot, ".sops.yaml");
  if (!fs.existsSync(sopsPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(sopsPath, "utf-8") as string;
    return [...content.matchAll(/age:\s*([^\n]+)/g)].flatMap(
      (match) => (match[1] ?? "").match(/age1[a-z0-9]+/g) ?? [],
    );
  } catch {
    return [];
  }
}

function resolveProjectKeyIdentity(
  projectRoot: string,
  repositoryKind: "legacy-v2" | "v3" | undefined,
): string | undefined {
  if (repositoryKind === "v3") {
    try {
      const repository = loadV3Repository(projectRoot);
      const projectIdentity = repository.manifest.metadata?.project;
      if (typeof projectIdentity === "string" && projectIdentity.trim().length > 0) {
        return projectIdentity;
      }
    } catch {
      // Fall back to package.json inference when the v3 repo cannot be decrypted yet.
    }

    const matchedKeys = getSopsPublicKeys(projectRoot)
      .flatMap((recipient) => findKeysByPublicKey(recipient))
      .filter(
        (candidate, index, all) =>
          all.findIndex((entry) => entry.path === candidate.path) === index,
      );
    if (matchedKeys.length === 1) {
      return matchedKeys[0]?.project;
    }
  }

  return getProjectIdentifier(projectRoot);
}

export function resolveStoreContext(
  startDir: string,
  mode: StoreMode,
  options: ResolveStoreContextOptions = {},
): StoreContext {
  if (mode === "global") {
    const root = GLOBAL_STORE_ROOT;
    const store: StoreContext = {
      mode,
      root,
      configPath: findConfigPath(root),
      keyIdentity: GLOBAL_STORE_KEY_IDENTITY,
      displayLabel: "~/.hush",
    };

    const statePaths = getProjectStatePaths(store);

    return {
      ...store,
      projectSlug: statePaths.projectSlug,
      stateRoot: statePaths.stateRoot,
      projectStateRoot: statePaths.projectRoot,
      activeIdentityPath: statePaths.activeIdentityPath,
      auditLogPath: statePaths.auditLogPath,
    };
  }

  const resolvedStart = resolve(startDir);
  const { explicitRoot, ...findOptions } = options;
  const projectInfo = explicitRoot
    ? findProjectRoot(resolve(explicitRoot), { ignoreAncestors: true })
    : findProjectRoot(resolvedStart, findOptions);
  const root = explicitRoot ? resolve(explicitRoot) : (projectInfo?.projectRoot ?? resolvedStart);

  const store: StoreContext = {
    mode,
    root,
    configPath: projectInfo?.configPath ?? findConfigPath(root),
    keyIdentity: resolveProjectKeyIdentity(root, projectInfo?.repositoryKind),
    displayLabel: projectInfo?.configPath ? root : (explicitRoot ?? resolvedStart),
  };

  const statePaths = getProjectStatePaths(store);

  return {
    ...store,
    projectSlug: statePaths.projectSlug,
    stateRoot: statePaths.stateRoot,
    projectStateRoot: statePaths.projectRoot,
    activeIdentityPath: statePaths.activeIdentityPath,
    auditLogPath: statePaths.auditLogPath,
  };
}
