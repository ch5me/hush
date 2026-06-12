import pc from 'picocolors';
import { findProjectRoot, isV3RepositoryRoot } from '../config/loader.js';
import { getActiveIdentity } from '../v3/identity.js';
import { loadV3Repository } from '../v3/repository.js';
import { getProjectStatePaths } from '../v3/state.js';
import type { HushContext, StatusOptions } from '../types.js';

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

    ctx.logger.log(pc.blue('Hush status\n'));
    ctx.logger.log(`Repository: ${pc.cyan(isV3RepositoryRoot(options.store.root) ? 'ready' : projectInfo?.repositoryKind ?? 'missing')}`);
    ctx.logger.log(`Root: ${pc.dim(projectInfo?.projectRoot ?? options.store.root)}`);
    ctx.logger.log(`Store: ${pc.cyan(options.store.mode)} ${pc.dim(`(${options.store.displayLabel})`)}`);

    if (!isV3RepositoryRoot(options.store.root)) {
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
    ctx.logger.log('');
    ctx.logger.log('Machine-local state:');
    ctx.logger.log(`  project slug: ${pc.cyan(statePaths.projectSlug)}`);
    ctx.logger.log(`  state root: ${pc.dim(statePaths.projectRoot)}`);
    ctx.logger.log(`  active identity path: ${pc.dim(statePaths.activeIdentityPath)} ${pc.dim(`(${formatStateHealth(ctx, statePaths.activeIdentityPath)})`)}`);
    ctx.logger.log(`  audit log path: ${pc.dim(statePaths.auditLogPath)} ${pc.dim(`(${formatStateHealth(ctx, statePaths.auditLogPath)})`)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.log(pc.blue('Hush status\n'));
    ctx.logger.log(`Repository: ${pc.yellow('missing')}`);
    ctx.logger.log(`Root: ${pc.dim(options.store.root)}`);
    ctx.logger.log(`Store: ${pc.cyan(options.store.mode)} ${pc.dim(`(${options.store.displayLabel})`)}`);
    ctx.logger.log('');
    ctx.logger.log(pc.yellow(message));
    ctx.logger.log(pc.dim('Bootstrap a repository with "hush bootstrap" to enable diagnostics.'));
  }
}
