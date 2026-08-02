import { join } from "node:path";
import { createInterface } from "node:readline";

import pc from "picocolors";

import { formatVars } from "../formats/index.js";
import { withMaterializedTarget } from "../index.js";
import type { DecryptOptions, HushContext } from "../types.js";
import { DEFAULT_PERSISTED_OUTPUT_DIRNAME, requireV3Repository } from "./v3-command-helpers.js";

async function confirmDangerousOperation(ctx: HushContext, outputRoot: string): Promise<boolean> {
  if (!ctx.process.stdin.isTTY) {
    ctx.logger.error("\nError: decrypt --force requires interactive confirmation.");
    ctx.logger.error("This command cannot be run in non-interactive environments.");
    ctx.logger.error('\nUse "hush run -- <command>" instead to inject secrets into memory.');
    return false;
  }

  ctx.logger.log("");
  ctx.logger.log(pc.red("━".repeat(70)));
  ctx.logger.log(pc.red(pc.bold("  ⚠️  WARNING: WRITING PERSISTED PLAINTEXT ARTIFACTS")));
  ctx.logger.log(pc.red("━".repeat(70)));
  ctx.logger.log("");
  ctx.logger.log(pc.yellow("  This will materialize readable secrets under:"));
  ctx.logger.log(pc.dim(`    ${outputRoot}`));
  ctx.logger.log(pc.dim("    • Files stay on disk until you delete them"));
  ctx.logger.log(pc.dim("    • Other tools and AI agents can read them"));
  ctx.logger.log(pc.dim("    • hush check will flag the leftover artifacts"));
  ctx.logger.log("");
  ctx.logger.log(pc.green("  Recommended alternative:"));
  ctx.logger.log(pc.cyan("    hush run -- <command>"));
  ctx.logger.log(pc.dim("    Decrypts to memory only, secrets never touch disk."));
  ctx.logger.log("");
  ctx.logger.log(pc.red("━".repeat(70)));
  ctx.logger.log("");

  const rl = createInterface({
    input: ctx.process.stdin,
    output: ctx.process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${pc.bold('Type "yes" to proceed:')} `, (answer) => {
      rl.close();
      if (answer.toLowerCase() === "yes") {
        ctx.logger.log("");
        resolve(true);
      } else {
        ctx.logger.log(pc.dim("\nAborted. No files were written."));
        resolve(false);
      }
    });
  });
}

function getPersistedTargetNames(repository: ReturnType<typeof requireV3Repository>): string[] {
  const targets = Object.entries(repository.manifest.targets ?? {})
    .filter(([, target]) => target.mode !== "example")
    .map(([name]) => name)
    .sort();

  if (targets.length > 0) {
    return targets;
  }

  return Object.keys(repository.manifest.targets ?? {}).sort();
}

export async function decryptCommand(ctx: HushContext, options: DecryptOptions): Promise<void> {
  if (!options.force) {
    console.error(pc.red("Error: decrypt requires --force flag"));
    console.error("");
    console.error(
      pc.dim(
        "This command writes persisted plaintext artifacts to disk, which is generally unsafe.",
      ),
    );
    console.error(pc.dim('Use "hush run -- <command>" instead for memory-only decryption.'));
    console.error("");
    console.error(pc.dim("If you really need persisted plaintext output:"));
    console.error(pc.cyan("  hush decrypt --force"));
    process.exit(1);
  }

  const repository = requireV3Repository(options.store, "decrypt");
  const outputRoot = join(options.store.root, DEFAULT_PERSISTED_OUTPUT_DIRNAME);
  const confirmed = await confirmDangerousOperation(ctx, outputRoot);
  if (!confirmed) {
    ctx.process.exit(0);
  }

  const targets = getPersistedTargetNames(repository);
  if (targets.length === 0) {
    ctx.logger.error(pc.red("No v3 targets are available to materialize."));
    ctx.process.exit(1);
  }

  ctx.logger.log(pc.yellow(`⚠️  Writing persisted plaintext artifacts to ${outputRoot}...`));

  try {
    for (const targetName of targets) {
      const files = withMaterializedTarget(
        ctx,
        {
          store: options.store,
          repository,
          targetName,
          command: { name: "decrypt", args: ["--force", targetName] },
          mode: "persisted",
          machineLocal: "include",
          outputRoot,
        },
        (materialization) => {
          const writtenFiles = materialization.stagedArtifacts.map((artifact) => artifact.path);
          const targetOutput = materialization.targetArtifact;
          const stagedTarget = materialization.stagedArtifacts.find(
            (artifact) => artifact.logicalPath === targetOutput?.logicalPath,
          );

          if (targetOutput && stagedTarget && typeof targetOutput.content === "string") {
            const rewritten = formatVars(materialization.envVars, targetOutput.format as never);
            ctx.fs.writeFileSync(stagedTarget.path, rewritten, "utf-8");
          }

          return writtenFiles;
        },
      );

      ctx.logger.log(pc.yellow(`  ${targetName}`));
      for (const filePath of files) {
        ctx.logger.log(pc.dim(`    ${filePath}`));
      }
    }

    ctx.logger.log("");
    ctx.logger.log(
      pc.yellow("⚠️  Decryption complete - persisted plaintext artifacts now exist on disk"),
    );
    ctx.logger.log(pc.dim(`   Delete ${outputRoot} when done, or use "hush run" next time.`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error(pc.red(message));
    ctx.process.exit(1);
  }
}
