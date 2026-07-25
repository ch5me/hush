import { stringify as stringifyYaml } from 'yaml';
import type {
  FileAddOptions,
  FileListOptions,
  FileReadersOptions,
  FileRemoveOptions,
  HushContext,
  HushV3Repository,
} from '../types.js';
import {
  appendAuditEvent,
  assertHushRole,
  createFileDocument,
  createManifestDocument,
  createReaders,
  getV3EncryptedFilePath,
  loadV3Repository,
} from '../index.js';
import { MACHINE_LOCAL_FILE_PATH, assertRepositoryFilePath } from '../v3/schema.js';
import { persistV3FileDocument, removeV3FileDocument } from '../v3/repository.js';
import { requireMutableIdentity, requireV3Repository } from './v3-command-helpers.js';
import { withSuggestion } from './mutation-feedback.js';
import { writeJsonSuccess } from '../lib/command-output.js';

const RESERVED_NAMESPACE_REMEDY =
  `Machine-local overrides live at "${MACHINE_LOCAL_FILE_PATH}" and are written with "hush set --repo-local"; `
  + 'they are never declared as repository files.';

/** Every `hush file` subcommand operates on committed repository files only. */
function assertRepositoryFileArg(path: string): string {
  return assertRepositoryFilePath(path, RESERVED_NAMESPACE_REMEDY);
}

function parseRoleCsv(
  value: string | undefined,
  fallback: Array<'owner' | 'member' | 'ci'>,
): Array<'owner' | 'member' | 'ci'> {
  if (value === undefined) {
    return fallback;
  }

  return value
    .split(',')
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
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const identity of identities) {
    if (!repository.manifest.identities[identity]) {
      throw new Error(`Identity "${identity}" is not declared in this repository`);
    }
  }

  return identities;
}

function getCommandArgs(
  subcommand: string | undefined,
  args: string[],
  options: { roles?: string; identities?: string },
): string[] {
  const commandArgs = subcommand ? [subcommand, ...args] : [...args];

  if (options.roles !== undefined) {
    commandArgs.push('--roles', options.roles);
  }

  if (options.identities !== undefined) {
    commandArgs.push('--identities', options.identities);
  }

  return commandArgs;
}

async function handleFileAdd(ctx: HushContext, options: FileAddOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'file');
  const command = { name: 'file', args: getCommandArgs('add', [options.path], options) };
  const activeIdentity = requireMutableIdentity(ctx, options.store, repository, command);

  const filePath = assertRepositoryFileArg(options.path);

  if (repository.filesByPath[filePath]) {
    throw new Error(`File "${filePath}" already exists in this repository`);
  }

  const defaultReaders = {
    roles: ['owner', 'member', 'ci'] as Array<'owner' | 'member' | 'ci'>,
    identities: [] as string[],
  };

  const nextReaders = createReaders({
    roles: parseRoleCsv(options.roles, defaultReaders.roles),
    identities: parseIdentityCsv(options.identities, defaultReaders.identities, repository),
  });

  const nextDocument = createFileDocument({
    path: filePath,
    readers: nextReaders,
    sensitive: true,
    entries: {},
  });

  const systemPath = getV3EncryptedFilePath(options.store.root, filePath);
  ctx.fs.mkdirSync(
    ctx.path.join(options.store.root, '.hush', 'files', ...filePath.split('/').slice(0, -1)),
    { recursive: true },
  );

  persistV3FileDocument(ctx, options.store, repository, systemPath, nextDocument);

  appendAuditEvent(ctx, options.store, {
    type: 'metadata_change',
    activeIdentity,
    success: true,
    command,
    files: [filePath],
    details: {
      roles: nextReaders.roles,
      identities: nextReaders.identities,
    },
  });

  const payload = { path: filePath, readers: nextReaders };
  if (options.json) {
    writeJsonSuccess(ctx, 'file', payload);
    return;
  }

  ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
}

async function handleFileRemove(ctx: HushContext, options: FileRemoveOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'file');
  const command = { name: 'file', args: getCommandArgs('remove', [options.path], {}) };
  const activeIdentity = requireMutableIdentity(ctx, options.store, repository, command);

  const filePath = assertRepositoryFileArg(options.path);
  const fileIndexEntry = repository.filesByPath[filePath];

  if (!fileIndexEntry) {
    throw new Error(withSuggestion(
      `File "${filePath}" is not declared in this repository. Nothing was removed.`,
      filePath,
      Object.keys(repository.filesByPath),
    ));
  }

  if (fileIndexEntry.logicalPaths.length > 0) {
    throw new Error(
      `File "${filePath}" cannot be removed because it still contains ${fileIndexEntry.logicalPaths.length} entry(ies). Remove the entries first or use --keep-file to remove only the index entry.`,
    );
  }

  // Validate no bundles reference this file before removing
  const bundles = repository.manifest.bundles ?? {};
  for (const [bundleName, bundle] of Object.entries(bundles)) {
    const fileRefs = bundle.files ?? [];
    if (fileRefs.some((ref) => ref.path === filePath)) {
      throw new Error(
        `File "${filePath}" cannot be removed because bundle "${bundleName}" references it. Remove the file reference from the bundle first.`,
      );
    }
  }

  const systemPath = repository.fileSystemPaths[filePath];
  const { [filePath]: _removed, ...remainingFileIndex } = repository.manifest.fileIndex ?? {};
  const nextManifest = createManifestDocument({
    ...repository.manifest,
    fileIndex: Object.keys(remainingFileIndex).length > 0 ? remainingFileIndex : undefined,
  });

  removeV3FileDocument(ctx, options.store, repository, filePath, systemPath, options.keepFile ?? false, nextManifest);

  appendAuditEvent(ctx, options.store, {
    type: 'metadata_change',
    activeIdentity,
    success: true,
    command,
    files: [filePath],
    details: {
      keepFile: options.keepFile ?? false,
    },
  });

  const payload = {
    action: 'remove-file',
    changed: true,
    requestedScope: { file: options.path },
    resolvedScope: { file: filePath, keepFile: options.keepFile ?? false },
    path: filePath,
    removed: true,
    keepFile: options.keepFile ?? false,
  };
  if (options.json) {
    writeJsonSuccess(ctx, 'file', payload);
    return;
  }

  ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
}

async function handleFileList(ctx: HushContext, options: FileListOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'file');
  const command = { name: 'file', args: ['list'] };

  requireMutableIdentity(ctx, options.store, repository, command);

  const reloadedRepo = loadV3Repository(options.store.root, { keyIdentity: options.store.keyIdentity });
  const activeIdentity = reloadedRepo.manifest.activeIdentity;

  const files = Object.entries(repository.filesByPath)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, entry]) => ({
      path: filePath,
      readers: entry.readers,
      sensitive: entry.sensitive,
      entryCount: entry.logicalPaths.length,
    }));

  appendAuditEvent(ctx, options.store, {
    type: 'read_attempt',
    activeIdentity: activeIdentity ?? undefined,
    success: true,
    command,
    files: Object.keys(repository.filesByPath),
  });

  if (options.json) {
    writeJsonSuccess(ctx, 'file', { files });
    return;
  }

  ctx.logger.log(stringifyYaml({ files }, { indent: 2 }).trimEnd());
}

async function handleFileReaders(ctx: HushContext, options: FileReadersOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'file');
  const command = { name: 'file', args: getCommandArgs('readers', [options.path], options) };
  const activeIdentity = requireMutableIdentity(ctx, options.store, repository, command);

  const requestedFilePath = options.path;

  if (!requestedFilePath) {
    ctx.logger.error('Missing file path for "hush file readers".');
    ctx.logger.error('Usage: hush file readers <namespaced-path> [--roles <csv>] [--identities <csv>]');
    ctx.process.exit(1);
  }

  if (options.roles === undefined && options.identities === undefined) {
    ctx.logger.error('Provide --roles, --identities, or both when updating readers.');
    ctx.process.exit(1);
  }

  const filePath = assertRepositoryFileArg(requestedFilePath);
  const file = repository.loadFile(filePath);
  if (!file) {
    throw new Error(`File "${filePath}" is not declared in this repository`);
  }

  const nextReaders = createReaders({
    roles: parseRoleCsv(options.roles, file.readers.roles),
    identities: parseIdentityCsv(options.identities, file.readers.identities, repository),
  });

  if (JSON.stringify(nextReaders) === JSON.stringify(file.readers)) {
    const payload = {
      action: 'update-file-readers',
      changed: false,
      requestedScope: { file: requestedFilePath },
      resolvedScope: { file: filePath },
      path: filePath,
      readers: nextReaders,
    };
    if (options.json) writeJsonSuccess(ctx, 'file', payload);
    else ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
    return;
  }

  const nextFile = createFileDocument({
    ...file,
    readers: nextReaders,
  });

  persistV3FileDocument(ctx, options.store, repository, repository.fileSystemPaths[filePath]!, nextFile);

  appendAuditEvent(ctx, options.store, {
    type: 'metadata_change',
    activeIdentity,
    success: true,
    command,
    files: [filePath],
    details: {
      roles: nextReaders.roles,
      identities: nextReaders.identities,
    },
  });

  const payload = {
    action: 'update-file-readers',
    changed: true,
    requestedScope: { file: requestedFilePath },
    resolvedScope: { file: filePath },
    path: filePath,
    readers: nextReaders,
  };
  if (options.json) {
    writeJsonSuccess(ctx, 'file', payload);
    return;
  }

  ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
}

export async function fileCommand(
  ctx: HushContext,
  options: FileAddOptions | FileRemoveOptions | FileListOptions | FileReadersOptions,
): Promise<void> {
  const subcommand = (options as { subcommand?: string }).subcommand;

  switch (subcommand) {
    case 'add':
      await handleFileAdd(ctx, options as FileAddOptions);
      return;
    case 'remove':
      await handleFileRemove(ctx, options as FileRemoveOptions);
      return;
    case 'list':
      await handleFileList(ctx, options as FileListOptions);
      return;
    case 'readers':
      await handleFileReaders(ctx, options as FileReadersOptions);
      return;
    default:
      ctx.logger.error(`Unknown file subcommand: ${subcommand ?? 'none'}`);
      ctx.logger.error(
        'Usage:\n  hush file add <namespaced-path> [--roles <csv>] [--identities <csv>]\n  hush file remove <namespaced-path> [--keep-file]\n  hush file list [--json]\n  hush file readers <namespaced-path> [--roles <csv>] [--identities <csv>]',
      );
      ctx.process.exit(1);
  }
}
