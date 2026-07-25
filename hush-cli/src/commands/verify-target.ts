import pc from 'picocolors';
import { writeJsonError, writeJsonSuccess } from '../lib/command-output.js';
import { appendAuditEvent } from '../v3/audit.js';
import { requireActiveIdentity } from '../v3/identity.js';
import { loadV3Repository } from '../v3/repository.js';
import { HushResolutionConflictError, resolveV3Target } from '../v3/resolver.js';
import type { HushContext, HushResolvedNode, VerifyTargetOptions } from '../types.js';
import { globalStoreHint } from '../lib/global-store-hint.js';

function logicalPathKey(logicalPath: string): string {
  return logicalPath.split('/').filter(Boolean).at(-1) ?? logicalPath;
}

function getResolvedKeyMap(nodes: Record<string, HushResolvedNode>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const logicalPath of Object.keys(nodes).sort()) {
    const key = logicalPathKey(logicalPath);
    const existing = map.get(key) ?? [];
    existing.push(logicalPath);
    map.set(key, existing);
  }
  return map;
}

function extractUnreadableFilePaths(message: string): string[] {
  const match = message.match(/: (.+)$/);
  return match?.[1]?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
}

function formatReaders(readers: { roles: string[]; identities: string[] }): string {
  return `roles=${readers.roles.join(',') || '-'} identities=${readers.identities.join(',') || '-'}`;
}

export async function verifyTargetCommand(ctx: HushContext, options: VerifyTargetOptions): Promise<void> {
  const repository = loadV3Repository(options.store.root, { keyIdentity: options.store.keyIdentity });
  const identity = requireActiveIdentity(ctx, options.store, repository.manifest.identities, {
    name: 'verify-target',
    args: [options.target, ...options.require.flatMap((key) => ['--require', key])],
  });
  const target = repository.manifest.targets?.[options.target];

  if (!target) {
    const payload = {
      ok: false,
      target: options.target,
      error: 'target_not_found',
      availableTargets: Object.keys(repository.manifest.targets ?? {}).sort(),
    };
    if (options.json) {
      writeJsonError(ctx, 'verify-target', {
        code: 'TARGET_NOT_FOUND',
        message: `Target not found: ${options.target}`,
        rejectedInput: options.target,
        suggestion: payload.availableTargets.length > 0
          ? `Choose one of: ${payload.availableTargets.join(', ')}`
          : 'Create a target with `hush target add`.',
        details: payload,
      });
    } else {
      ctx.logger.error(`Target not found: ${options.target}`);
      ctx.logger.error(pc.dim(`Available targets: ${payload.availableTargets.join(', ') || '(none)'}`));
      if (options.store.mode !== 'global') {
        const hint = globalStoreHint(options.target, 'target', options.store.root);
        if (hint) {
          ctx.logger.warn(pc.yellow(`\nHint: ${hint}`));
        }
      }
    }
    ctx.process.exit(1);
  }

  try {
    const resolution = resolveV3Target(ctx, {
      store: options.store,
      repository,
      targetName: options.target,
      command: { name: 'verify-target', args: [options.target] },
      machineLocal: 'include',
    });
    const allNodes = { ...resolution.values, ...resolution.artifacts };
    const resolvedKeys = getResolvedKeyMap(allNodes);
    const missing = options.require.filter((key) => !resolvedKeys.has(key));
    const payload = {
      ok: missing.length === 0,
      target: resolution.target,
      bundle: resolution.bundle,
      identity: resolution.identity,
      files: resolution.files,
      resolvedLogicalPaths: Object.keys(allNodes).sort(),
      resolvedKeys: Object.fromEntries(Array.from(resolvedKeys.entries()).sort(([left], [right]) => left.localeCompare(right))),
      required: options.require,
      missing,
      conflicts: resolution.conflicts,
    };

    appendAuditEvent(ctx, options.store, {
      type: 'read_attempt',
      activeIdentity: identity,
      success: payload.ok,
      command: { name: 'verify-target', args: [options.target] },
      files: resolution.files,
      logicalPaths: payload.resolvedLogicalPaths,
      bundle: resolution.bundle,
      target: resolution.target,
      details: {
        required: options.require,
        missing,
      },
    });

    if (options.json) {
      if (payload.ok) {
        writeJsonSuccess(ctx, 'verify-target', payload);
      } else {
        writeJsonError(ctx, 'verify-target', {
          code: 'REQUIRED_KEYS_MISSING',
          message: `Target ${resolution.target} is missing ${missing.length} required key${missing.length === 1 ? '' : 's'}.`,
          rejectedInput: missing.join(','),
          suggestion: 'Run `hush trace <KEY> --json` for each missing key.',
          details: payload,
        });
      }
    } else {
      const lines = [
        pc.blue('Hush verify-target\n'),
        `Target: ${pc.cyan(resolution.target)}`,
        `Bundle: ${pc.cyan(resolution.bundle)}`,
        `Active identity: ${pc.green(resolution.identity)}`,
        `Resolved files: ${pc.cyan(String(resolution.files.length))}`,
        `Resolved keys: ${pc.cyan(String(resolvedKeys.size))}`,
      ];

      if (options.require.length > 0) {
        lines.push('');
        lines.push('Required keys:');
        for (const key of options.require) {
          const paths = resolvedKeys.get(key);
          if (paths) {
            lines.push(`  ${pc.green('✓')} ${key} ${pc.dim(paths.join(', '))}`);
          } else {
            lines.push(`  ${pc.red('✗')} ${key} ${pc.dim('missing from selected target bundle')}`);
          }
        }
      }

      lines.push('');
      lines.push(payload.ok ? pc.green('Target verification passed.') : pc.red('Target verification failed.'));
      if (missing.length > 0) {
        lines.push(pc.yellow('Run hush trace <KEY> to see whether each missing key exists in another file or bundle.'));
      }
      ctx.logger.log(lines.join('\n'));
    }

    if (!payload.ok) {
      ctx.process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Process exit:')) {
      throw error;
    }
    const unreadableFiles = message.includes('requires unreadable file') ? extractUnreadableFilePaths(message) : [];
    const payload = {
      ok: false,
      target: options.target,
      error: error instanceof HushResolutionConflictError ? 'conflict' : unreadableFiles.length > 0 ? 'acl_denied' : 'resolution_failed',
      message,
      conflicts: error instanceof HushResolutionConflictError ? error.conflicts : [],
      unreadableFiles: unreadableFiles.map((filePath) => ({
        path: filePath,
        readers: repository.filesByPath[filePath]?.readers,
      })),
    };

    if (options.json) {
      writeJsonError(ctx, 'verify-target', {
        code: payload.error.toUpperCase(),
        message,
        rejectedInput: options.target,
        suggestion: payload.error === 'acl_denied'
          ? 'Inspect file readers with `hush file list --json`.'
          : 'Run `hush trace <KEY> --json` or `hush doctor --json` for more detail.',
        details: payload,
      });
    } else {
      ctx.logger.error(pc.red(message));
      if (payload.unreadableFiles.length > 0) {
        ctx.logger.error('Unreadable files:');
        for (const file of payload.unreadableFiles) {
          ctx.logger.error(`  ${pc.yellow(file.path)}${file.readers ? ` ${pc.dim(`(${formatReaders(file.readers)})`)}` : ''}`);
        }
      }
    }

    ctx.process.exit(1);
  }
}
