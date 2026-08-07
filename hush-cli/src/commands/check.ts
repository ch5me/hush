import { join } from "node:path";

import pc from "picocolors";

import { findProjectRoot, isV3RepositoryRoot } from "../config/loader.js";
import { writeJsonError, writeJsonSuccess } from "../lib/command-output.js";
import type {
  CheckFileResult,
  CheckOptions,
  CheckResult,
  HushContext,
  PlaintextFileResult,
} from "../types.js";
import {
  assertNoReaderRecipientDrift,
  loadV3Repository,
  ReaderRecipientDriftError,
} from "../v3/repository.js";
import { DEFAULT_PERSISTED_OUTPUT_DIRNAME } from "./v3-command-helpers.js";

const LEFTOVER_ARTIFACT_NAMES = new Set([
  "hush.yaml",
  "hush.yml",
  ".env",
  ".env.development",
  ".env.production",
  ".env.local",
  ".env.staging",
  ".env.test",
  ".dev.vars",
  ".hush",
  ".hush.development",
  ".hush.production",
  ".hush.local",
  ".hush.encrypted",
  ".hush.development.encrypted",
  ".hush.production.encrypted",
  ".hush.local.encrypted",
]);

const SKIP_SCAN_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt"]);

function scanForLeftoverArtifacts(ctx: HushContext, root: string): PlaintextFileResult[] {
  const findings: PlaintextFileResult[] = [];

  function walk(currentDir: string, relativeDir = ""): void {
    let entries: string[] = [];

    try {
      entries = ctx.fs.readdirSync(currentDir) as string[];
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_SCAN_DIRS.has(entry)) {
        continue;
      }

      const absolutePath = join(currentDir, entry);
      const relativePath = relativeDir ? `${relativeDir}/${entry}` : entry;

      try {
        const stats = ctx.fs.statSync(absolutePath);

        if (stats.isDirectory()) {
          if (relativePath === DEFAULT_PERSISTED_OUTPUT_DIRNAME) {
            let dirFiles: string[] = [];
            try {
              dirFiles = ctx.fs.readdirSync(absolutePath) as string[];
            } catch {
              // ignore unreadable directory
            }
            if (dirFiles.length > 0) {
              findings.push({ file: relativePath, keyCount: 0 });
            }
            continue;
          }

          walk(absolutePath, relativePath);
          continue;
        }

        if (LEFTOVER_ARTIFACT_NAMES.has(entry)) {
          findings.push({ file: relativePath, keyCount: 0 });
        }
      } catch {
        continue;
      }
    }
  }

  walk(root);
  return findings.sort((left, right) => left.file.localeCompare(right.file));
}

function buildRepositoryFileResults(
  repository: ReturnType<typeof loadV3Repository>,
): CheckFileResult[] {
  return [
    {
      source: "manifest",
      encrypted: repository.manifestPath,
      inSync: true,
      added: [],
      removed: [],
      changed: [],
    },
    ...repository.files
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        source: file.path,
        encrypted: repository.fileSystemPaths[file.path]!,
        inSync: true,
        added: [],
        removed: [],
        changed: [],
      })),
  ];
}

export async function check(ctx: HushContext, options: CheckOptions): Promise<CheckResult> {
  if (!isV3RepositoryRoot(options.store.root)) {
    const projectInfo = findProjectRoot(options.store.root);
    return {
      status: "error",
      files: [
        {
          source: "repository",
          encrypted:
            projectInfo?.repositoryKind === "legacy-v2"
              ? `Legacy hush.yaml repo detected at ${projectInfo.configPath}. Run hush migrate --from v2 first.`
              : `Missing Hush repository at ${options.store.root}.`,
          inSync: false,
          added: [],
          removed: [],
          changed: [],
          error: "DECRYPT_FAILED",
        },
      ],
    };
  }

  try {
    const repository = loadV3Repository(options.store.root, {
      keyIdentity: options.store.keyIdentity,
    });
    // A file whose readers.identities cannot be backed by its actual age
    // recipients is a structural integrity failure, not a plaintext-leftover
    // warning: it means the repository's own access-control promise is false.
    // See ReaderRecipientDriftError for the exact invariant.
    assertNoReaderRecipientDrift(repository);
    const plaintextFiles = options.allowPlaintext
      ? []
      : scanForLeftoverArtifacts(ctx, options.store.root);

    return {
      status: plaintextFiles.length > 0 ? "plaintext" : "ok",
      files: buildRepositoryFileResults(repository),
      plaintextFiles: plaintextFiles.length > 0 ? plaintextFiles : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      files: [
        {
          source: "repository",
          encrypted: message,
          inSync: false,
          added: [],
          removed: [],
          changed: [],
          error:
            error instanceof ReaderRecipientDriftError
              ? "READER_RECIPIENT_DRIFT"
              : "DECRYPT_FAILED",
        },
      ],
    };
  }
}

function formatTextOutput(result: CheckResult): string {
  const lines: string[] = [];
  lines.push("Checking repository integrity...\n");

  if (result.plaintextFiles && result.plaintextFiles.length > 0) {
    lines.push(pc.red(pc.bold("⚠ LEFTOVER PLAINTEXT OR LEGACY ARTIFACTS DETECTED")));
    lines.push("");
    lines.push(pc.red("The following artifacts should be removed or migrated:"));
    for (const artifact of result.plaintextFiles) {
      if (artifact.file === DEFAULT_PERSISTED_OUTPUT_DIRNAME) {
        lines.push(pc.red(`  • ${artifact.file}  (materialized plaintext output)`));
        lines.push(
          pc.dim(
            `    Run \`hush materialize --cleanup\` or delete the directory; ensure it is gitignored.`,
          ),
        );
      } else {
        lines.push(pc.red(`  • ${artifact.file}`));
      }
    }
    lines.push("");
    lines.push(
      pc.yellow("These files or directories break the encrypted-at-rest repository model."),
    );
    lines.push(
      pc.dim(
        "Delete them, migrate them, or use --allow-plaintext only when you intentionally need persisted output.",
      ),
    );
    lines.push("");
  }

  for (const file of result.files) {
    if (
      file.source === "repository" &&
      (file.error === "DECRYPT_FAILED" || file.error === "READER_RECIPIENT_DRIFT")
    ) {
      lines.push(pc.red("Repository validation failed:"));
      lines.push(pc.red(`  ${file.encrypted}`));
      lines.push("");
      continue;
    }

    lines.push(`${file.source} ${pc.dim("->")} ${file.encrypted}`);
    lines.push(pc.green("  ✓ Valid"));
    lines.push("");
  }

  if (result.status === "error") {
    lines.push(pc.red("✗ Repository integrity check failed"));
  } else if (result.status === "plaintext") {
    lines.push(pc.yellow("✗ Repository valid, but leftover plaintext/legacy artifacts remain"));
  } else {
    lines.push(pc.green("✓ Repository is valid and free of leftover plaintext artifacts"));
  }

  return lines.join("\n");
}

export async function checkCommand(ctx: HushContext, options: CheckOptions): Promise<void> {
  const result = await check(ctx, options);

  if (!options.quiet) {
    if (options.json) {
      if (result.status === "error") {
        writeJsonError(ctx, "check", {
          code: "REPOSITORY_CHECK_FAILED",
          message:
            result.files.find((file) => file.error)?.encrypted ??
            "Repository integrity check failed",
          details: result,
        });
      } else {
        writeJsonSuccess(ctx, "check", result);
      }
    } else {
      ctx.logger.log(formatTextOutput(result));
    }
  }

  if (result.status === "plaintext" && !options.warn) {
    ctx.process.exit(4);
  }

  if (result.status === "error") {
    ctx.process.exit(3);
  }

  ctx.process.exit(0);
}
