import { stringify as stringifyYaml } from "yaml";

import {
  appendAuditEvent,
  assertHushRole,
  assertNamespacedPath,
  createReaders,
  getActiveIdentity,
  loadV3Repository,
  setActiveIdentity,
} from "../index.js";
import { writeJsonSuccess } from "../lib/command-output.js";
import type { ConfigOptions, HushContext, HushV3Repository } from "../types.js";
import { isIdentityAllowed } from "../v3/domain.js";
import { persistV3FileDocument } from "../v3/repository.js";
import { requireMutableIdentity } from "./v3-command-helpers.js";

type ConfigShowSection =
  | "all"
  | "manifest"
  | "identities"
  | "bundles"
  | "targets"
  | "imports"
  | "files"
  | "state";

function printConfigUsage(ctx: HushContext): void {
  ctx.logger.log(`Usage:
  hush config show [section]
  hush config active-identity [name]
  hush config readers <file-path> [--roles <csv>] [--identities <csv>]`);
}

function failWithUsage(ctx: HushContext, message: string): never {
  ctx.logger.error(message);
  printConfigUsage(ctx);
  ctx.process.exit(1);
}

function loadRepository(storeRoot: string, keyIdentity: string | undefined): HushV3Repository {
  return loadV3Repository(storeRoot, { keyIdentity });
}

function getCommandArgs(
  subcommand: string | undefined,
  args: string[],
  options: ConfigOptions,
): string[] {
  const commandArgs = subcommand ? [subcommand, ...args] : [...args];

  if (options.roles !== undefined) {
    commandArgs.push("--roles", options.roles);
  }

  if (options.identities !== undefined) {
    commandArgs.push("--identities", options.identities);
  }

  return commandArgs;
}

function parseRoleCsv(
  value: string | undefined,
  fallback: Array<"owner" | "member" | "ci">,
): Array<"owner" | "member" | "ci"> {
  if (value === undefined) {
    return fallback;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => assertHushRole(entry));
}

function parseIdentityCsv(
  value: string | undefined,
  fallback: string[],
  repository: HushV3Repository,
): string[] {
  if (value === undefined) {
    return fallback;
  }

  const identities = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const identity of identities) {
    if (!repository.manifest.identities[identity]) {
      throw new Error(`Identity "${identity}" is not declared in this repository`);
    }
  }

  return identities;
}

function canReadIndexedFile(
  repository: HushV3Repository,
  activeIdentity: string | null,
  filePath: string,
): boolean {
  if (!activeIdentity) {
    return false;
  }

  const file = repository.filesByPath[filePath];
  const roles = repository.manifest.identities[activeIdentity]?.roles ?? [];
  return roles.some((role) => isIdentityAllowed(file.readers, activeIdentity, role as never));
}

function getReadableFileSummaries(
  repository: HushV3Repository,
  activeIdentity: string | null,
): Array<{
  path: string;
  readers: HushV3Repository["filesByPath"][string]["readers"];
  sensitive: boolean;
  entryCount: number;
}> {
  return Object.entries(repository.filesByPath)
    .filter(([filePath]) => canReadIndexedFile(repository, activeIdentity, filePath))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, file]) => ({
      path: filePath,
      readers: file.readers,
      sensitive: file.sensitive,
      entryCount: file.logicalPaths.length,
    }));
}

function sanitizeManifest(repository: HushV3Repository) {
  const { fileIndex: _fileIndex, ...manifest } = repository.manifest;
  return manifest;
}

function showSection(
  repository: HushV3Repository,
  options: ConfigOptions,
  activeIdentity: string | null,
): unknown {
  const requestedSection = (options.args[0] ?? "all") as ConfigShowSection;
  const readableFiles = getReadableFileSummaries(repository, activeIdentity);

  switch (requestedSection) {
    case "all":
      return {
        manifest: sanitizeManifest(repository),
        files: readableFiles,
        state: {
          activeIdentity,
          activeIdentityPath: options.store.activeIdentityPath,
        },
      };
    case "manifest":
      return sanitizeManifest(repository);
    case "identities":
      return repository.manifest.identities;
    case "bundles":
      return repository.manifest.bundles ?? {};
    case "targets":
      return repository.manifest.targets ?? {};
    case "imports":
      return repository.manifest.imports ?? {};
    case "files":
      return readableFiles;
    case "state":
      return {
        activeIdentity,
        activeIdentityPath: options.store.activeIdentityPath,
      };
    default:
      throw new Error(`Unknown config section "${requestedSection}"`);
  }
}

function handleShow(ctx: HushContext, options: ConfigOptions): void {
  const repository = loadRepository(options.store.root, options.store.keyIdentity);
  const activeIdentity = getActiveIdentity(ctx, options.store);
  const payload = showSection(repository, options, activeIdentity);

  appendAuditEvent(ctx, options.store, {
    type: "read_attempt",
    activeIdentity: activeIdentity ?? undefined,
    success: true,
    command: { name: "config", args: getCommandArgs("show", options.args, options) },
    files: getReadableFileSummaries(repository, activeIdentity).map((file) => file.path),
  });

  if (options.json) {
    writeJsonSuccess(ctx, "config", payload);
    return;
  }

  ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
}

function handleActiveIdentity(ctx: HushContext, options: ConfigOptions): void {
  const repository = loadRepository(options.store.root, options.store.keyIdentity);
  const nextIdentity = options.args[0];

  if (!nextIdentity) {
    const activeIdentity = getActiveIdentity(ctx, options.store);
    ctx.logger.log(activeIdentity ?? "(not set)");
    return;
  }

  const result = setActiveIdentity(ctx, {
    store: options.store,
    identity: nextIdentity,
    identities: repository.manifest.identities,
    command: { name: "config", args: getCommandArgs("active-identity", options.args, options) },
  });

  ctx.logger.log(`Active identity set to ${result.identity}`);
}

function handleReaders(ctx: HushContext, options: ConfigOptions): void {
  const repository = loadRepository(options.store.root, options.store.keyIdentity);
  const requestedFilePath = options.args[0];
  const command = { name: "config", args: getCommandArgs("readers", options.args, options) };

  if (!requestedFilePath) {
    failWithUsage(ctx, 'Missing file path for "hush config readers".');
  }

  if (options.roles === undefined && options.identities === undefined) {
    failWithUsage(ctx, "Provide --roles, --identities, or both when updating readers.");
  }

  const activeIdentity = requireMutableIdentity(ctx, options.store, repository, command);

  const filePath = assertNamespacedPath(requestedFilePath);
  const file = repository.loadFile(filePath);
  if (!file) {
    throw new Error(`File "${filePath}" is not declared in this repository`);
  }

  const nextReaders = createReaders({
    roles: parseRoleCsv(options.roles, file.readers.roles),
    identities: parseIdentityCsv(options.identities, file.readers.identities, repository),
  });

  const nextFile = {
    ...file,
    readers: nextReaders,
  };

  persistV3FileDocument(
    ctx,
    options.store,
    repository,
    repository.fileSystemPaths[filePath]!,
    nextFile,
  );

  appendAuditEvent(ctx, options.store, {
    type: "metadata_change",
    activeIdentity,
    success: true,
    command,
    files: [filePath],
    details: {
      roles: nextReaders.roles,
      identities: nextReaders.identities,
    },
  });

  ctx.logger.log(stringifyYaml({ path: filePath, readers: nextReaders }, { indent: 2 }).trimEnd());
}

export async function configCommand(ctx: HushContext, options: ConfigOptions): Promise<void> {
  const subcommand = options.subcommand ?? "show";

  switch (subcommand) {
    case "show":
      handleShow(ctx, options);
      return;
    case "active-identity":
      handleActiveIdentity(ctx, options);
      return;
    case "readers":
      handleReaders(ctx, options);
      return;
    default:
      failWithUsage(ctx, `Unknown config subcommand: ${subcommand}`);
  }
}
