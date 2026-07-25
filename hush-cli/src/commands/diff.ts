import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import pc from 'picocolors';
import { writeJsonSuccess } from '../lib/command-output.js';
import { decryptYaml } from '../core/sops.js';
import { createFileIndexEntry } from '../v3/domain.js';
import { parseFileDocument, parseManifestDocument } from '../v3/manifest.js';
import { resolveV3Bundle, resolveV3Target } from '../v3/resolver.js';
import { requireActiveIdentity } from '../v3/identity.js';
import { requireV3Repository, selectRuntimeTarget } from './v3-command-helpers.js';
import type {
  DiffOptions,
  HushBundleResolution,
  HushContext,
  HushFileDocument,
  HushProvenanceRecord,
  HushResolvedNode,
  StoreContext,
  HushTargetResolution,
  HushV3Repository,
} from '../types.js';

const DEFAULT_GIT_REF = 'HEAD';

type DiffSelection =
  | { kind: 'target'; name: string }
  | { kind: 'bundle'; name: string };

interface HistoricalRepositoryState {
  repository: HushV3Repository;
  ref: string;
}

interface ComparableNode {
  kind: 'value' | 'artifact';
  sensitive: boolean;
  summary: string;
  provenance: string[];
  interpolation: string[];
}

function formatReaders(file: Pick<HushFileDocument, 'readers'>): string {
  return `roles=${file.readers.roles.join(',') || '-'} identities=${file.readers.identities.join(',') || '-'}`;
}

function formatProvenanceRecord(record: HushProvenanceRecord): string {
  const importLabel = record.import
    ? ` imported-from=${record.import.project}${record.import.bundle ? `:${record.import.bundle}` : ''}${record.import.file ? `:${record.import.file}` : ''}`
    : '';

  return `file=${record.filePath} namespace=${record.namespace}${importLabel}`;
}

function summarizeValue(value: HushResolvedNode['entry']['value']): string {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value);
}

function summarizeNode(node: HushResolvedNode): ComparableNode {
  if ('type' in node.entry) {
    return {
      kind: 'artifact',
      sensitive: node.entry.sensitive,
      summary: node.entry.sensitive
        ? `[redacted ${node.entry.type}:${node.entry.format}]`
        : node.entry.type === 'binary'
          ? `[binary ${node.entry.format}${node.entry.encoding ? ` ${node.entry.encoding}` : ''}]`
          : node.entry.value !== undefined
            ? node.entry.value
            : `[generated ${node.entry.format}]`,
      provenance: node.provenance.map(formatProvenanceRecord),
      interpolation: (node.interpolation?.dependencies ?? []).map((dependency) => (
        `interpolation=${dependency.path}${dependency.filePath ? ` <- ${dependency.filePath}` : ''}`
      )),
    };
  }

  return {
    kind: 'value',
    sensitive: node.entry.sensitive,
    summary: node.entry.sensitive ? '[redacted]' : summarizeValue(node.entry.value),
    provenance: node.provenance.map(formatProvenanceRecord),
    interpolation: (node.interpolation?.dependencies ?? []).map((dependency) => (
      `interpolation=${dependency.path}${dependency.filePath ? ` <- ${dependency.filePath}` : ''}`
    )),
  };
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readGitTextFile(ctx: HushContext, root: string, gitRelativePath: string, ref: string): string {
  try {
    const output = ctx.exec.execSync(
      `git -C ${quoteForShell(root)} show ${quoteForShell(`${ref}:${gitRelativePath}`)}`,
      { encoding: 'utf-8' },
    );
    return typeof output === 'string' ? output : output.toString('utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${gitRelativePath} from git ref "${ref}": ${message}`);
  }
}

function listGitFiles(ctx: HushContext, root: string, ref: string, prefix: string): string[] {
  const output = ctx.exec.execSync(
    `git -C ${quoteForShell(root)} ls-tree -r --name-only ${quoteForShell(ref)} -- ${quoteForShell(prefix)}`,
    { encoding: 'utf-8' },
  );
  const text = typeof output === 'string' ? output : output.toString('utf-8');

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function decryptHistoricalYamlContent(store: StoreContext, encryptedContent: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'hush-diff-'));
  const tempPath = join(tempDir, 'historical.encrypted');

  try {
    chmodSync(tempDir, 0o700);
    writeFileSync(tempPath, encryptedContent, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(tempPath, 0o600);
    return decryptYaml(tempPath, {
      root: store.root,
      keyIdentity: store.keyIdentity,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function loadHistoricalRepository(ctx: HushContext, repository: HushV3Repository, store: StoreContext, ref: string): HistoricalRepositoryState {
  const prefixOutput = ctx.exec.execSync(
    `git -C ${quoteForShell(repository.projectRoot)} rev-parse --show-prefix`,
    { encoding: 'utf-8' },
  );
  const repoPrefix = (typeof prefixOutput === 'string' ? prefixOutput : prefixOutput.toString('utf-8')).trim().replace(/\/$/, '');
  const toGitPath = (path: string) => (repoPrefix ? `${repoPrefix}/${path}` : path);
  const manifestGitPath = toGitPath('.hush/manifest.encrypted');
  const manifestEncrypted = readGitTextFile(ctx, repository.projectRoot, manifestGitPath, ref);
  const manifest = parseManifestDocument(
    resolvePath(repository.projectRoot, '.hush', 'manifest.encrypted'),
    decryptHistoricalYamlContent(store, manifestEncrypted),
  );
  const filePaths = listGitFiles(ctx, repository.projectRoot, ref, toGitPath('.hush/files'));
  const filesByPath: Record<string, HushFileDocument> = {};
  const fileSystemPaths: Record<string, string> = {};

  for (const gitFilePath of filePaths) {
    if (!gitFilePath.endsWith('.encrypted')) {
      continue;
    }

    const relativeToRepo = repoPrefix ? gitFilePath.slice(repoPrefix.length + 1) : gitFilePath;
    const absolutePath = resolvePath(repository.projectRoot, relativeToRepo);
    const encryptedContent = readGitTextFile(ctx, repository.projectRoot, gitFilePath, ref);
    const file = parseFileDocument(
      absolutePath,
      decryptHistoricalYamlContent(store, encryptedContent),
      repository.filesRoot,
    );

    filesByPath[file.path] = file;
    fileSystemPaths[file.path] = absolutePath;
  }

  const historicalFileIndex = Object.fromEntries(Object.values(filesByPath).map((file) => [file.path, createFileIndexEntry(file)]));

  return {
    ref,
    repository: {
      kind: 'v3',
      projectRoot: repository.projectRoot,
      manifestPath: resolvePath(repository.projectRoot, '.hush', 'manifest.encrypted'),
      filesRoot: resolvePath(repository.projectRoot, '.hush', 'files'),
      manifest: {
        ...manifest,
        fileIndex: historicalFileIndex,
      },
      files: Object.values(historicalFileIndex),
      filesByPath: historicalFileIndex,
      fileSystemPaths,
      loadFile(filePath) {
        const file = filesByPath[filePath];
        if (!file) {
          throw new Error(`File "${filePath}" is not declared in repository ${repository.projectRoot}`);
        }

        return file;
      },
    },
  };
}

function selectDiffSubject(repository: HushV3Repository, options: Pick<DiffOptions, 'target' | 'bundle'>): DiffSelection {
  if (options.target && options.bundle) {
    throw new Error('Use either --target or --bundle, not both.');
  }

  if (options.bundle) {
    if (!repository.manifest.bundles?.[options.bundle]) {
      throw new Error(`Bundle "${options.bundle}" not found. Available bundles: ${Object.keys(repository.manifest.bundles ?? {}).sort().join(', ') || '(none)'}`);
    }

    return { kind: 'bundle', name: options.bundle };
  }

  const { targetName } = selectRuntimeTarget(repository, options.target);
  return { kind: 'target', name: targetName };
}

function resolveSelection(
  ctx: HushContext,
  selection: DiffSelection,
  repository: HushV3Repository,
  store: DiffOptions['store'],
  identity: string,
): HushBundleResolution | HushTargetResolution {
  if (selection.kind === 'bundle') {
    return resolveV3Bundle(ctx, {
      store,
      repository,
      bundleName: selection.name,
      activeIdentity: identity,
      command: { name: 'diff', args: [selection.name] },
      // Diff compares committed repository content across git refs. Machine-local
      // state is not versioned, so it is not part of what is being compared.
      machineLocal: 'exclude',
    });
  }

  return resolveV3Target(ctx, {
    store,
    repository,
    targetName: selection.name,
    activeIdentity: identity,
    command: { name: 'diff', args: [selection.name] },
    machineLocal: 'exclude',
  });
}

function pushSection(lines: string[], title: string, entries: string[]): void {
  lines.push('');
  lines.push(`${title}:`);
  if (entries.length === 0) {
    lines.push(`  ${pc.dim('(none)')}`);
    return;
  }

  lines.push(...entries);
}

function compareFileState(
  current: HushV3Repository,
  previous: HushV3Repository,
  currentResolution: HushBundleResolution,
  previousResolution: HushBundleResolution,
): string[] {
  const filePaths = Array.from(new Set([...currentResolution.files, ...previousResolution.files])).sort();
  const lines: string[] = [];

  for (const filePath of filePaths) {
    const currentFile = current.filesByPath[filePath];
    const previousFile = previous.filesByPath[filePath];

    if (!previousFile && currentFile) {
      lines.push(`  ${pc.green('+')} ${filePath} ${pc.dim(`(${formatReaders(currentFile)})`)}`);
      continue;
    }

    if (previousFile && !currentFile) {
      lines.push(`  ${pc.red('-')} ${filePath} ${pc.dim(`(${formatReaders(previousFile)})`)}`);
      continue;
    }

    if (currentFile && previousFile) {
      const currentReaders = formatReaders(currentFile);
      const previousReaders = formatReaders(previousFile);
      if (currentReaders !== previousReaders) {
        lines.push(`  ${pc.yellow('~')} ${filePath}`);
        lines.push(`    ${pc.dim('ref')}     ${previousReaders}`);
        lines.push(`    ${pc.dim('current')} ${currentReaders}`);
      }
    }
  }

  return lines;
}

function compareResolvedNodes(
  currentResolution: HushBundleResolution,
  previousResolution: HushBundleResolution,
): string[] {
  const currentNodes = { ...currentResolution.values, ...currentResolution.artifacts };
  const previousNodes = { ...previousResolution.values, ...previousResolution.artifacts };
  const logicalPaths = Array.from(new Set([...Object.keys(currentNodes), ...Object.keys(previousNodes)])).sort();
  const lines: string[] = [];

  for (const logicalPath of logicalPaths) {
    const currentNode = currentNodes[logicalPath];
    const previousNode = previousNodes[logicalPath];

    if (!previousNode && currentNode) {
      const summary = summarizeNode(currentNode);
      lines.push(`  ${pc.green('+')} ${logicalPath} ${pc.dim(`(${summary.kind})`)}`);
      lines.push(`    ${pc.dim('current')} ${summary.summary}`);
      for (const provenance of summary.provenance) {
        lines.push(`      ${pc.dim(provenance)}`);
      }
      for (const interpolation of summary.interpolation) {
        lines.push(`      ${pc.dim(interpolation)}`);
      }
      continue;
    }

    if (previousNode && !currentNode) {
      const summary = summarizeNode(previousNode);
      lines.push(`  ${pc.red('-')} ${logicalPath} ${pc.dim(`(${summary.kind})`)}`);
      lines.push(`    ${pc.dim('ref')} ${summary.summary}`);
      for (const provenance of summary.provenance) {
        lines.push(`      ${pc.dim(provenance)}`);
      }
      for (const interpolation of summary.interpolation) {
        lines.push(`      ${pc.dim(interpolation)}`);
      }
      continue;
    }

    if (!currentNode || !previousNode) {
      continue;
    }

    const currentSummary = summarizeNode(currentNode);
    const previousSummary = summarizeNode(previousNode);
    const changed = JSON.stringify({
      entry: currentNode.entry,
      provenance: currentNode.provenance,
      interpolation: currentNode.interpolation,
    }) !== JSON.stringify({
      entry: previousNode.entry,
      provenance: previousNode.provenance,
      interpolation: previousNode.interpolation,
    });

    if (!changed) {
      continue;
    }

    lines.push(`  ${pc.yellow('~')} ${logicalPath} ${pc.dim(`(${currentSummary.kind})`)}`);
    lines.push(`    ${pc.dim('ref')}     ${previousSummary.summary}`);
    for (const provenance of previousSummary.provenance) {
      lines.push(`      ${pc.dim(provenance)}`);
    }
    for (const interpolation of previousSummary.interpolation) {
      lines.push(`      ${pc.dim(interpolation)}`);
    }
    lines.push(`    ${pc.dim('current')} ${currentSummary.summary}`);
    for (const provenance of currentSummary.provenance) {
      lines.push(`      ${pc.dim(provenance)}`);
    }
    for (const interpolation of currentSummary.interpolation) {
      lines.push(`      ${pc.dim(interpolation)}`);
    }
  }

  return lines;
}

export async function diffCommand(ctx: HushContext, options: DiffOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'diff');
  const selection = selectDiffSubject(repository, options);
  const identity = requireActiveIdentity(ctx, options.store, repository.manifest.identities, {
    name: 'diff',
    args: [selection.name],
  });
  const ref = options.ref ?? DEFAULT_GIT_REF;
  const historical = loadHistoricalRepository(ctx, repository, options.store, ref);

  if (!historical.repository.manifest.identities[identity]) {
    throw new Error(`Active identity "${identity}" is not declared in git ref "${ref}".`);
  }

  if (selection.kind === 'bundle' && !historical.repository.manifest.bundles?.[selection.name]) {
    throw new Error(`Bundle "${selection.name}" does not exist in git ref "${ref}".`);
  }

  if (selection.kind === 'target' && !historical.repository.manifest.targets?.[selection.name]) {
    throw new Error(`Target "${selection.name}" does not exist in git ref "${ref}".`);
  }

  const currentResolution = resolveSelection(ctx, selection, repository, options.store, identity);
  const previousResolution = resolveSelection(ctx, selection, historical.repository, options.store, identity);
  const fileChanges = compareFileState(repository, historical.repository, currentResolution, previousResolution);
  const valueChanges = compareResolvedNodes(currentResolution, previousResolution);

  if (options.json) {
    writeJsonSuccess(ctx, 'diff', {
      reference: ref,
      selection,
      activeIdentity: identity,
      fileChanges,
      resolvedChanges: valueChanges,
      changed: fileChanges.length > 0 || valueChanges.length > 0,
    });
    return;
  }
  const lines: string[] = [pc.blue('Hush diff\n')];

  lines.push(`Reference: ${pc.cyan(ref)}`);
  lines.push(`Selection: ${pc.cyan(`${selection.kind} ${selection.name}`)}`);
  lines.push(`Active identity: ${pc.green(identity)}`);

  pushSection(lines, 'File changes', fileChanges);
  pushSection(lines, 'Resolved changes', valueChanges);

  if (fileChanges.length === 0 && valueChanges.length === 0) {
    lines.push('');
    lines.push(pc.green(`No redacted changes between current state and ${ref} for ${selection.kind} ${selection.name}.`));
  }

  ctx.logger.log(lines.join('\n'));
}
