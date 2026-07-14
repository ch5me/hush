import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import pc from 'picocolors';
import { findProjectRoot, isV3RepositoryRoot } from '../config/loader.js';
import { GLOBAL_STORE_ROOT } from '../store.js';
import { getActiveIdentity } from '../v3/identity.js';
import { loadV3Repository } from '../v3/repository.js';
import { getProjectStatePaths } from '../v3/state.js';
import type { HushContext, StatusOptions } from '../types.js';
import { writeJsonError, writeJsonSuccess } from '../lib/command-output.js';

/**
 * Peek at the global store manifest for target/bundle counts.
 * Read-only, names-only (SOPS YAML outer keys), never decrypts values, never throws.
 */
function peekGlobalStoreCounts(globalRoot: string): { targetCount: number; bundleCount: number } | undefined {
  const manifestPath = join(globalRoot, '.hush', 'manifest.encrypted');
  if (!existsSync(manifestPath)) return undefined;
  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return { targetCount: 0, bundleCount: 0 };
    const targets = parsed.targets;
    const bundles = parsed.bundles;
    return {
      targetCount: targets && typeof targets === 'object' && !Array.isArray(targets)
        ? Object.keys(targets as Record<string, unknown>).length : 0,
      bundleCount: bundles && typeof bundles === 'object' && !Array.isArray(bundles)
        ? Object.keys(bundles as Record<string, unknown>).length : 0,
    };
  } catch {
    return { targetCount: 0, bundleCount: 0 };
  }
}

function formatStateHealth(ctx: HushContext, path: string): string {
  return ctx.fs.existsSync(path) ? pc.green('present') : pc.yellow('missing');
}

function formatCount(label: string, value: number): string {
  return `  ${label}: ${pc.cyan(String(value))}`;
}

function formatText(label: string, value: string): string {
  return `  ${label}: ${pc.cyan(value)}`;
}

export async function statusCommand(ctx: HushContext, options: StatusOptions): Promise<void> {
  const statePaths = getProjectStatePaths(options.store);

  try {
    const projectInfo = findProjectRoot(options.store.root);
    const repositoryStatus = isV3RepositoryRoot(options.store.root) ? 'ready' : (projectInfo?.repositoryKind ?? 'missing');

    if (!isV3RepositoryRoot(options.store.root)) {
      if (options.json) {
        writeJsonSuccess(ctx, 'status', {
          repository: repositoryStatus,
          root: projectInfo?.projectRoot ?? options.store.root,
          store: options.store.mode,
          storeLabel: options.store.displayLabel,
        });
        return;
      }

      ctx.logger.log(pc.blue('Hush status\n'));
      ctx.logger.log(`Repository: ${pc.cyan(repositoryStatus)}`);
      ctx.logger.log(`Root: ${pc.dim(projectInfo?.projectRoot ?? options.store.root)}`);
      ctx.logger.log(`Store: ${pc.cyan(options.store.mode)} ${pc.dim(`(${options.store.displayLabel})`)}`);
      if (projectInfo?.repositoryKind === 'legacy-v2' && projectInfo.configPath) {
        ctx.logger.log(`Config: ${pc.dim(projectInfo.configPath)}`);
      }
      ctx.logger.log(pc.yellow('\nThis repo still uses legacy hush.yaml runtime authority.'));
      ctx.logger.log(pc.dim('Migrate with "hush migrate --from v2" before relying on normal command flows.'));
      return;
    }

    const authority = loadV3Repository(options.store.root, { keyIdentity: options.store.keyIdentity });

    const activeIdentity = getActiveIdentity(ctx, options.store);
    const manifestCount = 1;
    const fileCount = authority.files.length;
    const identityCount = Object.keys(authority.manifest.identities).length;
    const bundleCount = Object.keys(authority.manifest.bundles ?? {}).length;
    const targetCount = Object.keys(authority.manifest.targets ?? {}).length;
    const importCount = Object.keys(authority.manifest.imports ?? {}).length;

    // Global store topology: best-effort peek (names only, never decrypts, never throws).
    const globalCounts = options.store.mode !== 'global'
      ? peekGlobalStoreCounts(GLOBAL_STORE_ROOT)
      : null;
    const home = process.env.HOME ?? '';
    const globalDisplayPath = home ? `~/.hush` : GLOBAL_STORE_ROOT;
    const globalExists = existsSync(join(GLOBAL_STORE_ROOT, '.hush', 'manifest.encrypted'));

    if (options.json) {
      writeJsonSuccess(ctx, 'status', {
        repository: repositoryStatus,
        root: projectInfo?.projectRoot ?? options.store.root,
        store: options.store.mode,
        storeLabel: options.store.displayLabel,
        manifestPath: authority.manifestPath,
        filesRoot: authority.filesRoot,
        activeIdentity: activeIdentity ?? null,
        counts: {
          manifestFiles: manifestCount,
          encryptedFiles: fileCount,
          identities: identityCount,
          bundles: bundleCount,
          targets: targetCount,
          imports: importCount,
        },
        machineLocal: {
          projectSlug: statePaths.projectSlug,
          stateRoot: statePaths.projectRoot,
          activeIdentityPath: statePaths.activeIdentityPath,
          activeIdentityPresent: ctx.fs.existsSync(statePaths.activeIdentityPath),
          auditLogPath: statePaths.auditLogPath,
          auditLogPresent: ctx.fs.existsSync(statePaths.auditLogPath),
        },
        globalStore: globalCounts !== null
          ? {
            path: globalDisplayPath,
            exists: globalExists,
            targetCount: globalCounts?.targetCount ?? 0,
            bundleCount: globalCounts?.bundleCount ?? 0,
            autoInherited: false,
          }
          : null,
      });
      return;
    }

    ctx.logger.log(pc.blue('Hush status\n'));
    ctx.logger.log(`Repository: ${pc.cyan(repositoryStatus)}`);
    ctx.logger.log(`Root: ${pc.dim(projectInfo?.projectRoot ?? options.store.root)}`);
    ctx.logger.log(`Store: ${pc.cyan(options.store.mode)} ${pc.dim(`(${options.store.displayLabel})`)}`);
    ctx.logger.log(`Manifest: ${pc.dim(authority.manifestPath)}`);
    ctx.logger.log(`Files root: ${pc.dim(authority.filesRoot)}`);
    ctx.logger.log(`Active identity: ${activeIdentity ? pc.green(activeIdentity) : pc.yellow('(not set)')}`);
    ctx.logger.log('');
    ctx.logger.log('Repository state:');
    ctx.logger.log(formatText('kind', authority.kind));
    ctx.logger.log(formatCount('manifest files', manifestCount));
    ctx.logger.log(formatCount('encrypted files', fileCount));
    ctx.logger.log(formatCount('identities', identityCount));
    ctx.logger.log(formatCount('bundles', bundleCount));
    ctx.logger.log(formatCount('targets', targetCount));
    ctx.logger.log(formatCount('imports', importCount));

    // Two-store topology note (only when in project mode).
    if (globalCounts !== null) {
      ctx.logger.log('');
      ctx.logger.log('Global store:');
      if (globalExists && globalCounts) {
        ctx.logger.log(`  ${globalDisplayPath}: ${pc.cyan(`${globalCounts.targetCount} target(s), ${globalCounts.bundleCount} bundle(s)`)}`);
      } else {
        ctx.logger.log(`  ${globalDisplayPath}: ${pc.dim('(not present)')}`);
      }
      ctx.logger.log(pc.dim(`  Not auto-inherited — compose via \`hush import add --source-root ${globalDisplayPath}\` or use \`hush --root ${globalDisplayPath} <cmd>\` for one-off access.`));
    }

    ctx.logger.log('');
    ctx.logger.log('Machine-local state:');
    ctx.logger.log(`  project slug: ${pc.cyan(statePaths.projectSlug)}`);
    ctx.logger.log(`  state root: ${pc.dim(statePaths.projectRoot)}`);
    ctx.logger.log(`  active identity path: ${pc.dim(statePaths.activeIdentityPath)} ${pc.dim(`(${formatStateHealth(ctx, statePaths.activeIdentityPath)})`)}`);
    ctx.logger.log(`  audit log path: ${pc.dim(statePaths.auditLogPath)} ${pc.dim(`(${formatStateHealth(ctx, statePaths.auditLogPath)})`)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (options.json) {
      writeJsonError(ctx, 'status', {
        code: 'REPOSITORY_UNAVAILABLE',
        message,
        details: {
          repository: 'missing',
          root: options.store.root,
          store: options.store.mode,
          storeLabel: options.store.displayLabel,
        },
        suggestion: 'Run `hush bootstrap` to initialize this repository.',
      });
      return;
    }

    ctx.logger.log(pc.blue('Hush status\n'));
    ctx.logger.log(`Repository: ${pc.yellow('missing')}`);
    ctx.logger.log(`Root: ${pc.dim(options.store.root)}`);
    ctx.logger.log(`Store: ${pc.cyan(options.store.mode)} ${pc.dim(`(${options.store.displayLabel})`)}`);
    ctx.logger.log('');
    ctx.logger.log(pc.yellow(message));
    ctx.logger.log(pc.dim('Bootstrap a repository with "hush bootstrap" to enable diagnostics.'));
  }
}
