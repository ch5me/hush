import pc from "picocolors";

import { writeJsonError, writeJsonSuccess } from "../lib/command-output.js";
import type { HushContext, StoreContext } from "../types.js";
import { appendAuditEvent } from "../v3/audit.js";
import {
  isIdentityAllowed,
  type HushFileDocument,
  type HushFileEntry,
  type HushFileIndexEntry,
} from "../v3/domain.js";
import { requireActiveIdentity } from "../v3/identity.js";
import { loadV3Repository } from "../v3/repository.js";
import { resolveV3Target } from "../v3/resolver.js";
import { loadImportedRepositories, selectRuntimeTarget } from "./v3-command-helpers.js";

export interface InspectOptions {
  store: StoreContext;
  env: "development" | "production";
  /** Restrict inspection to the files one declared target resolves. */
  target?: string;
  json?: boolean;
}

function canReadFile(
  file: HushFileIndexEntry,
  identity: string,
  roles: readonly string[],
): boolean {
  return roles.some((role) => isIdentityAllowed(file.readers, identity, role as never));
}

function isSensitive(file: HushFileDocument, entry: HushFileEntry): boolean {
  return file.sensitive || entry.sensitive;
}

function formatVisibleValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function formatInspectValue(file: HushFileDocument, entry: HushFileEntry): string {
  if (isSensitive(file, entry)) {
    return pc.yellow("[redacted]");
  }

  if ("type" in entry) {
    return entry.value ? formatVisibleValue(entry.value) : "(empty artifact)";
  }

  return formatVisibleValue(entry.value);
}

function formatReaders(file: Pick<HushFileIndexEntry, "readers">): string {
  return `roles=${file.readers.roles.join(",") || "-"} identities=${file.readers.identities.join(",") || "-"}`;
}

export async function inspectCommand(ctx: HushContext, options: InspectOptions): Promise<void> {
  const commandArgs = options.target ? ["--target", options.target] : [];
  const repository = loadV3Repository(options.store.root, {
    keyIdentity: options.store.keyIdentity,
  });
  const identity = requireActiveIdentity(ctx, options.store, repository.manifest.identities, {
    name: "inspect",
    args: commandArgs,
  });

  // Restrict to one declared target's files, so a multi-target repository can be
  // inspected one target at a time instead of an undifferentiated repo-wide dump.
  let targetName: string | undefined;
  let targetFilePaths: Set<string> | undefined;
  if (options.target) {
    try {
      const selected = selectRuntimeTarget(repository, options.target);
      targetName = selected.targetName;
      const resolution = resolveV3Target(ctx, {
        store: options.store,
        repository,
        importedRepositories: loadImportedRepositories(repository),
        targetName: selected.targetName,
        command: { name: "inspect", args: commandArgs },
        machineLocal: "exclude",
      });
      targetFilePaths = new Set(resolution.files);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) {
        writeJsonError(ctx, "inspect", {
          code: "TARGET_NOT_FOUND",
          message,
          rejectedInput: options.target,
          details: { availableTargets: Object.keys(repository.manifest.targets ?? {}).sort() },
        });
      } else {
        ctx.logger.error(pc.red(message));
      }
      ctx.process.exit(1);
      return;
    }
  }

  const roles = repository.manifest.identities[identity]?.roles ?? [];
  const scopedFileIndexes = Object.values(repository.filesByPath).filter((file) =>
    targetFilePaths ? targetFilePaths.has(file.path) : true,
  );
  const readableFileIndexes = scopedFileIndexes.filter((file) =>
    canReadFile(file, identity, roles),
  );
  const unreadableFiles = scopedFileIndexes.filter((file) => !canReadFile(file, identity, roles));
  const readableFiles = readableFileIndexes.map((file) => repository.loadFile(file.path));
  const logicalPaths: string[] = [];

  if (options.json) {
    // Build JSON payload — never include values for sensitive entries
    const entries: Array<{
      key: string;
      file: string;
      sensitive: boolean;
      set: boolean;
      value?: string;
    }> = [];

    for (const file of readableFiles.sort((left, right) => left.path.localeCompare(right.path))) {
      for (const logicalPath of Object.keys(file.entries).sort()) {
        const entry = file.entries[logicalPath]!;
        logicalPaths.push(logicalPath);
        const sensitive = isSensitive(file, entry);
        const isSet = entry.value !== undefined && entry.value !== null && entry.value !== "";
        const entryRecord: {
          key: string;
          file: string;
          sensitive: boolean;
          set: boolean;
          value?: string;
        } = {
          key: logicalPath,
          file: file.path,
          sensitive,
          set: isSet,
        };
        // Only include value for non-sensitive entries (entries already shown in plaintext)
        if (!sensitive) {
          entryRecord.value = formatVisibleValue(entry.value);
        }
        entries.push(entryRecord);
      }
    }

    appendAuditEvent(ctx, options.store, {
      type: "read_attempt",
      activeIdentity: identity,
      success: true,
      command: { name: "inspect", args: [...commandArgs, "--json"] },
      files: readableFiles.map((file) => file.path),
      logicalPaths: logicalPaths.sort(),
    });

    writeJsonSuccess(ctx, "inspect", {
      target: options.store.root,
      selectedTarget: targetName,
      entries,
    });
    return;
  }

  const lines: string[] = [];

  lines.push(pc.blue("Hush inspect\n"));
  lines.push(`Active identity: ${pc.green(identity)}`);
  if (targetName) {
    lines.push(`Target: ${pc.cyan(targetName)}`);
  }
  lines.push(`Readable files: ${pc.cyan(String(readableFiles.length))}`);
  lines.push(`Unreadable files: ${pc.cyan(String(unreadableFiles.length))}`);

  if (readableFiles.length === 0) {
    lines.push("");
    lines.push(pc.yellow("No readable files for the active identity."));
  } else {
    lines.push("");
    lines.push("Readable entries:");

    for (const file of readableFiles.sort((left, right) => left.path.localeCompare(right.path))) {
      lines.push(`  ${pc.cyan(file.path)} ${pc.dim(`(${formatReaders(file)})`)}`);

      for (const logicalPath of Object.keys(file.entries).sort()) {
        const entry = file.entries[logicalPath]!;
        logicalPaths.push(logicalPath);
        const typeLabel = "type" in entry ? `${entry.type}:${entry.format}` : "value";
        const sensitiveLabel = isSensitive(file, entry) ? "sensitive" : "visible";
        lines.push(`    ${logicalPath}`);
        lines.push(`      ${pc.dim(`kind=${typeLabel} exposure=${sensitiveLabel}`)}`);
        lines.push(`      ${formatInspectValue(file, entry)}`);
      }
    }
  }

  if (unreadableFiles.length > 0) {
    lines.push("");
    lines.push("Unreadable files:");
    for (const file of unreadableFiles.sort((left, right) => left.path.localeCompare(right.path))) {
      lines.push(`  ${pc.yellow(file.path)} ${pc.dim(`(${formatReaders(file)})`)}`);
    }
  }

  appendAuditEvent(ctx, options.store, {
    type: "read_attempt",
    activeIdentity: identity,
    success: true,
    command: { name: "inspect", args: commandArgs },
    files: readableFiles.map((file) => file.path),
    logicalPaths: logicalPaths.sort(),
  });

  ctx.logger.log(lines.join("\n"));
}
