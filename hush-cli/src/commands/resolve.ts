import pc from 'picocolors';
import { appendAuditEvent } from '../v3/audit.js';
import { resolveV3Target, HushResolutionConflictError } from '../v3/resolver.js';
import { requireActiveIdentity } from '../v3/identity.js';
import { loadV3Repository } from '../v3/repository.js';
import { formatCompactRecord, toCompactRecord } from './v3-command-helpers.js';
import type { HushBundleConflictDetail, HushCompactRecord, HushContext, HushResolvedNode, ResolveOptions } from '../types.js';

function formatReaders(readers: { roles: string[]; identities: string[] }): string {
  return `roles=${readers.roles.join(',') || '-'} identities=${readers.identities.join(',') || '-'}`;
}

function formatProvenance(node: HushResolvedNode): string[] {
  const lines = node.provenance.map((record) => {
    const importLabel = record.import
      ? ` imported-from=${record.import.project}${record.import.bundle ? `:${record.import.bundle}` : ''}${record.import.file ? `:${record.import.file}` : ''}`
      : '';
    return `      ${pc.dim(`file=${record.filePath} namespace=${record.namespace}${importLabel}`)}`;
  });

  if (node.interpolation?.dependencies.length) {
    for (const dependency of node.interpolation.dependencies) {
      lines.push(`      ${pc.dim(`interpolation=${dependency.path}${dependency.filePath ? ` <- ${dependency.filePath}` : ''}`)}`);
    }
  }

  return lines;
}

function formatConflict(conflict: HushBundleConflictDetail): string[] {
  return [
    `  ${pc.red(conflict.path)} ${pc.dim(`(precedence ${conflict.precedence})`)}`,
    ...conflict.contenders.map((contender) => `    ${pc.dim(`file=${contender.filePath} bundle=${contender.bundle ?? '-'}`)}`),
  ];
}

function toSafeNodeSummary(node: HushResolvedNode): object {
  return {
    provenance: node.provenance.map((record) => ({
      filePath: record.filePath,
      namespace: record.namespace,
      import: record.import,
    })),
    resolvedFrom: node.resolvedFrom,
    interpolation: node.interpolation,
  };
}

function matchesResolveSelector(selector: string, logicalPath: string): boolean {
  return logicalPath === selector || logicalPath.split('/').filter(Boolean).at(-1) === selector;
}

function filterResolvedNodes<T extends Record<string, HushResolvedNode>>(nodes: T, only: string | undefined): Record<string, HushResolvedNode> {
  if (!only) {
    return { ...nodes };
  }

  return Object.fromEntries(
    Object.entries(nodes).filter(([logicalPath]) => matchesResolveSelector(only, logicalPath)),
  );
}

function toResolveCompactRecord(target: string, logicalPath: string, node: HushResolvedNode): HushCompactRecord {
  return toCompactRecord(logicalPath, target, node);
}

function toSafeResolutionJson(
  resolution: ReturnType<typeof resolveV3Target>,
  target: NonNullable<ReturnType<typeof loadV3Repository>['manifest']['targets']>[string],
  only: string | undefined,
): object {
  const filteredValues = filterResolvedNodes(resolution.values, only);
  const filteredArtifacts = filterResolvedNodes(resolution.artifacts, only);

  return {
    target: resolution.target,
    bundle: resolution.bundle,
    format: target.format,
    mode: target.mode,
    identity: resolution.identity,
    files: resolution.files,
    valuePaths: Object.keys(filteredValues).sort(),
    artifactPaths: Object.keys(filteredArtifacts).sort(),
    values: Object.fromEntries(
      Object.entries(filteredValues)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([logicalPath, node]) => [logicalPath, toSafeNodeSummary(node)]),
    ),
    artifacts: Object.fromEntries(
      Object.entries(filteredArtifacts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([logicalPath, node]) => [logicalPath, toSafeNodeSummary(node)]),
    ),
    conflicts: resolution.conflicts,
  };
}

function explainUnreadableFiles(repository: ReturnType<typeof loadV3Repository>, message: string): string[] {
  const match = message.match(/: (.+)$/);
  const rawFiles = match?.[1]?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];

  return rawFiles.flatMap((filePath) => {
    const file = repository.filesByPath[filePath];
    if (!file) {
      return [`  ${pc.yellow(filePath)}`];
    }

    return [`  ${pc.yellow(filePath)} ${pc.dim(`(${formatReaders(file.readers)})`)}`];
  });
}

export async function resolveCommand(ctx: HushContext, options: ResolveOptions): Promise<void> {
  const compactMode = options.compact ?? false;
  const compactJsonMode = options.jsonCompact ?? false;
  const repository = loadV3Repository(options.store.root, { keyIdentity: options.store.keyIdentity });
  const identity = requireActiveIdentity(ctx, options.store, repository.manifest.identities, {
    name: 'resolve',
    args: [options.target],
  });
  const target = repository.manifest.targets?.[options.target];

  if (!target) {
    ctx.logger.error(`Target not found: ${options.target}`);
    ctx.logger.error(pc.dim(`Available targets: ${Object.keys(repository.manifest.targets ?? {}).join(', ') || '(none)'}`));
    ctx.process.exit(1);
  }

  try {
    const resolution = resolveV3Target(ctx, {
      store: options.store,
      repository,
      targetName: options.target,
      command: { name: 'resolve', args: [options.target] },
    });
    const lines: string[] = [];
    const logicalPaths = [...Object.keys(resolution.values), ...Object.keys(resolution.artifacts)].sort();
    const filteredValues = filterResolvedNodes(resolution.values, options.only);
    const filteredArtifacts = filterResolvedNodes(resolution.artifacts, options.only);
    const filteredLogicalPaths = [...Object.keys(filteredValues), ...Object.keys(filteredArtifacts)].sort();
    const compactRecords: HushCompactRecord[] = [
      ...Object.entries(filteredValues).map(([logicalPath, node]) => toResolveCompactRecord(resolution.target, logicalPath, node)),
      ...Object.entries(filteredArtifacts).map(([logicalPath, node]) => toResolveCompactRecord(resolution.target, logicalPath, node)),
    ].sort((left, right) => left.key.localeCompare(right.key) || left.source.localeCompare(right.source));

    appendAuditEvent(ctx, options.store, {
      type: 'read_attempt',
      activeIdentity: identity,
      success: true,
      command: { name: 'resolve', args: [options.target] },
      files: resolution.files,
      logicalPaths,
      bundle: resolution.bundle,
      target: resolution.target,
    });

    if (compactJsonMode) {
      ctx.logger.log(JSON.stringify(compactRecords, null, 2));
      return;
    }

    if (options.json) {
      ctx.logger.log(JSON.stringify(toSafeResolutionJson(resolution, target, options.only), null, 2));
      return;
    }

    lines.push(pc.blue('Hush resolve\n'));
    lines.push(`Target: ${pc.cyan(resolution.target)}`);
    lines.push(`Bundle: ${pc.cyan(resolution.bundle)}`);
    lines.push(`Format: ${pc.dim(target.format)}${target.mode ? pc.dim(` (${target.mode})`) : ''}`);
    lines.push(`Active identity: ${pc.green(resolution.identity)}`);
    lines.push(`Resolved files: ${pc.cyan(String(resolution.files.length))}`);
    lines.push(`Resolved logical paths: ${pc.cyan(String(filteredLogicalPaths.length))}`);

    if (options.only) {
      lines.push(`Filtered by: ${pc.cyan(options.only)}`);
    }

    if (compactMode) {
      const compactLines: string[] = [pc.blue('Hush resolve compact\n')];
      if (compactRecords.length === 0) {
        compactLines.push(pc.yellow('No resolved entries match filter.'));
      } else {
        for (const record of compactRecords) {
          compactLines.push(formatCompactRecord(record));
        }
      }
      ctx.logger.log(compactLines.join('\n'));
      return;
    }

    lines.push('');
    lines.push('Files:');
    for (const filePath of resolution.files) {
      lines.push(`  ${pc.cyan(filePath)}`);
    }

    lines.push('');
    lines.push('Values:');
    if (Object.keys(filteredValues).length === 0) {
      lines.push(`  ${pc.dim('(none)')}`);
    } else {
      for (const [logicalPath, node] of Object.entries(filteredValues).sort(([left], [right]) => left.localeCompare(right))) {
        lines.push(`  ${logicalPath}`);
        lines.push(...formatProvenance(node));
      }
    }

    lines.push('');
    lines.push('Artifacts:');
    if (Object.keys(filteredArtifacts).length === 0) {
      lines.push(`  ${pc.dim('(none)')}`);
    } else {
      for (const [logicalPath, node] of Object.entries(filteredArtifacts).sort(([left], [right]) => left.localeCompare(right))) {
        const entry = node.entry;
        lines.push(`  ${logicalPath} ${'type' in entry ? pc.dim(`(${entry.type}:${entry.format})`) : ''}`.trimEnd());
        lines.push(...formatProvenance(node));
      }
    }

    ctx.logger.log(lines.join('\n'));
  } catch (error) {
    if (error instanceof HushResolutionConflictError) {
      ctx.logger.error(pc.red(error.message));
      ctx.logger.error('Conflicts:');
      for (const line of error.conflicts.flatMap((conflict) => formatConflict(conflict))) {
        ctx.logger.error(line);
      }
      ctx.process.exit(1);
    }

    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error(pc.red(message));

    if (message.includes('requires unreadable file')) {
      ctx.logger.error('Unreadable files:');
      for (const line of explainUnreadableFiles(repository, message)) {
        ctx.logger.error(line);
      }
    }

    ctx.process.exit(1);
  }
}
