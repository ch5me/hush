import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { join } from "node:path";

import pc from "picocolors";
import { parse as parseYaml } from "yaml";

import { findProjectRoot, isV3RepositoryRoot } from "../config/loader.js";
import { resolveAgeKeySource, type ResolvedAgeKeySource } from "../core/sops.js";
import { writeJsonSuccess } from "../lib/command-output.js";
import { getProjectIdentifier } from "../project.js";
import {
  resolveStoreContext,
  GLOBAL_STORE_ROOT,
  type ResolveStoreContextOptions,
} from "../store.js";
import type { HushContext } from "../types.js";
import type { HushV3Repository, StoreContext } from "../types.js";
import { shapeTargetArtifacts, type HushShadowedEnvVar } from "../v3/artifacts.js";
import { loadV3Repository } from "../v3/repository.js";
import { resolveV3Target } from "../v3/resolver.js";
import {
  describeLegacyLocalRepositoryFile,
  findLegacyLocalRepositoryFile,
} from "./v3-command-helpers.js";

export interface ShadowFinding extends HushShadowedEnvVar {
  target: string;
}

/**
 * Find every machine-local override that shadows a repository value, across all
 * targets.
 *
 * This is the PROACTIVE half of the shadow guard. The guard itself only fires
 * when someone resolves the affected target, which means the first thing to
 * notice a stale override is usually a production process failing to
 * authenticate. Reporting it from `doctor` turns that into something you find
 * on a quiet afternoon instead of during an incident.
 *
 * Resolution is best-effort per target: a target that cannot resolve (unreadable
 * files for this identity, a genuine collision) is skipped rather than failing
 * the whole check, because those have their own checks and their own errors.
 */
export function findShadowedOverrides(
  ctx: HushContext,
  store: StoreContext,
  repository: HushV3Repository,
): ShadowFinding[] {
  const findings: ShadowFinding[] = [];

  for (const [targetName, target] of Object.entries(repository.manifest.targets ?? {})) {
    try {
      const resolution = resolveV3Target(ctx, {
        store,
        repository,
        targetName,
        command: { name: "doctor", args: [] },
        machineLocal: "include",
      });
      // 'report': doctor's job is to SHOW the shadowing, not to refuse.
      const { shadowed } = shapeTargetArtifacts(targetName, target, resolution, "report");
      findings.push(...shadowed.map((entry) => ({ ...entry, target: targetName })));
    } catch {
      continue;
    }
  }

  return findings;
}

export function describeShadowedOverrides(findings: ShadowFinding[]): string {
  const unique = new Map<string, ShadowFinding>();
  for (const finding of findings) {
    if (!unique.has(finding.key)) unique.set(finding.key, finding);
  }

  const lines = Array.from(unique.values()).map((finding) => {
    const files = finding.shadowedFiles.join(", ") || finding.shadowedPaths.join(", ");
    return `  ${finding.key}: user/local shadows ${files}  ->  hush delete-key ${finding.key} --from local --yes`;
  });

  return (
    `${unique.size} machine-local override(s) shadow a committed repository value. ` +
    "Only this machine sees them, so commands that work here fail everywhere else " +
    "(and value-producing commands now refuse outright):\n" +
    `${lines.join("\n")}\n` +
    "Inspect one with: hush trace <KEY>"
  );
}

interface DoctorOptions {
  startDir: string;
  newRepo?: boolean;
  explicitRoot?: string;
  json?: boolean;
}

function findGitRoot(startDir: string, ctx: HushContext): string | null {
  let current = resolve(startDir);
  while (true) {
    if (ctx.fs.existsSync(ctx.path.join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function formatKeyPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(`${home}/`) ? path.replace(home, "~") : path;
}

function checkSopsKeyMatch(
  ctx: HushContext,
  root: string,
  resolution: ResolvedAgeKeySource,
): { matched: boolean; publicKey?: string; sopsPublicKey?: string } {
  if (!resolution.selectedKeyPath || !ctx.fs.existsSync(resolution.selectedKeyPath)) {
    return { matched: false };
  }

  try {
    const keyContent = ctx.fs.readFileSync(resolution.selectedKeyPath, "utf-8") as string;
    const publicKeyMatch = keyContent.match(/public key: ([a-zA-Z0-9+]+)/);
    const publicKey = publicKeyMatch?.[1];

    const sopsPath = ctx.path.join(root, ".sops.yaml");
    if (!ctx.fs.existsSync(sopsPath)) {
      return { matched: false, publicKey };
    }

    const sopsContent = ctx.fs.readFileSync(sopsPath, "utf-8") as string;
    const sopsAgeMatch = sopsContent.match(/age:\s*([a-zA-Z0-9+]+)/);
    const sopsPublicKey = sopsAgeMatch?.[1];

    return {
      matched: !!publicKey && !!sopsPublicKey && publicKey === sopsPublicKey,
      publicKey,
      sopsPublicKey,
    };
  } catch {
    return { matched: false };
  }
}

interface GlobalStoreTopology {
  /** Whether ~/.hush exists and has a manifest. */
  exists: boolean;
  /** Human-readable display path (e.g. ~/.hush). */
  displayPath: string;
  /** Count of targets declared in the global manifest (names only, no decrypt). */
  targetCount: number;
  /** Count of bundles declared in the global manifest. */
  bundleCount: number;
}

/**
 * Peek at the global store manifest to count targets/bundles.
 * Safe: reads SOPS YAML skeleton (names only), never decrypts values.
 */
function peekGlobalStoreTopology(globalRoot: string): GlobalStoreTopology {
  const home = process.env.HOME ?? "";
  const displayPath =
    home && globalRoot.startsWith(home) ? `~/${globalRoot.slice(home.length + 1)}` : globalRoot;

  const manifestPath = join(globalRoot, ".hush", "manifest.encrypted");
  if (!existsSync(manifestPath)) {
    return { exists: false, displayPath, targetCount: 0, bundleCount: 0 };
  }

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") {
      return { exists: true, displayPath, targetCount: 0, bundleCount: 0 };
    }
    const targets = parsed.targets;
    const bundles = parsed.bundles;
    const targetCount =
      targets && typeof targets === "object" && !Array.isArray(targets)
        ? Object.keys(targets as Record<string, unknown>).length
        : 0;
    const bundleCount =
      bundles && typeof bundles === "object" && !Array.isArray(bundles)
        ? Object.keys(bundles as Record<string, unknown>).length
        : 0;
    return { exists: true, displayPath, targetCount, bundleCount };
  } catch {
    return { exists: true, displayPath, targetCount: 0, bundleCount: 0 };
  }
}

export async function doctorCommand(ctx: HushContext, options: DoctorOptions): Promise<void> {
  const cwd = process.cwd();
  const startDir = options.explicitRoot ? resolve(options.explicitRoot) : cwd;

  const gitRoot = findGitRoot(startDir, ctx);
  const findOptions: ResolveStoreContextOptions = options.newRepo
    ? { ignoreAncestors: true, explicitRoot: startDir }
    : {};
  const store = resolveStoreContext(startDir, "project", findOptions);
  const discovery = findProjectRoot(startDir, options.newRepo ? { ignoreAncestors: true } : {});
  const parentDiscovery = options.newRepo ? null : findProjectRoot(startDir);

  const projectIdentity =
    store.keyIdentity ?? (store.root ? getProjectIdentifier(store.root) : undefined);
  const resolution = resolveAgeKeySource({ root: store.root, keyIdentity: projectIdentity });

  // Compute check results
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // Check 1: Repository found
  checks.push({
    name: "repository_found",
    ok: !!discovery || !!options.newRepo,
    detail: discovery
      ? `${discovery.repositoryKind} at ${discovery.projectRoot}`
      : options.newRepo
        ? `no repo found; --new-repo forces ${startDir}`
        : `no Hush repository found from ${startDir}`,
  });

  // Check 2: Age key found
  checks.push({
    name: "age_key_found",
    ok: !!resolution.selectedKeySource,
    detail: resolution.selectedKeySource
      ? `source: ${resolution.selectedKeySource}${resolution.selectedKeyPath ? `; path: ${formatKeyPath(resolution.selectedKeyPath)}` : ""}`
      : 'no age key found; run "hush keys setup"',
  });

  // Check 3: SOPS key match (only relevant when v3 repo present)
  if (isV3RepositoryRoot(store.root)) {
    const match = checkSopsKeyMatch(ctx, store.root, resolution);
    checks.push({
      name: "sops_key_match",
      ok: match.matched,
      detail: match.matched
        ? "selected key matches .sops.yaml public key"
        : match.publicKey && match.sopsPublicKey
          ? `key mismatch: selected=${match.publicKey} sops=${match.sopsPublicKey}`
          : !match.publicKey
            ? "could not read selected key file"
            : ".sops.yaml not found",
    });

    // Check 4: Repository loads
    try {
      const repo = loadV3Repository(store.root, {
        keyIdentity: store.keyIdentity ?? projectIdentity,
      });
      checks.push({
        name: "repository_loads",
        ok: true,
        detail: `repository loads successfully (${repo.files.length} file(s)); project: ${repo.manifest.metadata?.project ?? "(not set)"}`,
      });

      // Check 5: no committed repository file is still named "local". Legal but
      // near-always a mistake, and a possible disclosure — see the describe().
      const legacyLocal = findLegacyLocalRepositoryFile(repo);
      checks.push({
        name: "storage_class_separation",
        ok: !legacyLocal,
        detail: legacyLocal
          ? describeLegacyLocalRepositoryFile(legacyLocal)
          : "no committed repository file shadows the machine-local override store",
      });

      // Check 6: the reverse direction of check 5 — a machine-local override
      // sitting on top of a committed value. Check 5 catches a repository file
      // misnamed "local"; this catches the real override that silently wins.
      const shadowed = findShadowedOverrides(ctx, store, repo);
      checks.push({
        name: "machine_local_shadowing",
        ok: shadowed.length === 0,
        detail:
          shadowed.length > 0
            ? describeShadowedOverrides(shadowed)
            : "no machine-local override shadows a committed repository value",
      });
    } catch (error) {
      checks.push({
        name: "repository_loads",
        ok: false,
        detail: `failed to load repository: ${(error as Error).message}`,
      });
    }
  }

  // Global store topology (best-effort, never throws).
  const globalTopology =
    store.mode !== "global" ? peekGlobalStoreTopology(GLOBAL_STORE_ROOT) : null;

  if (options.json) {
    writeJsonSuccess(ctx, "doctor", {
      checks,
      storeTopology: {
        resolvedRoot: store.root,
        storeMode: store.mode,
        globalStore: globalTopology
          ? {
              path: globalTopology.displayPath,
              exists: globalTopology.exists,
              targetCount: globalTopology.targetCount,
              bundleCount: globalTopology.bundleCount,
              autoInherited: false,
              compositionNote:
                "not auto-inherited; compose via `hush import add` or pass `--root ~/.hush` for one-off use",
            }
          : null,
      },
    });
    return;
  }

  ctx.logger.log(pc.blue("━".repeat(60)));
  ctx.logger.log(pc.blue(pc.bold("  Hush Doctor")));
  ctx.logger.log(pc.blue("━".repeat(60)));
  ctx.logger.log("");

  // 1. Directory context
  ctx.logger.log(pc.bold("1. Directory Context"));
  ctx.logger.log(pc.dim(`  Current directory:  ${cwd}`));
  ctx.logger.log(pc.dim(`  Git root:           ${gitRoot ?? "(not a git repo)"}`));
  ctx.logger.log("");

  // 2. Repository root discovery
  ctx.logger.log(pc.bold("2. Repository Root Discovery"));

  if (discovery) {
    ctx.logger.log(
      pc.dim(`  Found:              ${discovery.repositoryKind} at ${discovery.projectRoot}`),
    );
  } else {
    ctx.logger.log(pc.yellow(`  No Hush repository found from ${startDir}`));
  }

  if (parentDiscovery && parentDiscovery.projectRoot !== startDir) {
    ctx.logger.log(pc.dim(`  Parent repo:        ${parentDiscovery.projectRoot}`));
    if (options.newRepo) {
      ctx.logger.log(pc.green(`  --new-repo:         ignoring parent, using ${startDir}`));
    }
  }

  ctx.logger.log(pc.dim(`  Resolved root:      ${store.root}`));
  ctx.logger.log(pc.dim(`  Store mode:         ${store.mode}`));
  ctx.logger.log("");

  // 3. Key resolution
  ctx.logger.log(pc.bold("3. Key Resolution"));

  if (resolution.selectedKeySource) {
    ctx.logger.log(pc.green(`  Selected source:    ${resolution.selectedKeySource}`));
  } else {
    ctx.logger.log(pc.red("  Selected source:    (none — no key found)"));
  }

  if (resolution.selectedKeyPath) {
    ctx.logger.log(pc.dim(`  Selected path:      ${formatKeyPath(resolution.selectedKeyPath)}`));
  }

  if (resolution.resolvedKeyIdentity) {
    ctx.logger.log(pc.dim(`  Key identity:       ${resolution.resolvedKeyIdentity}`));
  }

  if (resolution.attemptedKeyPaths.length > 0) {
    ctx.logger.log(pc.dim("  Attempted paths:"));
    for (const path of resolution.attemptedKeyPaths) {
      const exists = ctx.fs.existsSync(path);
      const marker = exists ? pc.green("✓") : pc.red("✗");
      ctx.logger.log(pc.dim(`    ${marker} ${formatKeyPath(path)}`));
    }
  }
  ctx.logger.log("");

  // 4. SOPS key match
  if (isV3RepositoryRoot(store.root)) {
    ctx.logger.log(pc.bold("4. SOPS Key Match"));
    const match = checkSopsKeyMatch(ctx, store.root, resolution);
    if (match.matched) {
      ctx.logger.log(pc.green("  ✓  Selected key matches .sops.yaml public key"));
    } else if (match.publicKey && match.sopsPublicKey) {
      ctx.logger.log(pc.red(`  ✗  Key mismatch`));
      ctx.logger.log(pc.dim(`     Selected key:  ${match.publicKey}`));
      ctx.logger.log(pc.dim(`     .sops.yaml:    ${match.sopsPublicKey}`));
    } else if (!match.publicKey) {
      ctx.logger.log(pc.yellow("  ⚠  Could not read selected key file"));
    } else {
      ctx.logger.log(pc.yellow("  ⚠  .sops.yaml not found"));
    }
    ctx.logger.log("");

    // 5. Decryption check
    ctx.logger.log(pc.bold("5. Decryption Check"));
    try {
      const repo = loadV3Repository(store.root, {
        keyIdentity: store.keyIdentity ?? projectIdentity,
      });
      const fileCount = repo.files.length;
      ctx.logger.log(pc.green(`  ✓  Repository loads successfully (${fileCount} file(s))`));
      ctx.logger.log(
        pc.dim(`  Project identity:   ${repo.manifest.metadata?.project ?? "(not set)"}`),
      );
    } catch (error) {
      ctx.logger.log(pc.red(`  ✗  Failed to load repository`));
      ctx.logger.log(pc.red(`     ${(error as Error).message}`));
    }
    ctx.logger.log("");
  }

  // 6. Store topology
  ctx.logger.log(pc.bold("6. Store Topology"));
  ctx.logger.log(pc.dim(`  Resolved store:     ${store.root}`));
  ctx.logger.log(pc.dim(`  Store mode:         ${store.mode}`));
  if (globalTopology) {
    if (globalTopology.exists) {
      ctx.logger.log(
        pc.dim(
          `  Global store:       ${globalTopology.displayPath} (${globalTopology.targetCount} target(s), ${globalTopology.bundleCount} bundle(s))`,
        ),
      );
    } else {
      ctx.logger.log(pc.dim(`  Global store:       ${globalTopology.displayPath} (not present)`));
    }
    ctx.logger.log(
      pc.dim(
        "  Inheritance:        NOT auto-inherited — compose via `hush import add --source-root ~/.hush` or `hush --root ~/.hush <cmd>` for one-off use",
      ),
    );
  }
  ctx.logger.log("");

  // 7. Recommendations
  ctx.logger.log(pc.bold("7. Recommendations"));
  const issues: string[] = [];

  if (!discovery && !options.newRepo) {
    issues.push('No Hush repository found. Run "hush bootstrap" to create one.');
  }

  if (!resolution.selectedKeySource) {
    issues.push('No age key found. Run "hush keys setup" to configure your key.');
  }

  if (isV3RepositoryRoot(store.root) && resolution.selectedKeySource) {
    const match = checkSopsKeyMatch(ctx, store.root, resolution);
    if (!match.matched && match.publicKey && match.sopsPublicKey) {
      issues.push('Key does not match .sops.yaml. Run "hush keys setup" to sync.');
    }
  }

  if (issues.length === 0) {
    ctx.logger.log(pc.green("  No issues detected. Your Hush configuration looks good."));
  } else {
    for (const issue of issues) {
      ctx.logger.log(pc.yellow(`  • ${issue}`));
    }
  }

  ctx.logger.log("");
  ctx.logger.log(pc.blue("━".repeat(60)));
}
