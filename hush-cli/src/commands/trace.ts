import pc from 'picocolors';
import { writeJsonSuccess } from '../lib/command-output.js';
import { appendAuditEvent } from '../v3/audit.js';
import { requireActiveIdentity } from '../v3/identity.js';
import { loadV3Repository } from '../v3/repository.js';
import { resolveV3Target } from '../v3/resolver.js';
import { isIdentityAllowed, type HushFileIndexEntry } from '../v3/domain.js';
import { MACHINE_LOCAL_FILE_PATH } from '../v3/schema.js';
import { formatCompactRecord, loadMachineLocalOverrides, toCompactRecord } from './v3-command-helpers.js';
import type { HushCompactRecord, HushContext, HushResolvedNode, HushV3Repository, TraceOptions } from '../types.js';

function canReadFile(file: HushFileIndexEntry, identity: string, roles: readonly string[]): boolean {
  return roles.some((role) => isIdentityAllowed(file.readers, identity, role as never));
}

function formatReaders(file: Pick<HushFileIndexEntry, 'readers'>): string {
  return `roles=${file.readers.roles.join(',') || '-'} identities=${file.readers.identities.join(',') || '-'}`;
}

function matchLogicalPath(selector: string, logicalPath: string): boolean {
  return logicalPath === selector || logicalPath.split('/').filter(Boolean).at(-1) === selector;
}

function formatNodeSummary(logicalPath: string, node: HushResolvedNode): string[] {
  const lines = [`    ${logicalPath}`];

  for (const record of node.provenance) {
    const importLabel = record.import
      ? ` imported-from=${record.import.project}${record.import.bundle ? `:${record.import.bundle}` : ''}${record.import.file ? `:${record.import.file}` : ''}`
      : '';
    lines.push(`      ${pc.dim(`file=${record.filePath}${importLabel}`)}`);
  }

  if (node.interpolation?.dependencies.length) {
    for (const dependency of node.interpolation.dependencies) {
      lines.push(`      ${pc.dim(`interpolation=${dependency.path}${dependency.filePath ? ` <- ${dependency.filePath}` : ''}`)}`);
    }
  }

  return lines;
}

function extractUnreadableFilePaths(message: string): string[] {
  const match = message.match(/: (.+)$/);
  return match?.[1]?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
}

function getBundlesReferencingFiles(repository: HushV3Repository, filePaths: readonly string[]): string[] {
  const wanted = new Set(filePaths);
  return Object.entries(repository.manifest.bundles ?? {})
    .filter(([, bundle]) => (bundle.files ?? []).some((file) => wanted.has(file.path)))
    .map(([bundleName]) => bundleName)
    .sort();
}

function formatNotSelectedDiagnosis(targetBundle: string | undefined, filePaths: readonly string[], candidateBundles: readonly string[]): string {
  const fileLabel = filePaths.join(', ');
  const bundleLabel = candidateBundles.length > 0 ? candidateBundles.join(', ') : '(no bundle directly references matched file)';
  return `secret exists in ${fileLabel}, but target bundle ${targetBundle ?? '(none)'} does not resolve those file(s). Candidate source bundle(s): ${bundleLabel}. Add an explicit bundle import or copy/move the key into the target bundle file.`;
}

function toSafeNodeSummary(logicalPath: string, node: HushResolvedNode): object {
  return {
    logicalPath,
    provenance: node.provenance.map((record) => ({
      filePath: record.filePath,
      namespace: record.namespace,
      import: record.import,
    })),
    resolvedFrom: node.resolvedFrom,
    interpolation: node.interpolation,
  };
}

function toCompactTraceRecord(target: string, logicalPath: string, node: HushResolvedNode): HushCompactRecord {
  return toCompactRecord(logicalPath, target, node);
}

export async function traceCommand(ctx: HushContext, options: TraceOptions): Promise<void> {
  const compactMode = options.compact ?? false;
  const compactJsonMode = options.jsonCompact ?? false;
  const repository = loadV3Repository(options.store.root, { keyIdentity: options.store.keyIdentity });
  const identity = requireActiveIdentity(ctx, options.store, repository.manifest.identities, {
    name: 'trace',
    args: [options.key],
  });
  const roles = repository.manifest.identities[identity]?.roles ?? [];
  const matchedFiles = repository.files
    .map((file) => ({
      file,
      matches: file.logicalPaths.filter((logicalPath) => matchLogicalPath(options.key, logicalPath)).sort(),
      readable: canReadFile(file, identity, roles),
    }))
    .filter((entry) => entry.matches.length > 0)
    .sort((left, right) => left.file.path.localeCompare(right.file.path));
  // Machine-local overrides are not repository files, so they are absent from
  // `repository.files`. Matching only against that set is what made trace report
  // repository provenance for a key an override had already displaced, and
  // report "not found" for a machine-local-only key that `hush run` injects.
  const machineLocalMatches = Object.keys(loadMachineLocalOverrides(ctx, options.store)?.entries ?? {})
    .filter((logicalPath) => matchLogicalPath(options.key, logicalPath))
    .sort();
  const allMatchedLogicalPaths = Array.from(new Set([
    ...matchedFiles.flatMap((entry) => entry.matches),
    ...machineLocalMatches,
  ])).sort();
  const matchedFilePaths = matchedFiles.map((entry) => entry.file.path);
  const candidateBundles = getBundlesReferencingFiles(repository, matchedFilePaths);
  const lines: string[] = [];
  const compactLines: string[] = [];
  const targetResults: object[] = [];
  const compactResults: HushCompactRecord[] = [];

  appendAuditEvent(ctx, options.store, {
    type: 'read_attempt',
    activeIdentity: identity,
    success: true,
    command: { name: 'trace', args: [options.key] },
    files: [
      ...matchedFiles.map((entry) => entry.file.path),
      ...(machineLocalMatches.length > 0 ? [MACHINE_LOCAL_FILE_PATH] : []),
    ],
    logicalPaths: allMatchedLogicalPaths,
  });

  lines.push(pc.blue('Hush trace\n'));
  lines.push(`Selector: ${pc.cyan(options.key)}`);
  lines.push(`Active identity: ${pc.green(identity)}`);
  lines.push(`Matched logical paths: ${pc.cyan(String(allMatchedLogicalPaths.length))}`);

  if (allMatchedLogicalPaths.length === 0) {
    if (options.json || compactJsonMode) {
      writeJsonSuccess(ctx, 'trace', compactJsonMode
        ? []
        : {
          selector: options.key,
          activeIdentity: identity,
          matchedLogicalPaths: [],
          matchedFiles: [],
          machineLocalPaths: [],
          candidateBundles: [],
          targets: [],
        });
      return;
    }

    lines.push('');
    lines.push(pc.yellow('No matching logical path found in the repository.'));
    ctx.logger.log(lines.join('\n'));
    return;
  }

  lines.push('');
  lines.push('Repository files:');
  if (matchedFiles.length === 0) {
    lines.push(`  ${pc.dim('(none)')}`);
  }
  for (const entry of matchedFiles) {
    const status = entry.readable ? pc.green('readable') : pc.red('unreadable');
    lines.push(`  ${pc.cyan(entry.file.path)} ${pc.dim(`(${status}; ${formatReaders(entry.file)})`)}`);
    for (const logicalPath of entry.matches) {
      lines.push(`    ${logicalPath}`);
    }
  }

  if (machineLocalMatches.length > 0) {
    lines.push('');
    lines.push('Machine-local overrides:');
    lines.push(`  ${pc.cyan(MACHINE_LOCAL_FILE_PATH)} ${pc.dim('(this machine only)')}`);
    for (const logicalPath of machineLocalMatches) {
      lines.push(`    ${logicalPath}`);
    }
  }

  lines.push('');
  lines.push('Targets:');
  const targetNames = Object.keys(repository.manifest.targets ?? {}).sort();

  for (const targetName of targetNames) {
    const target = repository.manifest.targets?.[targetName];
    try {
      const resolution = resolveV3Target(ctx, {
        store: options.store,
        repository,
        targetName,
        command: { name: 'trace', args: [options.key] },
        machineLocal: 'include',
      });
      const matchedNodes = [
        ...Object.entries(resolution.values),
        ...Object.entries(resolution.artifacts),
      ].filter(([logicalPath]) => allMatchedLogicalPaths.includes(logicalPath));

      if (matchedNodes.length === 0) {
        lines.push(`  ${pc.cyan(targetName)} ${pc.dim('(not selected by target bundle)')}`);
        const diagnosis = formatNotSelectedDiagnosis(target?.bundle, matchedFilePaths, candidateBundles);
        lines.push(`    ${pc.yellow(`diagnosis: ${diagnosis}`)}`);
        targetResults.push({
          target: targetName,
          bundle: target?.bundle,
          status: 'not_selected_by_target_bundle',
          diagnosis,
        });
        continue;
      }

      lines.push(`  ${pc.cyan(targetName)} ${pc.green('(resolved)')}`);
      for (const [logicalPath, node] of matchedNodes.sort(([left], [right]) => left.localeCompare(right))) {
        lines.push(...formatNodeSummary(logicalPath, node));
        compactResults.push(toCompactTraceRecord(targetName, logicalPath, node));
      }
      targetResults.push({
        target: targetName,
        bundle: resolution.bundle,
        status: 'resolved',
        matches: matchedNodes
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([logicalPath, node]) => toSafeNodeSummary(logicalPath, node)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('requires unreadable file')) {
        lines.push(`  ${pc.cyan(targetName)} ${pc.red(`(${message})`)}`);
        targetResults.push({ target: targetName, bundle: target?.bundle, status: 'error', message });
        continue;
      }

      lines.push(`  ${pc.cyan(targetName)} ${pc.red('(acl denied)')}`);
      const unreadableFiles = extractUnreadableFilePaths(message);
      for (const filePath of extractUnreadableFilePaths(message)) {
        const file = repository.filesByPath[filePath];
        lines.push(`    ${pc.yellow(filePath)}${file ? ` ${pc.dim(`(${formatReaders(file)})`)}` : ''}`);
      }
      targetResults.push({ target: targetName, bundle: target?.bundle, status: 'acl_denied', unreadableFiles });
    }
  }

  if (compactMode) {
    compactLines.push(pc.blue('Hush trace compact\n'));
    if (compactResults.length === 0) {
      compactLines.push(pc.yellow('No target resolves this selector.'));
    } else {
      for (const record of compactResults.sort((left, right) => left.key.localeCompare(right.key) || left.target.localeCompare(right.target) || left.source.localeCompare(right.source))) {
        compactLines.push(formatCompactRecord(record));
      }
    }
  }

  if (compactJsonMode) {
    writeJsonSuccess(ctx, 'trace', compactResults.sort((left, right) => left.key.localeCompare(right.key) || left.target.localeCompare(right.target) || left.source.localeCompare(right.source)));
    return;
  }

  if (options.json) {
    writeJsonSuccess(ctx, 'trace', {
      selector: options.key,
      activeIdentity: identity,
      matchedLogicalPaths: allMatchedLogicalPaths,
      matchedFiles: matchedFiles.map((entry) => ({
        path: entry.file.path,
        readable: entry.readable,
        readers: entry.file.readers,
        matches: entry.matches,
      })),
      machineLocalPaths: machineLocalMatches,
      candidateBundles,
      targets: targetResults,
    });
    return;
  }

  ctx.logger.log((compactMode ? compactLines : lines).join('\n'));
}
