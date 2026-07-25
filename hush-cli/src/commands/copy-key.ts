import { stringify as stringifyYaml } from 'yaml';
import { appendAuditEvent } from '../v3/audit.js';
import { createFileDocument } from '../v3/domain.js';
import { loadV3Repository, persistV3FileDocument, persistV3FileDocuments } from '../v3/repository.js';
import { MACHINE_LOCAL_FILE_PATH, assertRepositoryFilePath } from '../v3/schema.js';
import { requireMutableIdentity } from './v3-command-helpers.js';
import { withSuggestion } from './mutation-feedback.js';
import type { HushContext, HushFileDocument, HushFileEntry, KeyTransferOptions } from '../types.js';
import { writeJsonSuccess } from '../lib/command-output.js';

function logicalPathKey(logicalPath: string): string {
  return logicalPath.split('/').filter(Boolean).at(-1) ?? logicalPath;
}

function findEntryByLeafKey(document: HushFileDocument, key: string): { logicalPath: string; entry: HushFileEntry } {
  const matches = Object.entries(document.entries).filter(([logicalPath]) => logicalPathKey(logicalPath) === key);
  if (matches.length === 0) {
    throw new Error(`Key "${key}" was not found in ${document.path}`);
  }
  if (matches.length > 1) {
    throw new Error(`Key "${key}" matched multiple entries in ${document.path}; use a file with unambiguous leaf keys before copying`);
  }
  const [logicalPath, entry] = matches[0]!;
  return { logicalPath, entry };
}

function getSystemPath(repository: ReturnType<typeof loadV3Repository>, filePath: string): string {
  const systemPath = repository.fileSystemPaths[filePath];
  if (!systemPath) {
    throw new Error(withSuggestion(
      `File "${filePath}" is not declared in this repository. No keys were changed.`,
      filePath,
      Object.keys(repository.fileSystemPaths),
    ));
  }
  return systemPath;
}

function transferEntry(source: HushFileDocument, target: HushFileDocument, key: string, move: boolean): {
  nextSource: HushFileDocument;
  nextTarget: HushFileDocument;
  sourceLogicalPath: string;
  targetLogicalPath: string;
} {
  const { logicalPath: sourceLogicalPath, entry } = findEntryByLeafKey(source, key);
  const targetLogicalPath = `${target.path}/${key}`;
  const nextTarget = createFileDocument({
    ...target,
    entries: {
      ...target.entries,
      [targetLogicalPath]: entry,
    },
  });

  if (!move) {
    return {
      nextSource: source,
      nextTarget,
      sourceLogicalPath,
      targetLogicalPath,
    };
  }

  const { [sourceLogicalPath]: _removed, ...remainingEntries } = source.entries;
  return {
    nextSource: createFileDocument({
      ...source,
      entries: remainingEntries,
    }),
    nextTarget,
    sourceLogicalPath,
    targetLogicalPath,
  };
}

export async function copyKeyCommand(ctx: HushContext, options: KeyTransferOptions): Promise<void> {
  const key = options.key?.trim();
  if (!key) {
    throw new Error(`Usage: hush ${options.move ? 'move-key' : 'copy-key'} <KEY> --from <file-path> --to <file-path>`);
  }
  if (!options.from || !options.to) {
    throw new Error(`Usage: hush ${options.move ? 'move-key' : 'copy-key'} <KEY> --from <file-path> --to <file-path>`);
  }

  const commandName = options.move ? 'move-key' : 'copy-key';

  // Repository files only, fail closed. A machine-local selector is never
  // reinterpreted here: moving a secret between the machine-local store and a
  // committed file is a readership change, not a copy.
  const remedy = `Machine-local overrides live at "${MACHINE_LOCAL_FILE_PATH}"; `
    + `${commandName} operates on committed repository files only. Write machine-local values with "hush set --repo-local".`;
  const from = assertRepositoryFilePath(options.from, remedy);
  const to = assertRepositoryFilePath(options.to, remedy);
  if (from === to) {
    throw new Error('Source and destination files must be different');
  }

  const repository = loadV3Repository(options.store.root, { keyIdentity: options.store.keyIdentity });
  const command = { name: commandName, args: [key, '--from', from, '--to', to] };
  const activeIdentity = requireMutableIdentity(ctx, options.store, repository, command);

  const sourceDocument = repository.loadFile(from);
  const targetDocument = repository.loadFile(to);
  const { nextSource, nextTarget, sourceLogicalPath, targetLogicalPath } = transferEntry(sourceDocument, targetDocument, key, options.move);

  if (options.move) {
    persistV3FileDocuments(ctx, options.store, repository, [
      { systemPath: getSystemPath(repository, to), document: nextTarget },
      { systemPath: getSystemPath(repository, from), document: nextSource },
    ]);
  } else {
    persistV3FileDocument(ctx, options.store, repository, getSystemPath(repository, to), nextTarget);
  }

  appendAuditEvent(ctx, options.store, {
    type: 'write',
    activeIdentity,
    success: true,
    command,
    files: options.move ? [from, to] : [from, to],
    logicalPaths: options.move ? [sourceLogicalPath, targetLogicalPath] : [targetLogicalPath],
    details: {
      action: options.move ? 'move' : 'copy',
      key,
      from,
      to,
    },
  });

  const payload = {
    ok: true,
    action: options.move ? 'move' : 'copy',
    changed: true,
    key,
    requestedScope: { from: options.from, to: options.to },
    resolvedScope: { from, to },
    from,
    to,
    sourceLogicalPath,
    targetLogicalPath,
  };

  if (options.json) {
    writeJsonSuccess(ctx, commandName, payload);
    return;
  }

  ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
}

export async function moveKeyCommand(ctx: HushContext, options: Omit<KeyTransferOptions, 'move'>): Promise<void> {
  await copyKeyCommand(ctx, { ...options, move: true });
}
