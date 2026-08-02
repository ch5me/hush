import { join, dirname, resolve } from "node:path";

import { fs } from "../lib/fs.js";
import type {
  HushProjectDiscoveryResult,
  HushProjectRuntimeAuthority,
  LegacyHushConfig,
} from "../types.js";
import { CURRENT_SCHEMA_VERSION } from "../types.js";
import { loadLegacyV2Inventory } from "../v3/legacy-v2.js";
import { getV3ManifestPath } from "../v3/paths.js";
import { loadV3Repository } from "../v3/repository.js";

const CONFIG_FILENAMES = ["hush.yaml", "hush.yml"];

export function findConfigPath(root: string): string | null {
  for (const filename of CONFIG_FILENAMES) {
    const configPath = join(root, filename);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }
  return null;
}

export function isV3RepositoryRoot(root: string): boolean {
  return fs.existsSync(getV3ManifestPath(root));
}

export interface FindProjectRootOptions {
  /**
   * If true, only check `startDir` itself; do not walk upward into ancestor
   * directories. Used by `hush bootstrap --new-repo` to force creation of a
   * child-local repository even when a parent `.hush/` exists.
   */
  ignoreAncestors?: boolean;
  /**
   * If true, stop walking upward at git repository boundaries (i.e. the first
   * directory that contains its own `.git/`). Prevents nested git repos from
   * silently inheriting a parent's `.hush/` repository.
   */
  stopAtGitRoot?: boolean;
}

function isGitRepositoryRoot(dir: string): boolean {
  try {
    return fs.existsSync(join(dir, ".git"));
  } catch {
    return false;
  }
}

export function findProjectRoot(
  startDir: string,
  options: FindProjectRootOptions = {},
): HushProjectDiscoveryResult | null {
  const { ignoreAncestors = false, stopAtGitRoot = true } = options;
  let currentDir = resolve(startDir);
  const startedAtGitRoot = stopAtGitRoot && isGitRepositoryRoot(currentDir);

  while (true) {
    if (isV3RepositoryRoot(currentDir)) {
      return {
        repositoryKind: "v3",
        configPath: findConfigPath(currentDir),
        projectRoot: currentDir,
      };
    }

    const configPath = findConfigPath(currentDir);
    if (configPath) {
      return {
        repositoryKind: "legacy-v2",
        configPath,
        projectRoot: currentDir,
      };
    }

    if (ignoreAncestors) {
      return null;
    }

    if (stopAtGitRoot && !startedAtGitRoot && isGitRepositoryRoot(currentDir)) {
      // Hit a git boundary above the start directory before finding a Hush repo.
      return null;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function getNoConfigGuidance(root: string): string {
  return [
    `No Hush repository found at ${root}.`,
    'Bootstrap a v3 repository with "hush bootstrap".',
    'If you are still on legacy config, initialize hush.yaml explicitly with "hush init".',
  ].join(" ");
}

export function loadProjectRuntimeAuthority(
  root: string,
  options?: { keyIdentity?: string },
): HushProjectRuntimeAuthority {
  if (isV3RepositoryRoot(root)) {
    return loadV3Repository(root, options);
  }

  const configPath = findConfigPath(root);

  if (!configPath) {
    throw new Error(getNoConfigGuidance(root));
  }

  return loadLegacyV2Inventory(root, configPath);
}

export function loadConfig(root: string): LegacyHushConfig {
  const authority = loadProjectRuntimeAuthority(root);

  if (authority.kind === "v3") {
    throw new Error(
      `This project uses Hush v3 encrypted repository storage at ${authority.manifestPath}. ` +
        "Legacy hush.yaml runtime loading is disabled; use the v3 repository loader instead.",
    );
  }

  return authority.config;
}

export function checkSchemaVersion(config: LegacyHushConfig): {
  needsMigration: boolean;
  from: number;
  to: number;
} {
  const configVersion = config.version ?? 1;
  return {
    needsMigration: configVersion < CURRENT_SCHEMA_VERSION,
    from: configVersion,
    to: CURRENT_SCHEMA_VERSION,
  };
}

export function validateConfig(config: LegacyHushConfig): string[] {
  const errors: string[] = [];
  const validFormats = ["dotenv", "wrangler", "vercel", "json", "shell", "yaml"];
  const validPushTypes = ["cloudflare-workers", "cloudflare-pages", "vercel"];
  const validVercelEnvironments = ["production", "preview", "development"];

  if (!config.sources.shared) {
    errors.push("sources.shared is required");
  }

  if (!config.targets || config.targets.length === 0) {
    errors.push("At least one target is required");
  }

  for (let i = 0; i < config.targets.length; i++) {
    const target = config.targets[i];
    const prefix = target.name ? `Target "${target.name}"` : `Target at index ${i}`;

    if (!target.name) {
      errors.push(`${prefix}: missing required field "name"`);
    }
    if (!target.path) {
      errors.push(`${prefix}: missing required field "path" (e.g., "." or "./apps/web")`);
    }
    if (!target.format) {
      errors.push(
        `${prefix}: missing required field "format" (one of: ${validFormats.join(", ")})`,
      );
    } else if (!validFormats.includes(target.format)) {
      errors.push(
        `${prefix}: invalid format "${target.format}" (must be one of: ${validFormats.join(", ")})`,
      );
    }

    // Validate push_to configuration
    if (target.push_to) {
      if (!target.push_to.type) {
        errors.push(`${prefix}: push_to.type is required (one of: ${validPushTypes.join(", ")})`);
      } else if (!validPushTypes.includes(target.push_to.type)) {
        errors.push(
          `${prefix}: invalid push_to.type "${target.push_to.type}" (must be one of: ${validPushTypes.join(", ")})`,
        );
      } else if (target.push_to.type === "cloudflare-pages") {
        const pagesConfig = target.push_to as { type: string; project?: string };
        if (!pagesConfig.project) {
          errors.push(`${prefix}: push_to.project is required for cloudflare-pages`);
        }
      } else if (target.push_to.type === "vercel") {
        const vercelConfig = target.push_to as {
          type: string;
          projectId?: string;
          environments?: unknown;
        };
        if (!vercelConfig.projectId) {
          errors.push(`${prefix}: push_to.projectId is required for vercel`);
        }
        if (!Array.isArray(vercelConfig.environments) || vercelConfig.environments.length === 0) {
          errors.push(
            `${prefix}: push_to.environments must contain at least one Vercel environment`,
          );
        } else if (
          vercelConfig.environments.some(
            (environment) => !validVercelEnvironments.includes(String(environment)),
          )
        ) {
          errors.push(
            `${prefix}: push_to.environments must be drawn from ${validVercelEnvironments.join(", ")}`,
          );
        }
      }
    }
  }

  return errors;
}
