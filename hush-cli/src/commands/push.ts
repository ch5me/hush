import pc from 'picocolors';
import { withMaterializedTarget } from '../index.js';
import {
  appendCommandReadAudit,
  requireV3Repository,
  resolveTargetDeploymentContext,
  resolveTargetEnvView,
} from './v3-command-helpers.js';
import type {
  EnvVar,
  HushContext,
  HushTargetDefinition,
  HushV3Repository,
  PushOptions,
  StoreContext,
  VercelEnvironment,
  VercelPushConfig,
} from '../types.js';
import type { V3ResolvedEnvView } from './v3-command-helpers.js';

type PushDestination = 'cloudflare' | 'vercel';
type VercelSecretType = 'sensitive' | 'encrypted';

interface ConfiguredPushTarget {
  targetName: string;
  target: HushTargetDefinition;
  destination: PushDestination;
}

interface VercelPushFailure {
  key: string;
  type: VercelSecretType;
  target: VercelEnvironment[];
  error: string;
}

interface VercelPushResult {
  success: number;
  failed: VercelPushFailure[];
  skipped: boolean;
}

interface PushVercelSecretsOptions {
  envView: Pick<V3ResolvedEnvView, 'env' | 'resolution'>;
  config: VercelPushConfig;
  token?: string;
  dryRun: boolean;
}

const DEFAULT_VERCEL_ENVIRONMENTS: VercelEnvironment[] = ['production', 'preview', 'development'];

class VercelPushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VercelPushError';
  }
}

function pushWorkerSecret(
  ctx: HushContext,
  key: string,
  value: string,
  targetDir: string,
  pushMode: 'workers' | 'pages',
  pagesProject: string | undefined,
  dryRun: boolean,
  verbose: boolean,
  wranglerEnv?: string,
): boolean {
  if (dryRun) {
    const envLabel = wranglerEnv ? ` (--env ${wranglerEnv})` : '';
    ctx.logger.log(verbose ? pc.green(`    + ${key}${envLabel}`) : pc.dim(`    [dry-run] ${key}${envLabel}`));
    return true;
  }

  try {
    const envArgs: string[] = wranglerEnv ? ['--env', wranglerEnv] : [];
    const wranglerArgs = pushMode === 'pages'
      ? ['pages', 'secret', 'put', key, '--project-name', pagesProject ?? '', ...envArgs]
      : ['secret', 'put', key, ...envArgs];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function logicalPathToEnvKey(path: string): string {
  const segments = path.split('/').filter(Boolean);
  const key = segments.at(-1);

  if (!key) {
    throw new Error(`Cannot derive environment key from logical path "${path}"`);
  }

  return key;
}

function describeVercelPush(type: VercelSecretType, target: readonly VercelEnvironment[]): string {
  return `${type} -> ${target.join(',')}`;
}

function buildVercelSensitivityMap(envView: Pick<V3ResolvedEnvView, 'resolution'>): Map<string, boolean> {
  const sensitivityByKey = new Map<string, boolean>();

  for (const [logicalPath, node] of Object.entries(envView.resolution.values)) {
    sensitivityByKey.set(logicalPathToEnvKey(logicalPath), node.entry.sensitive);
  }

  return sensitivityByKey;
}

function collectVercelEnvPairs(envView: Pick<V3ResolvedEnvView, 'env' | 'resolution'>): Array<{
  key: string;
  value: string;
  type: VercelSecretType;
}> {
  const sensitivityByKey = buildVercelSensitivityMap(envView);

  return Object.entries(envView.env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({
      key,
      value,
      // Local overrides are always sensitive. Unknown keys default to sensitive so
      // projection stays write-only instead of accidentally downgrading exposure.
      type: sensitivityByKey.get(key) === false ? 'encrypted' : 'sensitive',
    }));
}

async function parseResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractVercelErrorMessage(response: Response, body: unknown): string {
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.message === 'string') {
      return error.message;
    }

    if (typeof body.message === 'string') {
      return body.message;
    }
  }

  return response.statusText || `HTTP ${response.status}`;
}

function buildVercelUrl(config: Pick<VercelPushConfig, 'projectId' | 'teamId'>): string {
  const params = new URLSearchParams({ upsert: 'true' });
  if (config.teamId) {
    params.set('teamId', config.teamId);
  }

  return `https://api.vercel.com/v10/projects/${encodeURIComponent(config.projectId)}/env?${params.toString()}`;
}

function resolveVercelToken(ctx: HushContext, envView: Pick<V3ResolvedEnvView, 'env'>, config: Pick<VercelPushConfig, 'token' | 'projectId'>, explicitToken?: string): string {
  const token = config.token?.trim()
    || explicitToken?.trim()
    || envView.env.VERCEL_TOKEN?.trim()
    || ctx.process.env.VERCEL_TOKEN?.trim()
    || '';

  if (!config.projectId.trim()) {
    throw new VercelPushError('Vercel push requires a projectId. Configure push_to.projectId or pass --project.');
  }

  if (!token) {
    throw new VercelPushError('Vercel push requires VERCEL_TOKEN. Configure push_to.token, add VERCEL_TOKEN to the target, or export VERCEL_TOKEN in the process environment.');
  }

  return token;
}

function buildConfiguredTargets(
  store: StoreContext,
  repository: HushV3Repository,
  requestedTarget?: string,
): ConfiguredPushTarget[] {
  const targets: ConfiguredPushTarget[] = [];

  for (const [targetName, target] of Object.entries(repository.manifest.targets ?? {})) {
    if (target.mode === 'example') {
      continue;
    }

      const deployment = resolveTargetDeploymentContext(store, repository, targetName);

      if (deployment.pushTo?.type === 'vercel' || target.format === 'vercel') {
        targets.push({ targetName, target, destination: 'vercel' });
        continue;
      }

      if (target.format === 'wrangler') {
        targets.push({ targetName, target, destination: 'cloudflare' });
      }
  }

  targets.sort((left, right) => left.targetName.localeCompare(right.targetName));

  if (requestedTarget) {
    const match = targets.find((target) => target.targetName === requestedTarget);
    if (!match) {
      throw new Error(
        `Target "${requestedTarget}" is not pushable in v3. Available push targets: ${targets.map((target) => target.targetName).join(', ') || '(none)'}`,
      );
    }
    return [match];
  }

  return targets;
}

function toEnvPairs(env: Record<string, string>): EnvVar[] {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }));
}

function buildCommandArgs(options: PushOptions): string[] {
  const args: string[] = [];

  if (options.target) {
    args.push('--target', options.target);
  }
  if (options.vercel) {
    args.push('--vercel');
  }
  if (options.project) {
    args.push('--project', options.project);
  }
  if (options.team) {
    args.push('--team', options.team);
  }
  if (options.environments && options.environments.length > 0) {
    for (const environment of options.environments) {
      args.push('--environment', environment);
    }
  }
  if (options.wranglerEnv) {
    args.push('--wrangler-env', options.wranglerEnv);
  }
  if (options.dryRun) {
    args.push('--dry-run');
  }
  if (options.verbose) {
    args.push('--verbose');
  }

  return args;
}

function buildVercelConfig(
  options: Pick<PushOptions, 'project' | 'team' | 'environments'>,
  configured?: VercelPushConfig,
): VercelPushConfig {
  return {
    type: 'vercel',
    token: configured?.token,
    teamId: options.team ?? configured?.teamId,
    projectId: options.project ?? configured?.projectId ?? '',
    environments: options.environments && options.environments.length > 0
      ? Array.from(new Set(options.environments))
      : configured?.environments?.length
        ? configured.environments
        : DEFAULT_VERCEL_ENVIRONMENTS,
  };
}

export async function pushVercelSecrets(
  ctx: HushContext,
  { envView, config, token, dryRun }: PushVercelSecretsOptions,
): Promise<VercelPushResult> {
  const envPairs = collectVercelEnvPairs(envView);

  if (envPairs.length === 0) {
    return { success: 0, failed: [], skipped: true };
  }

  const resolvedToken = resolveVercelToken(ctx, envView, config, token);

  if (dryRun) {
    for (const pair of envPairs) {
      ctx.logger.log(pc.dim(`    [dry-run] ${pair.key} (${describeVercelPush(pair.type, config.environments)})`));
    }
    return { success: envPairs.length, failed: [], skipped: false };
  }

  const fetchImpl = ctx.network?.fetch ?? fetch;
  const url = buildVercelUrl(config);
  const failed: VercelPushFailure[] = [];
  let success = 0;

  for (const pair of envPairs) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resolvedToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          key: pair.key,
          value: pair.value,
          type: pair.type,
          target: config.environments,
        }),
      });
      const body = await parseResponseBody(response);

      if (!response.ok) {
        const error = `HTTP ${response.status} ${extractVercelErrorMessage(response, body)}`;
        failed.push({
          key: pair.key,
          type: pair.type,
          target: config.environments,
          error,
        });
        ctx.logger.error(pc.red(`    Failed: ${pair.key} (${describeVercelPush(pair.type, config.environments)}) - ${error}`));
        continue;
      }

      ctx.logger.log(pc.green(`    ${pair.key} (${describeVercelPush(pair.type, config.environments)})`));
      success++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({
        key: pair.key,
        type: pair.type,
        target: config.environments,
        error: message,
      });
      ctx.logger.error(pc.red(`    Failed: ${pair.key} (${describeVercelPush(pair.type, config.environments)}) - ${message}`));
    }
  }

  return { success, failed, skipped: false };
}

async function pushConfiguredVercelTarget(
  ctx: HushContext,
  options: PushOptions,
  repository: HushV3Repository,
  targetName: string,
): Promise<void> {
  const envView = resolveTargetEnvView(ctx, options.store, targetName, {
    name: 'push',
    args: buildCommandArgs(options),
  });
  appendCommandReadAudit(ctx, options.store, envView, {
    name: 'push',
    args: buildCommandArgs(options),
  });

  const deployment = resolveTargetDeploymentContext(options.store, repository, targetName);
  const configuredPush = deployment.pushTo?.type === 'vercel' ? deployment.pushTo : undefined;
  const config = buildVercelConfig(options, configuredPush);

  ctx.logger.log(options.dryRun && options.verbose
    ? pc.blue(`\n[DRY RUN] Would push ${targetName}:`)
    : pc.blue(`\n${targetName}`));

  const result = await pushVercelSecrets(ctx, {
    envView,
    config,
    dryRun: options.dryRun,
  });

  if (result.skipped) {
    ctx.logger.log(pc.dim(`\n${targetName} - no matching env values, skipped`));
    return;
  }

  ctx.logger.log(pc.dim(`  ${result.success} pushed, ${result.failed.length} failed`));
}

function pushConfiguredCloudflareTarget(
  ctx: HushContext,
  options: PushOptions,
  repository: HushV3Repository,
  targetName: string,
): void {
  const result = withMaterializedTarget(ctx, {
    store: options.store,
    repository,
    targetName,
    command: { name: 'push', args: buildCommandArgs(options) },
    mode: 'memory',
    machineLocal: 'include',
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
      if (pushWorkerSecret(ctx, key, value, deployment.cwd, pushMode, pagesProject, options.dryRun, options.verbose, options.wranglerEnv)) {
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
    return;
  }

  ctx.logger.log(pc.dim(`  ${result.success} pushed, ${result.failed} failed`));
}

async function pushExplicitVercelTarget(ctx: HushContext, options: PushOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'push');
  const envView = resolveTargetEnvView(ctx, options.store, options.target, {
    name: 'push',
    args: buildCommandArgs(options),
  });
  appendCommandReadAudit(ctx, options.store, envView, {
    name: 'push',
    args: buildCommandArgs(options),
  });

  const deployment = resolveTargetDeploymentContext(options.store, repository, envView.targetName);
  const configuredPush = deployment.pushTo?.type === 'vercel' ? deployment.pushTo : undefined;
  const config = buildVercelConfig(options, configuredPush);

  ctx.logger.log(pc.blue('Pushing secrets to Vercel...'));
  if (options.dryRun) {
    ctx.logger.log(pc.yellow('(dry-run mode)'));
  }

  ctx.logger.log(options.dryRun && options.verbose
    ? pc.blue(`\n[DRY RUN] Would push ${envView.targetName}:`)
    : pc.blue(`\n${envView.targetName}`));

  const result = await pushVercelSecrets(ctx, {
    envView,
    config,
    dryRun: options.dryRun,
  });

  if (result.skipped) {
    ctx.logger.log(pc.dim(`\n${envView.targetName} - no matching env values, skipped`));
  } else {
    ctx.logger.log(pc.dim(`  ${result.success} pushed, ${result.failed.length} failed`));
  }

  ctx.logger.log(options.dryRun ? pc.yellow('\n[dry-run] No secrets were pushed') : pc.green('\nPush complete'));
}

export async function pushCommand(ctx: HushContext, options: PushOptions): Promise<void> {
  if (options.vercel) {
    try {
      await pushExplicitVercelTarget(ctx, options);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error(pc.red(message));
      ctx.process.exit(1);
    }
  }

  const repository = requireV3Repository(options.store, 'push');
  const pushableTargets = buildConfiguredTargets(options.store, repository, options.target);

  if (pushableTargets.length === 0) {
    ctx.logger.error(pc.red('No pushable targets found. Add a wrangler-formatted target or a Vercel push target.'));
    ctx.process.exit(1);
  }

  ctx.logger.log(pc.blue('Pushing secrets to configured destinations...'));
  if (options.dryRun) {
    ctx.logger.log(pc.yellow('(dry-run mode)'));
  }

  for (const pushTarget of pushableTargets) {
    try {
      if (pushTarget.destination === 'vercel') {
        await pushConfiguredVercelTarget(ctx, options, repository, pushTarget.targetName);
      } else {
        pushConfiguredCloudflareTarget(ctx, options, repository, pushTarget.targetName);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error(pc.red(message));
      ctx.process.exit(1);
    }
  }

  ctx.logger.log(options.dryRun ? pc.yellow('\n[dry-run] No secrets were pushed') : pc.green('\nPush complete'));
}
