import pc from 'picocolors';
import { appendAuditEvent } from '../index.js';
import type { EditOptions, HushContext } from '../types.js';
import {
  ensureEditableFileDocument,
  openEncryptedDocumentEditor,
  readCurrentIdentity,
  requireMutableIdentity,
  requireV3Repository,
} from './v3-command-helpers.js';

type FileKey = 'shared' | 'development' | 'production' | 'local';

export async function editCommand(ctx: HushContext, options: EditOptions): Promise<void> {
  const fileKey: FileKey = options.file ?? 'shared';
  const repository = requireV3Repository(options.store, 'edit');
  const activeIdentity = requireMutableIdentity(ctx, options.store, repository, {
    name: 'edit',
    args: [fileKey],
  });
  const editable = ensureEditableFileDocument(ctx, options.store, repository, fileKey);

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
      command: { name: 'edit', args: [fileKey] },
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
      command: { name: 'edit', args: [fileKey] },
      files: [editable.filePath],
      reason: message,
    });
    throw error;
  }
}
