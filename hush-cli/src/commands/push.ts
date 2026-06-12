import pc from 'picocolors';
import { withMaterializedTarget } from '../index.js';
import { requireV3Repository, resolveTargetDeploymentContext } from './v3-command-helpers.js';
import type { EnvVar, HushContext, PushOptions } from '../types.js';

function pushWorkerSecret(
  ctx: HushContext,
  key: string,
  value: string,
  targetDir: string,
  pushMode: 'workers' | 'pages',
  pagesProject: string | undefined,
  dryRun: boolean,
  verbose: boolean,
): boolean {
  if (dryRun) {
    ctx.logger.log(verbose ? pc.green(`    + ${key}`) : pc.dim(`    [dry-run] ${key}`));
    return true;
  }

  try {
    const wranglerArgs = pushMode === 'pages'
      ? ['pages', 'secret', 'put', key, '--project-name', pagesProject ?? '']
      : ['secret', 'put', key];
    const result = ctx.exec.spawnSync('wrangler', wranglerArgs, {
      cwd: targetDir,
      input: value,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      const stderr = typeof result.stderr === 'string' ? result.stderr : result.stderr.toString('utf-8');
      throw new Error(stderr || `wrangler secret put exited with code ${result.status}`);
    }

    return true;
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    ctx.logger.error(pc.red(`    Failed: ${key} - ${err.stderr || err.message}`));
    return false;
  }
}

function getPushableTargetNames(repository: ReturnType<typeof requireV3Repository>, requestedTarget?: string): string[] {
  const targets = Object.entries(repository.manifest.targets ?? {})
    .filter(([, target]) => target.format === 'wrangler' && target.mode !== 'example')
    .map(([name]) => name)
    .sort();

  if (requestedTarget) {
    if (!targets.includes(requestedTarget)) {
      throw new Error(
        `Target "${requestedTarget}" is not pushable in v3. Available wrangler targets: ${targets.join(', ') || '(none)'}`,
      );
    }
    return [requestedTarget];
  }

  return targets;
}

function toEnvPairs(env: Record<string, string>): EnvVar[] {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }));
}

export async function pushCommand(ctx: HushContext, options: PushOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'push');
  const pushableTargets = getPushableTargetNames(repository, options.target);

  if (pushableTargets.length === 0) {
    ctx.logger.error(pc.red('No pushable targets found. Add a wrangler-formatted target with `hush target add`.'));
    ctx.process.exit(1);
  }

  ctx.logger.log(pc.blue('Pushing secrets to Cloudflare Workers...'));
  if (options.dryRun) {
    ctx.logger.log(pc.yellow('(dry-run mode)'));
  }

  for (const targetName of pushableTargets) {
    try {
      const result = withMaterializedTarget(ctx, {
        store: options.store,
        repository,
        targetName,
        command: { name: 'push', args: options.target ? [targetName] : [] },
        mode: 'memory',
      }, (materialization) => {
        const envPairs = toEnvPairs(materialization.env);
        const deployment = resolveTargetDeploymentContext(options.store, repository, targetName);
        const pushMode = deployment.pushTo?.type === 'cloudflare-pages' ? 'pages' : 'workers';
        const pagesProject = deployment.pushTo?.type === 'cloudflare-pages' ? deployment.pushTo.project : undefined;

        if (envPairs.length === 0) {
          return { success: 0, failed: 0, skipped: true };
        }

        ctx.logger.log(options.dryRun && options.verbose
          ? pc.blue(`\n[DRY RUN] Would push ${targetName}:`)
          : pc.blue(`\n${targetName}`));

        let success = 0;
        let failed = 0;

        for (const { key, value } of envPairs) {
          if (pushWorkerSecret(ctx, key, value, deployment.cwd, pushMode, pagesProject, options.dryRun, options.verbose)) {
            if (!options.dryRun) {
              ctx.logger.log(pc.green(`    ${key}`));
            }
            success++;
          } else {
            failed++;
          }
        }

        return { success, failed, skipped: false };
      });

      if (result.skipped) {
        ctx.logger.log(pc.dim(`\n${targetName} - no matching env values, skipped`));
        continue;
      }

      ctx.logger.log(pc.dim(`  ${result.success} pushed, ${result.failed} failed`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error(pc.red(message));
      ctx.process.exit(1);
    }
  }

  ctx.logger.log(options.dryRun ? pc.yellow('\n[dry-run] No secrets were pushed') : pc.green('\nPush complete'));
}
