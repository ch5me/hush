import { parse as parseYaml } from "yaml";

import { fs } from "../lib/fs.js";
import type {
  LegacyHushConfig,
  LegacySourceFiles,
  LegacyTarget,
  LegacyV2Inventory,
} from "../types.js";
import { DEFAULT_SOURCES } from "../types.js";

type RawTargetEntry = Partial<LegacyTarget> & { env?: Record<string, unknown> };

function normalizeLegacyTargets(targets: unknown): LegacyTarget[] {
  if (!targets) {
    return [];
  }

  // Standard format: array of target objects
  if (Array.isArray(targets)) {
    return (targets as (Partial<LegacyTarget> & { dotenv?: string })[]).map(
      (entry) =>
        ({
          ...entry,
          // Infer format from presence of dotenv key when format is not explicit
          format: entry.format ?? (entry.dotenv !== undefined ? "dotenv" : "dotenv"),
        }) as LegacyTarget,
    );
  }

  // Object-keyed format: { targetName: { path, format, ... } }
  // Entries missing path or format are schema-only declarations — skip them.
  if (typeof targets === "object") {
    const result: LegacyTarget[] = [];
    for (const [name, value] of Object.entries(targets as Record<string, RawTargetEntry>)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const entry = value as RawTargetEntry;
      if (!entry.path || !entry.format) {
        // Schema-only declaration without path/format — not a runnable target
        continue;
      }
      result.push({
        name,
        path: entry.path,
        format: entry.format,
        include: entry.include,
        exclude: entry.exclude,
        push_to: entry.push_to,
      });
    }
    return result;
  }

  return [];
}

function parseLegacyV2Config(path: string, content: string): LegacyHushConfig {
  const parsed = parseYaml(content) as Partial<LegacyHushConfig> & {
    schema_version?: number;
    targets?: unknown;
  };

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Expected YAML object in ${path}`);
  }

  return {
    version: parsed.schema_version ?? parsed.version,
    project: parsed.project,
    sources: { ...DEFAULT_SOURCES, ...(parsed.sources as Partial<LegacySourceFiles> | undefined) },
    targets: normalizeLegacyTargets(parsed.targets),
  };
}

export function loadLegacyV2Inventory(projectRoot: string, configPath: string): LegacyV2Inventory {
  const content = fs.readFileSync(configPath, "utf-8") as string;
  const config = parseLegacyV2Config(configPath, content);

  return {
    kind: "legacy-v2",
    projectRoot,
    configPath,
    config,
    sources: [
      { name: "shared", path: config.sources.shared },
      { name: "development", path: config.sources.development },
      { name: "production", path: config.sources.production },
      { name: "local", path: config.sources.local },
    ],
    targets: config.targets.map((target) => ({ ...target })),
  };
}
