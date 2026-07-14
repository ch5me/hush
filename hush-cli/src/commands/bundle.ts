import { stringify as stringifyYaml } from 'yaml';
import type {
  BundleAddOptions,
  BundleAddFileOptions,
  BundleRemoveFileOptions,
  BundleRemoveOptions,
  BundleListOptions,
  HushContext,
} from '../types.js';
import { appendAuditEvent, assertNamespacedPath, createBundleDefinition, createManifestDocument } from '../index.js';
import { persistV3ManifestDocument } from '../v3/repository.js';
import { requireMutableIdentity, requireV3Repository } from './v3-command-helpers.js';
import { withSuggestion } from './mutation-feedback.js';
import { writeJsonSuccess } from '../lib/command-output.js';

type BundleCommandOptions =
  | BundleAddOptions
  | BundleAddFileOptions
  | BundleRemoveFileOptions
  | BundleRemoveOptions
  | BundleListOptions;

function getCommandArgs(subcommand: string | undefined, args: string[], options: BundleCommandOptions): string[] {
  const commandArgs = subcommand ? [subcommand, ...args] : [...args];
  return commandArgs;
}

async function handleBundleAdd(ctx: HushContext, options: BundleAddOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'bundle');
  const command = { name: 'bundle', args: getCommandArgs('add', [options.name], options) };
  const activeIdentity = requireMutableIdentity(ctx, options.store, repository, command);

  const bundleName = options.name.trim();
  if (!bundleName) {
    throw new Error('Bundle name cannot be empty');
  }

  const bundles = repository.manifest.bundles ?? {};
  if (bundles[bundleName]) {
    const existingFiles = (bundles[bundleName]!.files ?? []).map((entry) => entry.path).sort();
    const requestedFiles = (options.files ?? '').split(',').map((entry) => entry.trim()).filter(Boolean).sort();
    if (JSON.stringify(existingFiles) === JSON.stringify(requestedFiles)) {
      const payload = { action: 'add-bundle', changed: false, bundle: bundleName, files: bundles[bundleName]!.files ?? [] };
      if (options.json) writeJsonSuccess(ctx, 'bundle', payload);
      else ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
      return;
    }
    throw new Error(`Bundle "${bundleName}" already exists with different files. Nothing was changed. Remove it explicitly before replacing it.`);
  }

  const fileRefs: Array<{ path: string }> = [];
  if (options.files) {
    const filePaths = options.files.split(',').map((p) => p.trim()).filter(Boolean);
    const seenPaths = new Set<string>();
    for (const filePath of filePaths) {
      const trimmedPath = filePath.trim();
      if (seenPaths.has(trimmedPath)) {
        throw new Error(`Duplicate file reference: "${trimmedPath}" appears more than once`);
      }
      seenPaths.add(trimmedPath);
      if (!repository.filesByPath[trimmedPath]) {
        throw new Error(withSuggestion(
          `File "${trimmedPath}" does not exist in file index. Nothing was changed.`,
          trimmedPath,
          Object.keys(repository.filesByPath),
        ));
      }
      const normalizedPath = assertNamespacedPath(trimmedPath);
      fileRefs.push({ path: normalizedPath });
    }
  }

  const nextManifest = createManifestDocument({
    ...repository.manifest,
    bundles: {
      ...bundles,
      [bundleName]: createBundleDefinition({ files: fileRefs }),
    },
  });

  persistV3ManifestDocument(ctx, options.store, repository, nextManifest);

  appendAuditEvent(ctx, options.store, {
    type: 'metadata_change',
    activeIdentity,
    success: true,
    command,
    details: {
      bundleName,
      fileCount: fileRefs.length,
    },
  });

  const payload = { action: 'add-bundle', changed: true, bundle: bundleName, name: bundleName, files: fileRefs };
  if (options.json) {
    writeJsonSuccess(ctx, 'bundle', payload);
    return;
  }

  ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
}

async function handleBundleAddFile(ctx: HushContext, options: BundleAddFileOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'bundle');
  const command = { name: 'bundle', args: getCommandArgs('add-file', [options.bundle, options.file], options) };
  const activeIdentity = requireMutableIdentity(ctx, options.store, repository, command);

  const bundleName = options.bundle.trim();
  if (!bundleName) {
    throw new Error('Bundle name cannot be empty');
  }

  const bundles = repository.manifest.bundles ?? {};
  const existingBundle = bundles[bundleName];
  if (!existingBundle) {
    throw new Error(withSuggestion(`Bundle "${bundleName}" does not exist. Nothing was changed.`, bundleName, Object.keys(bundles)));
  }

  const normalizedFilePath = assertNamespacedPath(options.file);
  if (!repository.filesByPath[normalizedFilePath]) {
    throw new Error(withSuggestion(
      `File "${normalizedFilePath}" does not exist in file index. Nothing was changed.`,
      normalizedFilePath,
      Object.keys(repository.filesByPath),
    ));
  }

  const existingFiles = existingBundle.files ?? [];
  if (existingFiles.some((ref) => ref.path === normalizedFilePath)) {
    const payload = { action: 'add-file-to-bundle', changed: false, bundle: bundleName, file: normalizedFilePath };
    if (options.json) writeJsonSuccess(ctx, 'bundle', payload);
    else ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
    return;
  }

  const nextManifest = createManifestDocument({
    ...repository.manifest,
    bundles: {
      ...bundles,
      [bundleName]: createBundleDefinition({
        ...existingBundle,
        files: [...existingFiles, { path: normalizedFilePath }],
      }),
    },
  });

  persistV3ManifestDocument(ctx, options.store, repository, nextManifest);

  appendAuditEvent(ctx, options.store, {
    type: 'metadata_change',
    activeIdentity,
    success: true,
    command,
    files: [normalizedFilePath],
    details: {
      bundleName,
      action: 'add-file',
    },
  });

  const payload = { bundle: bundleName, file: normalizedFilePath, added: true };
  if (options.json) {
    writeJsonSuccess(ctx, 'bundle', payload);
    return;
  }

  ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
}

async function handleBundleRemoveFile(ctx: HushContext, options: BundleRemoveFileOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'bundle');
  const command = { name: 'bundle', args: getCommandArgs('remove-file', [options.bundle, options.file], options) };
  const activeIdentity = requireMutableIdentity(ctx, options.store, repository, command);

  const bundleName = options.bundle.trim();
  if (!bundleName) {
    throw new Error('Bundle name cannot be empty');
  }

  const bundles = repository.manifest.bundles ?? {};
  const existingBundle = bundles[bundleName];
  if (!existingBundle) {
    throw new Error(withSuggestion(`Bundle "${bundleName}" does not exist. Nothing was changed.`, bundleName, Object.keys(bundles)));
  }

  const normalizedFilePath = assertNamespacedPath(options.file);
  const existingFiles = existingBundle.files ?? [];
  const fileIndex = existingFiles.findIndex((ref) => ref.path === normalizedFilePath);
  if (fileIndex === -1) {
    throw new Error(`File "${normalizedFilePath}" is not in bundle "${bundleName}"`);
  }

  const nextManifest = createManifestDocument({
    ...repository.manifest,
    bundles: {
      ...bundles,
      [bundleName]: createBundleDefinition({
        ...existingBundle,
        files: existingFiles.filter((_, i) => i !== fileIndex),
      }),
    },
  });

  persistV3ManifestDocument(ctx, options.store, repository, nextManifest);

  appendAuditEvent(ctx, options.store, {
    type: 'metadata_change',
    activeIdentity,
    success: true,
    command,
    files: [normalizedFilePath],
    details: {
      bundleName,
      action: 'remove-file',
    },
  });

  const payload = { bundle: bundleName, file: normalizedFilePath, removed: true };
  if (options.json) {
    writeJsonSuccess(ctx, 'bundle', payload);
    return;
  }

  ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
}

async function handleBundleRemove(ctx: HushContext, options: BundleRemoveOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'bundle');
  const command = { name: 'bundle', args: getCommandArgs('remove', [options.name], options) };
  const activeIdentity = requireMutableIdentity(ctx, options.store, repository, command);

  const bundleName = options.name.trim();
  if (!bundleName) {
    throw new Error('Bundle name cannot be empty');
  }

  const bundles = repository.manifest.bundles ?? {};
  if (!bundles[bundleName]) {
    throw new Error(withSuggestion(`Bundle "${bundleName}" does not exist. Nothing was changed.`, bundleName, Object.keys(bundles)));
  }

  // Block removal if any target still references this bundle
  const targets = repository.manifest.targets ?? {};
  for (const [targetName, targetDef] of Object.entries(targets)) {
    if (targetDef.bundle === bundleName) {
      throw new Error(
        `Bundle "${bundleName}" cannot be removed because target "${targetName}" references it. Remove the target first.`,
      );
    }
  }

  const { [bundleName]: _removed, ...remainingBundles } = bundles;
  const nextManifest = createManifestDocument({
    ...repository.manifest,
    bundles: Object.keys(remainingBundles).length > 0 ? remainingBundles : undefined,
  });

  persistV3ManifestDocument(ctx, options.store, repository, nextManifest);

  appendAuditEvent(ctx, options.store, {
    type: 'metadata_change',
    activeIdentity,
    success: true,
    command,
    details: {
      bundleName,
      action: 'remove',
    },
  });

  const payload = { name: bundleName, removed: true };
  if (options.json) {
    writeJsonSuccess(ctx, 'bundle', payload);
    return;
  }

  ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
}

async function handleBundleList(ctx: HushContext, options: BundleListOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'bundle');
  const command = { name: 'bundle', args: ['list'] };
  requireMutableIdentity(ctx, options.store, repository, command);

  const bundles = repository.manifest.bundles ?? {};
  const bundleEntries = Object.entries(bundles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, bundle]) => ({
      name,
      files: bundle.files ?? [],
      imports: bundle.imports ?? [],
      paths: bundle.paths ?? [],
    }));

  appendAuditEvent(ctx, options.store, {
    type: 'read_attempt',
    activeIdentity: repository.manifest.activeIdentity ?? undefined,
    success: true,
    command,
  });

  if (options.json) {
    writeJsonSuccess(ctx, 'bundle', { bundles: bundleEntries });
    return;
  }

  ctx.logger.log(stringifyYaml({ bundles: bundleEntries }, { indent: 2 }).trimEnd());
}

export async function bundleCommand(
  ctx: HushContext,
  options: BundleCommandOptions,
): Promise<void> {
  const subcommand = (options as { subcommand?: string }).subcommand;

  switch (subcommand) {
    case 'add':
      await handleBundleAdd(ctx, options as BundleAddOptions);
      return;
    case 'add-file':
      await handleBundleAddFile(ctx, options as BundleAddFileOptions);
      return;
    case 'remove-file':
      await handleBundleRemoveFile(ctx, options as BundleRemoveFileOptions);
      return;
    case 'remove':
      await handleBundleRemove(ctx, options as BundleRemoveOptions);
      return;
    case 'list':
      await handleBundleList(ctx, options as BundleListOptions);
      return;
    default:
      ctx.logger.error(`Unknown bundle subcommand: ${subcommand ?? 'none'}`);
      ctx.logger.error(
        'Usage:\n'
        + '  hush bundle add <name> [--files <csv>]\n'
        + '  hush bundle add-file <bundle-name> <file-path>\n'
        + '  hush bundle remove-file <bundle-name> <file-path>\n'
        + '  hush bundle remove <name>\n'
        + '  hush bundle list [--json]',
      );
      ctx.process.exit(1);
  }
}
