import { isAbsolute, relative, resolve } from 'node:path';
import pc from 'picocolors';
import { resolveTargetEnvView } from './v3-command-helpers.js';
import type { HushContext, ProjectOptions, StoreContext } from '../types.js';
import type { V3ResolvedEnvView } from './v3-command-helpers.js';

type ProjectMode = ProjectOptions['subcommand'];

interface ProjectRequirement {
  name: string;
  delivery: 'secret' | 'variable';
  requiredIn?: string[];
  topologyTargets?: string[];
  derivedFrom?: string;
}

interface ProjectProviderValidator {
  provider: string;
  key: string;
  fromEmail?: string;
}

interface ProjectSurfaceConfig {
  runtimeSurface: string;
  topologyTarget: string;
  wranglerDir: string;
  hushTargets: Record<string, string | undefined>;
  wranglerEnvs?: Record<string, string | null | undefined>;
  deploySecrets?: string[];
  variables?: Record<string, Record<string, string | undefined>>;
  providerValidators?: ProjectProviderValidator[];
  wranglerCommand?: string[];
}

interface ProjectConfigFile {
  contract: string;
  environmentTargets: string;
  surfaces: Record<string, ProjectSurfaceConfig>;
}

interface ProjectHushTargetCheck {
  ok: boolean;
  target: string;
  required: string[];
  missing: string[];
  resolvedKeys: string[];
  error?: string;
}

interface ProjectVarCheck {
  key: string;
  ok: boolean;
  source: string;
  expected: string | null;
  actual: string | null;
}

interface ProjectWranglerVarCheck {
  ok: boolean;
  vars: ProjectVarCheck[];
  missing: string[];
  mismatched: string[];
  actualValues: Record<string, string>;
}

interface ProjectWorkerSecretCheck {
  ok: boolean;
  secretNames: string[];
  missing: string[];
  error?: string;
  skipped?: boolean;
}

interface ProjectProviderCheck {
  provider: string;
  key: string;
  ok: boolean;
  error?: string;
  fromDomain?: string | null;
  fromDomainStatus?: string;
}

interface ProjectProviderSummary {
  ok: boolean;
  checks: ProjectProviderCheck[];
  skipped?: boolean;
}

interface ProjectSyncResult {
  ok: boolean;
  dryRun: boolean;
  synced: Array<{ key: string; dryRun?: boolean }>;
  failed: Array<{ key: string; error: string }>;
}

interface ProjectRuntimeContext {
  configPath: string;
  configPathDisplay: string;
  config: ProjectConfigFile;
  surface: ProjectSurfaceConfig;
  surfaceName: string;
  stage: string;
  environmentTarget: Record<string, unknown>;
  hushTarget: string;
  wranglerEnv: string | null;
  deployKeys: string[];
  runtimeSecretKeys: string[];
  variableRequirements: ProjectRequirement[];
  requiredHushKeys: string[];
  wranglerDir: string;
  wranglerCommand: string[];
}

interface ProjectPayload {
  status: 'ok' | 'drift';
  mode: ProjectMode;
  environment: string;
  surface: string;
  configPath: string;
  hushTarget: string;
  contract: {
    deploySecrets: string[];
    runtimeSecrets: string[];
    runtimeVariables: string[];
  };
  checks: {
    hushTarget: ProjectHushTargetCheck;
    wranglerVars: ProjectWranglerVarCheck;
    workerSecrets: ProjectWorkerSecretCheck | { ok: true; skipped: true } | null;
    providers: ProjectProviderSummary | { ok: true; skipped: true } | null;
    sync: ProjectSyncResult | null;
  };
  actions: Array<{
    kind: 'cloudflare-secret-put';
    key: string;
    source: string;
    target: string;
    reason: 'missing-remote' | 'sync-requested' | 'ensure-in-sync';
  }>;
}

const DEFAULT_CONFIG_CANDIDATES = [
  'hush-project-env.json',
  '.hush/project-env.json',
  'config/hush-project-env.json',
  'packages/runtime-config/config/hush-project-env.json',
] as const;

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toStringValue(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf-8');
}

function parseJsonObject<T>(filePath: string, content: string): T {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed as T;
}

function readJsonObject<T>(ctx: HushContext, filePath: string): T {
  const raw = ctx.fs.readFileSync(filePath, 'utf-8');
  const content = typeof raw === 'string' ? raw : raw.toString('utf-8');
  return parseJsonObject<T>(filePath, content);
}

function resolveProjectConfigPath(ctx: HushContext, store: StoreContext, explicitPath?: string): string {
  if (explicitPath) {
    return isAbsolute(explicitPath) ? explicitPath : resolve(store.root, explicitPath);
  }

  for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
    const absoluteCandidate = resolve(store.root, candidate);
    if (ctx.fs.existsSync(absoluteCandidate)) {
      return absoluteCandidate;
    }
  }

  throw new Error(
    `Could not auto-discover a Hush project config under ${store.root}. `
    + `Tried: ${DEFAULT_CONFIG_CANDIDATES.join(', ')}. Pass --config <path> explicitly.`,
  );
}

function parseStageRequirementValues(values: unknown, label: string): string[] {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return values;
}

function loadProjectRuntimeContext(ctx: HushContext, store: StoreContext, options: ProjectOptions): ProjectRuntimeContext {
  const configPath = resolveProjectConfigPath(ctx, store, options.configPath);
  const config = readJsonObject<ProjectConfigFile>(ctx, configPath);

  if (!isRecord(config.surfaces)) {
    throw new Error(`Project config ${configPath} must define a "surfaces" object`);
  }

  const surfaceName = options.surface ?? Object.keys(config.surfaces)[0] ?? '';
  if (!surfaceName) {
    throw new Error(`Project config ${configPath} does not declare any surfaces`);
  }

  const surface = config.surfaces[surfaceName];
  if (!surface) {
    throw new Error(`Unknown Hush project surface: ${surfaceName}`);
  }

  const contract = readJsonObject<Record<string, ProjectRequirement[]>>(ctx, resolve(store.root, config.contract));
  const environmentTargets = readJsonObject<Record<string, Record<string, unknown>>>(ctx, resolve(store.root, config.environmentTargets));
  const environmentTarget = environmentTargets[options.stage];

  if (!environmentTarget) {
    throw new Error(`Environment target ${options.stage} not found in ${config.environmentTargets}`);
  }

  const requirements = contract[surface.runtimeSurface];
  if (!Array.isArray(requirements)) {
    throw new Error(`Runtime surface ${surface.runtimeSurface} not found in ${config.contract}`);
  }

  const runtimeRequirements = requirements.filter((requirement) => {
    const requiredIn = parseStageRequirementValues(requirement.requiredIn, `${requirement.name}.requiredIn`);
    const topologyTargets = parseStageRequirementValues(requirement.topologyTargets, `${requirement.name}.topologyTargets`);
    return requiredIn.includes(options.stage) && topologyTargets.includes(surface.topologyTarget);
  });

  const runtimeSecretKeys = uniqueSorted(
    runtimeRequirements
      .filter((requirement) => requirement.delivery === 'secret')
      .map((requirement) => requirement.name),
  );
  const variableRequirements = runtimeRequirements
    .filter((requirement) => requirement.delivery === 'variable')
    .sort((left, right) => left.name.localeCompare(right.name));
  const deployKeys = uniqueSorted(surface.deploySecrets ?? []);
  const hushTarget = surface.hushTargets[options.stage];

  if (!hushTarget) {
    throw new Error(`No Hush target declared for ${surfaceName}/${options.stage}`);
  }

  const wranglerCommand = Array.isArray(surface.wranglerCommand) && surface.wranglerCommand.length > 0
    ? surface.wranglerCommand
    : ['pnpm', 'exec', 'wrangler'];
  if (wranglerCommand.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new Error(`surface ${surfaceName} has an invalid wranglerCommand; expected a non-empty string array`);
  }

  return {
    configPath,
    configPathDisplay: relative(store.root, configPath) || configPath,
    config,
    surface,
    surfaceName,
    stage: options.stage,
    environmentTarget,
    hushTarget,
    wranglerEnv: surface.wranglerEnvs?.[options.stage] ?? null,
    deployKeys,
    runtimeSecretKeys,
    variableRequirements,
    requiredHushKeys: uniqueSorted([...deployKeys, ...runtimeSecretKeys]),
    wranglerDir: resolve(store.root, surface.wranglerDir),
    wranglerCommand,
  };
}

function valueAtPath(source: Record<string, unknown>, dottedPath: string): string | null {
  let cursor: unknown = source;
  for (const part of dottedPath.split('.')) {
    if (!isRecord(cursor) || !(part in cursor)) {
      return null;
    }
    cursor = cursor[part];
  }
  if (typeof cursor === 'string' && cursor.length > 0) {
    return cursor;
  }
  if (Array.isArray(cursor) && cursor.length > 0 && cursor.every((value) => typeof value === 'string')) {
    return cursor.join(',');
  }
  return null;
}

function stripTomlComment(line: string): string {
  let inQuote = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== '\\') {
      inQuote = !inQuote;
    }
    if (char === '#' && !inQuote) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseTomlString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed) as string;
  }
  return trimmed;
}

function readWranglerVars(ctx: HushContext, runtime: ProjectRuntimeContext): Record<string, string> {
  const content = toStringValue(ctx.fs.readFileSync(resolve(runtime.wranglerDir, 'wrangler.toml'), 'utf8'));
  const wantedSection = runtime.stage === 'production' ? 'vars' : `env.${runtime.stage}.vars`;
  const vars: Record<string, string> = {};
  let section = '';

  for (const rawLine of content.split('\n')) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? '';
      continue;
    }

    if (section !== wantedSection || !line.includes('=')) {
      continue;
    }

    const [name, ...rest] = line.split('=');
    const key = name?.trim();
    if (!key) {
      continue;
    }
    vars[key] = parseTomlString(rest.join('=').trim());
  }

  return vars;
}

function expectedVariableValue(runtime: ProjectRuntimeContext, requirement: ProjectRequirement): string | null {
  const configured = runtime.surface.variables?.[requirement.name]?.[runtime.stage];
  if (typeof configured === 'string') {
    return configured;
  }
  if (requirement.derivedFrom) {
    return valueAtPath(runtime.environmentTarget, requirement.derivedFrom);
  }
  return null;
}

function checkWranglerVars(ctx: HushContext, runtime: ProjectRuntimeContext): ProjectWranglerVarCheck {
  const actualValues = readWranglerVars(ctx, runtime);
  const vars = runtime.variableRequirements.map((requirement) => {
    const actual = actualValues[requirement.name] ?? null;
    const expected = expectedVariableValue(runtime, requirement);
    const ok = typeof actual === 'string' && actual.length > 0 && (expected === null || actual === expected);
    return {
      key: requirement.name,
      ok,
      source: expected === null
        ? 'wrangler.toml'
        : requirement.derivedFrom
          ? `environmentTargets:${requirement.derivedFrom}`
          : 'project-config',
      expected,
      actual,
    };
  });

  return {
    ok: vars.every((check) => check.ok),
    vars,
    missing: vars.filter((check) => !check.actual).map((check) => check.key),
    mismatched: vars.filter((check) => check.actual && !check.ok).map((check) => check.key),
    actualValues,
  };
}

function resolveHushTargetCheck(
  ctx: HushContext,
  store: StoreContext,
  runtime: ProjectRuntimeContext,
  options: ProjectOptions,
): { check: ProjectHushTargetCheck; view: V3ResolvedEnvView | null } {
  try {
    const resolveView = options.resolveTargetEnvView ?? resolveTargetEnvView;
    const view = resolveView(ctx, store, runtime.hushTarget, {
      name: 'project',
      args: [options.subcommand, runtime.stage],
    }) as V3ResolvedEnvView;
    const resolvedKeys = Object.keys(view.env).sort();
    const missing = runtime.requiredHushKeys.filter((key) => {
      const value = view.env[key];
      return typeof value !== 'string' || value.trim().length === 0;
    });

    return {
      check: {
        ok: missing.length === 0,
        target: runtime.hushTarget,
        required: runtime.requiredHushKeys,
        missing,
        resolvedKeys,
      },
      view,
    };
  } catch (error) {
    return {
      check: {
        ok: false,
        target: runtime.hushTarget,
        required: runtime.requiredHushKeys,
        missing: runtime.requiredHushKeys,
        resolvedKeys: [],
        error: error instanceof Error ? error.message : String(error),
      },
      view: null,
    };
  }
}

function wranglerEnvArgs(runtime: ProjectRuntimeContext): string[] {
  return runtime.wranglerEnv ? ['--env', runtime.wranglerEnv] : [];
}

function buildWranglerArgs(runtime: ProjectRuntimeContext, commandArgs: string[]): { command: string; args: string[] } {
  const [command, ...prefixArgs] = runtime.wranglerCommand;
  if (!command) {
    throw new Error(`surface ${runtime.surfaceName} has an empty wranglerCommand`);
  }
  return {
    command,
    args: [...prefixArgs, ...commandArgs],
  };
}

function parseJsonFromOutput<T>(output: string, startChar: '{' | '['): T {
  const start = output.indexOf(startChar);
  if (start < 0) {
    throw new Error(`Expected JSON output starting with ${startChar}`);
  }
  return JSON.parse(output.slice(start)) as T;
}

function listWorkerSecrets(ctx: HushContext, runtime: ProjectRuntimeContext, env: NodeJS.ProcessEnv): ProjectWorkerSecretCheck {
  const wrangler = buildWranglerArgs(runtime, ['secret', 'list', ...wranglerEnvArgs(runtime), '--format', 'json']);
  const result = ctx.exec.spawnSync(wrangler.command, wrangler.args, {
    cwd: runtime.wranglerDir,
    env,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error || result.status !== 0) {
    return {
      ok: false,
      error: result.error?.message ?? (toStringValue(result.stderr).trim() || `wrangler secret list exited ${result.status}`),
      secretNames: [],
      missing: runtime.runtimeSecretKeys,
    };
  }

  try {
    const payload = parseJsonFromOutput<Array<{ name?: string }>>(toStringValue(result.stdout), '[');
    const secretNames = uniqueSorted(payload.map((entry) => entry.name ?? '').filter(Boolean));
    const missing = runtime.runtimeSecretKeys.filter((key) => !secretNames.includes(key));
    return {
      ok: missing.length === 0,
      secretNames,
      missing,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      secretNames: [],
      missing: runtime.runtimeSecretKeys,
    };
  }
}

function syncWorkerSecrets(
  ctx: HushContext,
  runtime: ProjectRuntimeContext,
  env: NodeJS.ProcessEnv,
  dryRun: boolean,
): ProjectSyncResult {
  const synced: Array<{ key: string; dryRun?: boolean }> = [];
  const failed: Array<{ key: string; error: string }> = [];

  for (const key of runtime.runtimeSecretKeys) {
    const value = env[key]?.trim();
    if (!value) {
      failed.push({ key, error: 'missing_from_resolved_hush_target' });
      continue;
    }

    if (dryRun) {
      synced.push({ key, dryRun: true });
      continue;
    }

    const wrangler = buildWranglerArgs(runtime, ['secret', 'put', key, ...wranglerEnvArgs(runtime)]);
    const result = ctx.exec.spawnSync(wrangler.command, wrangler.args, {
      cwd: runtime.wranglerDir,
      env,
      input: value,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.status === 0 && !result.error) {
      synced.push({ key });
      continue;
    }

    failed.push({
      key,
      error: result.error?.message ?? (toStringValue(result.stderr).trim() || `wrangler secret put exited ${result.status}`),
    });
  }

  return {
    ok: failed.length === 0,
    dryRun,
    synced,
    failed,
  };
}

async function validateResend(
  ctx: HushContext,
  validator: ProjectProviderValidator,
  wranglerVars: ProjectWranglerVarCheck,
  env: NodeJS.ProcessEnv,
): Promise<ProjectProviderCheck> {
  const apiKey = env[validator.key]?.trim() ?? '';
  if (!apiKey) {
    return {
      provider: 'resend',
      key: validator.key,
      ok: false,
      error: `${validator.key} missing from resolved Hush target`,
    };
  }

  const fromEmail = validator.fromEmail
    ? wranglerVars.actualValues[validator.fromEmail] ?? env[validator.fromEmail] ?? ''
    : '';
  const fetchImpl = ctx.network?.fetch ?? fetch;
  const response = await fetchImpl('https://api.resend.com/domains', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message = isRecord(body) && typeof body.message === 'string' ? body.message : response.statusText;
    return {
      provider: 'resend',
      key: validator.key,
      ok: false,
      error: `Resend API key validation failed: HTTP ${response.status} ${message}`,
    };
  }

  const domains = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const fromDomain = fromEmail.split('@').at(1)?.toLowerCase() ?? null;
  let fromDomainStatus = 'not_checked';

  if (fromDomain) {
    const matchingDomain = domains.find((domain) => {
      return isRecord(domain) && typeof domain.name === 'string' && domain.name.toLowerCase() === fromDomain;
    });
    if (!matchingDomain) {
      return {
        provider: 'resend',
        key: validator.key,
        ok: false,
        error: `AUTH_FROM_EMAIL domain ${fromDomain} is not visible to the Resend API key.`,
      };
    }
    fromDomainStatus = typeof matchingDomain.status === 'string' ? matchingDomain.status : 'unknown';
    if (fromDomainStatus !== 'verified') {
      return {
        provider: 'resend',
        key: validator.key,
        ok: false,
        error: `AUTH_FROM_EMAIL domain ${fromDomain} is not verified in Resend. Status: ${fromDomainStatus}`,
      };
    }
  }

  return {
    provider: 'resend',
    key: validator.key,
    ok: true,
    fromDomain,
    fromDomainStatus,
  };
}

async function runProviderValidators(
  ctx: HushContext,
  runtime: ProjectRuntimeContext,
  wranglerVars: ProjectWranglerVarCheck,
  env: NodeJS.ProcessEnv,
): Promise<ProjectProviderSummary> {
  const checks: ProjectProviderCheck[] = [];
  for (const validator of runtime.surface.providerValidators ?? []) {
    if (validator.provider === 'resend') {
      checks.push(await validateResend(ctx, validator, wranglerVars, env));
      continue;
    }

    checks.push({
      provider: validator.provider,
      key: validator.key,
      ok: false,
      error: 'validator_not_implemented',
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function summarizeStatus(payload: ProjectPayload['checks']): 'ok' | 'drift' {
  const parts = [payload.hushTarget, payload.wranglerVars, payload.workerSecrets, payload.providers, payload.sync]
    .filter((part): part is Exclude<typeof part, null> => part !== null);
  return parts.every((part) => part.ok) ? 'ok' : 'drift';
}

function buildActions(
  runtime: ProjectRuntimeContext,
  workerSecrets: ProjectWorkerSecretCheck | { ok: true; skipped: true } | null,
  mode: ProjectMode,
): ProjectPayload['actions'] {
  const missingRemote = workerSecrets && 'missing' in workerSecrets ? new Set(workerSecrets.missing) : new Set<string>();
  return runtime.runtimeSecretKeys.map((key) => ({
    kind: 'cloudflare-secret-put' as const,
    key,
    source: `hush:${runtime.hushTarget}`,
    target: runtime.wranglerEnv ? `worker:${runtime.surface.wranglerDir}#${runtime.wranglerEnv}` : `worker:${runtime.surface.wranglerDir}`,
    reason: missingRemote.has(key) ? 'missing-remote' : mode === 'sync' ? 'sync-requested' : 'ensure-in-sync',
  }));
}

function renderHuman(payload: ProjectPayload): string {
  const lines = [
    `status=${payload.status}`,
    `mode=${payload.mode}`,
    `environment=${payload.environment}`,
    `surface=${payload.surface}`,
    `config=${payload.configPath}`,
    `hushTarget=${payload.hushTarget}`,
    `runtimeSecrets=${payload.contract.runtimeSecrets.join(',')}`,
  ];

  if (!payload.checks.hushTarget.ok) {
    lines.push(`hushMissing=${payload.checks.hushTarget.missing.join(',') || 'unknown'}`);
  }
  if (!payload.checks.wranglerVars.ok) {
    lines.push(`wranglerVarDrift=${[...payload.checks.wranglerVars.missing, ...payload.checks.wranglerVars.mismatched].join(',')}`);
  }
  if (payload.checks.workerSecrets && !payload.checks.workerSecrets.ok) {
    lines.push(`workerSecretMissing=${payload.checks.workerSecrets.missing.join(',')}`);
  }
  if (payload.checks.providers && !payload.checks.providers.ok) {
    lines.push(`providerFailures=${payload.checks.providers.checks.filter((check) => !check.ok).map((check) => `${check.provider}:${check.key}`).join(',')}`);
  }
  if (payload.checks.sync && !payload.checks.sync.ok) {
    lines.push(`syncFailures=${payload.checks.sync.failed.map((entry) => entry.key).join(',')}`);
  }
  if (payload.actions.length > 0) {
    lines.push(`actions=${payload.actions.map((action) => `${action.kind}:${action.key}`).join(',')}`);
  }

  return lines.join('\n');
}

function printPayload(ctx: HushContext, payload: ProjectPayload, json: boolean): void {
  if (json) {
    ctx.logger.log(JSON.stringify(payload, null, 2));
    return;
  }

  ctx.logger.log(renderHuman(payload));
}

export async function projectCommand(ctx: HushContext, options: ProjectOptions): Promise<void> {
  const runtime = loadProjectRuntimeContext(ctx, options.store, options);
  const wranglerVars = checkWranglerVars(ctx, runtime);
  const { check: hushTarget, view } = resolveHushTargetCheck(ctx, options.store, runtime, options);

  let workerSecrets: ProjectPayload['checks']['workerSecrets'] = options.skipRemote ? { ok: true, skipped: true } : null;
  let providers: ProjectPayload['checks']['providers'] = options.skipProvider ? { ok: true, skipped: true } : null;
  let sync: ProjectPayload['checks']['sync'] = null;

  if (view) {
    const env = {
      ...ctx.process.env,
      ...view.env,
    };

    if (!options.skipRemote) {
      workerSecrets = listWorkerSecrets(ctx, runtime, env);
    }

    if (options.subcommand === 'sync') {
      sync = syncWorkerSecrets(ctx, runtime, env, options.dryRun);
      if (!options.skipRemote && sync.ok && !options.dryRun) {
        workerSecrets = listWorkerSecrets(ctx, runtime, env);
      }
    }

    if (!options.skipProvider) {
      providers = await runProviderValidators(ctx, runtime, wranglerVars, env);
    }
  }

  const payload: ProjectPayload = {
    status: 'drift',
    mode: options.subcommand,
    environment: runtime.stage,
    surface: runtime.surfaceName,
    configPath: runtime.configPathDisplay,
    hushTarget: runtime.hushTarget,
    contract: {
      deploySecrets: runtime.deployKeys,
      runtimeSecrets: runtime.runtimeSecretKeys,
      runtimeVariables: runtime.variableRequirements.map((requirement) => requirement.name),
    },
    checks: {
      hushTarget,
      wranglerVars,
      workerSecrets,
      providers,
      sync,
    },
    actions: view ? buildActions(runtime, workerSecrets, options.subcommand) : [],
  };
  payload.status = summarizeStatus(payload.checks);

  printPayload(ctx, payload, options.json);

  if ((options.subcommand === 'validate' || options.subcommand === 'sync') && payload.status !== 'ok') {
    ctx.process.exit(1);
  }
}
