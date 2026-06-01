import type { HushAuditCommandContext } from './audit.js';
import { appendAuditEvent } from './audit.js';
import { createProvenanceRecord, isIdentityAllowed, type HushBundleName, type HushFileEntry, type HushFileIndexEntry, type HushIdentityName, type HushLogicalPath, type HushTargetName } from './domain.js';
import { getNamespaceFromPath } from './schema.js';
import { requireActiveIdentity } from './identity.js';
import type { HushContext, HushV3Repository, StoreContext } from '../types.js';
import { formatDuplicateKeyHint } from '../commands/v3-command-helpers.js';
import { interpolateCandidates } from './interpolation.js';
import { collectAllRepositoryPaths, collectBundleCandidates } from './imports.js';
import type { HushImportRepositoryMap, HushSelectedFileCandidate } from './imports.js';
import type { HushBundleConflictDetail, HushBundleResolution, HushResolvedNode, HushSelectedEntryCandidate, HushTargetResolution } from './provenance.js';

export interface ResolveV3Options {
  store: StoreContext;
  repository: HushV3Repository;
  importedRepositories?: HushImportRepositoryMap;
  activeIdentity?: HushIdentityName;
  command?: HushAuditCommandContext;
  importPrecedence?: 'local' | 'imported';
}

export interface ResolveV3BundleOptions extends ResolveV3Options {
  bundleName: HushBundleName;
}

export interface ResolveV3TargetOptions extends ResolveV3Options {
  targetName: HushTargetName;
}

export class HushResolutionConflictError extends Error {
  conflicts: HushBundleConflictDetail[];

  constructor(message: string, conflicts: HushBundleConflictDetail[]) {
    super(message);
    this.name = 'HushResolutionConflictError';
    this.conflicts = conflicts;
  }
}

function getIdentityRoles(repository: HushV3Repository, identity: HushIdentityName): string[] {
  const record = repository.manifest.identities[identity];

  if (!record) {
    throw new Error(`Identity "${identity}" is not declared in repository ${repository.projectRoot}`);
  }

  return record.roles;
}

function canReadFile(file: HushFileIndexEntry, identity: HushIdentityName, roles: readonly string[]): boolean {
  return roles.some((role) => isIdentityAllowed(file.readers, identity, role as never));
}

function getPrecedence(importPrecedence: 'local' | 'imported' | undefined): { local: number; imported: number } {
  return importPrecedence === 'imported'
    ? { local: 100, imported: 200 }
    : { local: 200, imported: 100 };
}

function partitionReadableCandidates(
  repository: HushV3Repository,
  importedRepositories: HushImportRepositoryMap,
  identity: HushIdentityName,
  candidates: HushSelectedFileCandidate[],
): {
  readableCandidates: HushSelectedFileCandidate[];
  unreadableFiles: string[];
  globalPathState: Record<string, { readableFiles: Set<string>; unreadableFiles: Set<string> }>;
} {
  const globalPathState = collectAllRepositoryPaths(repository, importedRepositories);
  const unreadableFiles = new Set<string>();
  const readableCandidates: HushSelectedFileCandidate[] = [];

  for (const candidateRepository of [repository, ...Object.values(importedRepositories)]) {
    const roles = getIdentityRoles(candidateRepository, identity);

    for (const file of Object.values(candidateRepository.filesByPath)) {
      const readable = canReadFile(file, identity, roles);

      for (const logicalPath of file.logicalPaths) {
        const pathState = globalPathState[logicalPath];

        if (!pathState) {
          continue;
        }

        if (readable) {
          pathState.readableFiles.add(file.path);
        } else {
          pathState.unreadableFiles.add(file.path);
        }
      }
    }
  }

  for (const candidate of candidates) {
    const filePath = candidate.file.path;
    const roles = getIdentityRoles(candidate.repository, identity);
    const readable = canReadFile(candidate.file, identity, roles);

    if (readable) {
      readableCandidates.push(candidate);
      continue;
    }

    unreadableFiles.add(filePath);
  }

  return {
    readableCandidates,
    unreadableFiles: Array.from(unreadableFiles).sort(),
    globalPathState,
  };
}

function materializeReadableCandidates(candidates: HushSelectedFileCandidate[]): HushSelectedEntryCandidate[] {
  return candidates.flatMap((candidate) => {
    const file = candidate.repository.loadFile(candidate.file.path);

    return Object.entries(file.entries).map(([logicalPath, entry]) => ({
      path: logicalPath,
      entry: entry as HushFileEntry,
      precedence: candidate.precedence,
      provenance: [
        createProvenanceRecord({
          logicalPath,
          filePath: candidate.file.path,
          bundle: candidate.bundleName,
          import: candidate.importRecord,
          namespace: getNamespaceFromPath(logicalPath),
        }),
      ],
    }));
  });
}

function selectWinningCandidates(candidates: HushSelectedEntryCandidate[]): {
  selected: Record<HushLogicalPath, HushSelectedEntryCandidate>;
  conflicts: HushBundleConflictDetail[];
} {
  const grouped = new Map<HushLogicalPath, HushSelectedEntryCandidate[]>();

  for (const candidate of candidates) {
    const existing = grouped.get(candidate.path);

    if (existing) {
      existing.push(candidate);
      continue;
    }

    grouped.set(candidate.path, [candidate]);
  }

  const selected: Record<HushLogicalPath, HushSelectedEntryCandidate> = {};
  const conflicts: HushBundleConflictDetail[] = [];

  for (const [path, contenders] of grouped.entries()) {
    const highestPrecedence = Math.max(...contenders.map((candidate) => candidate.precedence));
    const winners = contenders.filter((candidate) => candidate.precedence === highestPrecedence);

    if (winners.length > 1) {
      conflicts.push({
        path,
        precedence: highestPrecedence,
        contenders: winners.flatMap((winner) => winner.provenance),
      });
      continue;
    }

    selected[path] = winners[0]!;
  }

  return { selected, conflicts };
}

function splitResolvedNodes(nodes: Record<string, HushResolvedNode>): {
  values: Record<string, HushResolvedNode>;
  artifacts: Record<string, HushResolvedNode>;
} {
  const values: Record<string, HushResolvedNode> = {};
  const artifacts: Record<string, HushResolvedNode> = {};

  for (const [path, node] of Object.entries(nodes)) {
    if ('type' in node.entry) {
      artifacts[path] = node;
      continue;
    }

    values[path] = node;
  }

  return { values, artifacts };
}

function resolveIdentity(ctx: HushContext, options: ResolveV3Options): HushIdentityName {
  if (options.activeIdentity) {
    if (!options.repository.manifest.identities[options.activeIdentity]) {
      throw new Error(`Identity "${options.activeIdentity}" is not declared in this repository`);
    }

    return options.activeIdentity;
  }

  return requireActiveIdentity(ctx, options.store, options.repository.manifest.identities, options.command);
}

function formatConflictHint(conflict: HushBundleConflictDetail, target: string): string {
  const key = conflict.path.split('/').filter(Boolean).at(-1) ?? conflict.path;
  const files = conflict.contenders.map((contender) => contender.filePath);
  return formatDuplicateKeyHint(key, files, target);
}

function createBundleResolution(
  resolvedNodes: Record<string, HushResolvedNode>,
  identity: HushIdentityName,
  bundleName: HushBundleName,
  unreadableFiles: string[],
  conflicts: HushBundleConflictDetail[],
): HushBundleResolution {
  const { values, artifacts } = splitResolvedNodes(resolvedNodes);

  return {
    identity,
    bundle: bundleName,
    values,
    artifacts,
    files: Array.from(new Set(Object.values(resolvedNodes).flatMap((node) => node.resolvedFrom))).sort(),
    unreadableFiles,
    conflicts,
  };
}

export function resolveV3Bundle(ctx: HushContext, options: ResolveV3BundleOptions): HushBundleResolution {
  const importedRepositories = options.importedRepositories ?? {};
  const identity = resolveIdentity(ctx, options);
  const precedence = getPrecedence(options.importPrecedence);
  const candidates = collectBundleCandidates({
    repository: options.repository,
    bundleName: options.bundleName,
    importedRepositories,
    localPrecedence: precedence.local,
    importedPrecedence: precedence.imported,
  });

  const { readableCandidates, unreadableFiles, globalPathState } = partitionReadableCandidates(
    options.repository,
    importedRepositories,
    identity,
    candidates,
  );

  if (unreadableFiles.length > 0) {
    appendAuditEvent(ctx, options.store, {
      type: 'access_denied',
      activeIdentity: identity,
      success: false,
      command: options.command,
      bundle: options.bundleName,
      files: unreadableFiles,
      reason: `Bundle "${options.bundleName}" requires unreadable file(s): ${unreadableFiles.join(', ')}`,
    });

    throw new Error(
      `Bundle "${options.bundleName}" requires unreadable file(s) for identity "${identity}": ${unreadableFiles.join(', ')}`,
    );
  }

  const importProjects = Array.from(
    new Set(
      readableCandidates.flatMap((candidate) =>
        candidate.importRecord ? [candidate.importRecord.project] : [],
      ),
    ),
  );

  for (const importProject of importProjects) {
    appendAuditEvent(ctx, options.store, {
      type: 'import_resolution',
      activeIdentity: identity,
      success: true,
      command: options.command,
      bundle: options.bundleName,
      importProject,
    });
  }

  const { selected, conflicts } = selectWinningCandidates(materializeReadableCandidates(readableCandidates));

  if (conflicts.length > 0) {
    const [firstConflict] = conflicts;
    const hint = firstConflict ? ` ${formatConflictHint(firstConflict, options.bundleName)}` : '';

    throw new HushResolutionConflictError(
      `Bundle "${options.bundleName}" contains equal-precedence logical path conflicts: ${conflicts.map((conflict) => conflict.path).join(', ')}.${hint}`,
      conflicts,
    );
  }

  const resolvedNodes = interpolateCandidates({
    candidates: selected,
    globalPathState,
  });

  return createBundleResolution(resolvedNodes, identity, options.bundleName, unreadableFiles, conflicts);
}

export function resolveV3Target(ctx: HushContext, options: ResolveV3TargetOptions): HushTargetResolution {
  const target = options.repository.manifest.targets?.[options.targetName];

  if (!target) {
    throw new Error(`Target "${options.targetName}" is not declared in repository ${options.repository.projectRoot}`);
  }

  if (!target.bundle) {
    throw new Error(`Target "${options.targetName}" does not reference a bundle yet`);
  }

  const bundleResolution = resolveV3Bundle(ctx, {
    ...options,
    bundleName: target.bundle,
  });

  return {
    ...bundleResolution,
    target: options.targetName,
  };
}
