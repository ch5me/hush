import pc from 'picocolors';
import { appendAuditEvent } from '../index.js';
import type { EditOptions, HushContext } from '../types.js';
import {
  describeLegacyLocalRepositoryFile,
  findLegacyLocalRepositoryFile,
  loadEditableDestination,
  openEncryptedDocumentEditor,
  readCurrentIdentity,
  requireMutableIdentity,
  requireV3Repository,
  resolveEditableDestination,
} from './v3-command-helpers.js';
import { LEGACY_MACHINE_LOCAL_FILE_PATH } from '../v3/schema.js';

export async function editCommand(ctx: HushContext, options: EditOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'edit');
  const destination = resolveEditableDestination(options.file ?? 'shared', repository);
  const editable = loadEditableDestination(ctx, options.store, repository, destination);
  const auditArgs = [destination.fileKey ?? editable.filePath];

  const legacyLocal = destination.filePath === LEGACY_MACHINE_LOCAL_FILE_PATH
    ? findLegacyLocalRepositoryFile(repository)
    : null;
  if (legacyLocal) {
    ctx.logger.warn(pc.yellow(`warning: ${describeLegacyLocalRepositoryFile(legacyLocal)}`));
  }

  const activeIdentity = requireMutableIdentity(ctx, options.store, repository, {
    name: 'edit',
    args: auditArgs,
  });

  try {
    ctx.logger.log(pc.blue(`Editing ${editable.filePath}...`));
    ctx.logger.log(pc.dim('This decrypts the v3 document to a temp YAML file, then re-encrypts it after validation.'));

    openEncryptedDocumentEditor(
      ctx,
      options.store,
      editable.systemPath,
      editable.scope === 'repository' ? repository : undefined,
      options.editor,
    );

    appendAuditEvent(ctx, options.store, {
      type: 'write',
      activeIdentity,
      success: true,
      command: { name: 'edit', args: auditArgs },
      files: [editable.filePath],
      details: {
        scope: editable.scope,
      },
    });

    ctx.logger.log(pc.green('\nEdit complete'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendAuditEvent(ctx, options.store, {
      type: 'write',
      activeIdentity: readCurrentIdentity(ctx, options.store),
      success: false,
      command: { name: 'edit', args: auditArgs },
      files: [editable.filePath],
      reason: message,
    });
    throw error;
  }
}
