import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pc from 'picocolors';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  appendAuditEvent,
  createFileDocument,
  getActiveIdentity,
  getProjectStatePaths,
  getV3EncryptedFilePath,
  requireActiveIdentity,
  resolveV3Target,
  shapeTargetArtifacts,
} from '../index.js';
import { findProjectRoot, isV3RepositoryRoot } from '../config/loader.js';
import { loadV3Repository, persistV3FileDocument } from '../v3/repository.js';
import type { HushImportRepositoryMap } from '../v3/imports.js';
import type {
  EnvVar,
  PushConfig,
  HushCompactRecord,
  HushContext,
  HushFileDocument,
  HushProvenanceRecord,
  HushResolvedNode,
  HushTargetDefinition,
  HushTargetResolution,
  HushV3Repository,
  StoreContext,
} from '../types.js';

export const DEFAULT_V3_FILE_PATHS = {
  shared: 'env/project/shared',
  development: 'env/project/development',
  production: 'env/project/production',
  local: 'env/project/local',
} as const;

export const LOCAL_OVERRIDE_FILENAME = 'local-overrides.encrypted';
export const DEFAULT_PERSISTED_OUTPUT_DIRNAME = '.hush-materialized';

export type FileKey = keyof typeof DEFAULT_V3_FILE_PATHS;
export const FILE_KEYS = Object.keys(DEFAULT_V3_FILE_PATHS) as FileKey[];
const FILE_ALIASES: Record<string, FileKey> = {
  shared: 'shared',
  development: 'development',
  dev: 'development',
  production: 'production',
  prod: 'production',
  local: 'local',
};

function loadImportedRepositories(repository: HushV3Repository): HushImportRepositoryMap {
  return Object.fromEntries(
    Object.entries(repository.manifest.imports ?? {}).map(([name, definition]) => {
      if (!definition.sourceRoot) {
        throw new Error(
          `Import "${name}" has no sourceRoot binding. Re-add it with hush import add --source-root <path>.`,
        );
      }
      return [name, loadV3Repository(definition.sourceRoot, { keyIdentity: definition.sourceRoot })];
    }),
  );
}

export interface EditableDestination {
  fileKey?: FileKey;
  filePath: string;
}

export function isFileKey(value: string): value is FileKey {
  return FILE_KEYS.includes(value as FileKey);
}

/**
 * Normalize a user-supplied file selector (registered namespaced path,
 * `.hush/files/...` path, or `*.encrypted` form) to a bare logical file path.
 */
export function normalizeRequestedFilePath(value: string): string {
  return value
    .trim()
    .replace(/\.encrypted$/, '')
    .replace(/^\.hush\/files\//, '')
    .replace(/^\/+/, '');
}

/**
 * Resolve an explicit `--file`/positional file selector to a concrete write
 * destination. Accepts short aliases (shared/dev/development/prod/production/
 * local) AND any file declared in the repository's manifest file index.
 *
 * Hard-errors (never silently routes a secret to a fallback file) when the
 * selector cannot be honored — this is the load-bearing safety property for
 * `set`/`edit`.
 */
export function resolveEditableDestination(
  file: string,
  repository: HushV3Repository,
): EditableDestination {
  const alias = FILE_ALIASES[file];
  if (alias) {
    return { fileKey: alias, filePath: DEFAULT_V3_FILE_PATHS[alias] };
  }

  const normalized = normalizeRequestedFilePath(file);

  if (repository.filesByPath[normalized]) {
    return { filePath: normalized };
  }

  const matchedAlias = (Object.entries(DEFAULT_V3_FILE_PATHS) as [FileKey, string][]).find(
    ([, candidatePath]) => candidatePath === normalized,
  );
  if (matchedAlias) {
    const [fileKey, filePath] = matchedAlias;
    return { fileKey, filePath };
  }

  throw new Error(
    `Unknown file "${file}". Use one of: shared, development, production, local, ` +
      `or a declared v3 file path (run "hush file list" to see registered files).`,
  );
}

/**
 * Load (and, for alias destinations, lazily create) the editable file document
 * for a resolved destination. Declared non-alias paths must already exist.
 */
export function loadEditableDestination(
  ctx: HushContext,
  store: StoreContext,
  repository: HushV3Repository,
  destination: EditableDestination,
): { document: HushFileDocument; filePath: string; systemPath: string; scope: 'repository' | 'machine-local' } {
  if (destination.fileKey) {
    return ensureEditableFileDocument(ctx, store, repository, destination.fileKey);
  }

  const systemPath = repository.fileSystemPaths[destination.filePath];
  if (!systemPath) {
    throw new Error(`File "${destination.filePath}" is not declared in this repository`);
  }

  return {
    document: repository.loadFile(destination.filePath),
    filePath: destination.filePath,
    systemPath,
    scope: 'repository',
  };
}

export interface V3TargetRuntimeSelection {
  repository: HushV3Repository;
  targetName: string;
  target: HushTargetDefinition;
  activeIdentity: string;
}

export interface V3ResolvedEnvView extends V3TargetRuntimeSelection {
  resolution: HushTargetResolution;
  envVars: EnvVar[];
  env: Record<string, string>;
  files: string[];
  logicalPaths: string[];
  localOverrideFile?: string;
}

interface LegacyMigrationTargetMetadata {
  name: string;
  path: string;
  push_to?: PushConfig | null;
}

interface V3DeploymentContext {
  cwd: string;
  pushTo?: PushConfig | null;
}

function parseYamlObject(filePath: string, content: string): unknown {
  const parsed = parseYaml(content);

  if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
    throw new Error(`Expected YAML object in ${filePath}`);
  }

  return parsed;
}

function readPlainYamlObject(ctx: HushContext, filePath: string): unknown {
  const raw = ctx.fs.readFileSync(filePath, 'utf-8');
  const content = typeof raw === 'string' ? raw : raw.toString('utf-8');
  return parseYamlObject(filePath, content);
}

function createRepositoryFileDocument(repository: HushV3Repository, filePath: string): HushFileDocument {
  const sharedReaders = repository.filesByPath[DEFAULT_V3_FILE_PATHS.shared]?.readers;

  return createFileDocument({
    path: filePath,
    readers: sharedReaders ?? {
      roles: ['owner', 'member', 'ci'],
      identities: [],
    },
    sensitive: true,
    entries: {},
  });
}

function createLocalOverrideDocument(): HushFileDocument {
  return createFileDocument({
    path: DEFAULT_V3_FILE_PATHS.local,
    readers: {
      roles: ['owner', 'member', 'ci'],
      identities: [],
    },
    sensitive: true,
    entries: {},
  });
}

function envVarKeyToLogicalPath(filePath: string, key: string): string {
  const normalizedKey = key.trim();

  if (!normalizedKey) {
    throw new Error('Secret key cannot be empty');
  }

  return `${filePath}/${normalizedKey}`;
}

function toEnvVarValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
}

function upsertEnvVars(base: EnvVar[], overrides: EnvVar[]): EnvVar[] {
  const byKey = new Map(base.map((variable) => [variable.key, variable.value]));

  for (const variable of overrides) {
    byKey.set(variable.key, variable.value);
  }

  return Array.from(byKey.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }));
}

function localOverrideEntriesToEnvVars(document: HushFileDocument | null): EnvVar[] {
  if (!document) {
    return [];
  }

  return Object.entries(document.entries)
    .filter(([, entry]) => !('type' in entry))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([logicalPath, entry]) => ({
      key: logicalPath.split('/').filter(Boolean).at(-1) ?? logicalPath,
      value: toEnvVarValue(entry.value),
    }));
}

export function requireV3Repository(store: StoreContext, commandName: string): HushV3Repository {
  if (!isV3RepositoryRoot(store.root)) {
    const projectInfo = findProjectRoot(store.root);
    if (projectInfo?.repositoryKind === 'legacy-v2') {
      throw new Error(
        `The "${commandName}" command now requires a v3 repository rooted at .hush/. `
        + `This project still uses legacy runtime authority at ${projectInfo.configPath}. Bootstrap or migrate before using this command.`,
      );
    }

    throw new Error(
      `The "${commandName}" command now requires a v3 repository rooted at .hush/. `
      + 'Bootstrap or migrate before using this command.',
    );
  }

  return loadV3Repository(store.root, { keyIdentity: store.keyIdentity });
}

export function createMigrationOnlyCommandError(commandName: string): Error {
  return new Error(
    `The "${commandName}" command is retired. Legacy plaintext and dual-runtime helpers now run only through "hush migrate --from v2". `
    + 'Use the migration flow to inventory or convert a legacy hush.yaml repository.',
  );
}

export function selectRuntimeTarget(repository: HushV3Repository, requestedTarget?: string): { targetName: string; target: HushTargetDefinition } {
  const targets = repository.manifest.targets ?? {};

  if (requestedTarget) {
    const selected = targets[requestedTarget];
    if (!selected) {
      throw new Error(`Target "${requestedTarget}" not found. Available targets: ${Object.keys(targets).sort().join(', ') || '(none)'}`);
    }

    return { targetName: requestedTarget, target: selected };
  }

  if (targets.runtime) {
    return { targetName: 'runtime', target: targets.runtime };
  }

  const nonExampleTargets = Object.entries(targets).filter(([, target]) => target.mode !== 'example');
  const candidates = nonExampleTargets.length > 0 ? nonExampleTargets : Object.entries(targets);

  if (candidates.length === 1) {
    const [targetName, target] = candidates[0]!;
    return { targetName, target };
  }

  if (candidates.length === 0) {
    throw new Error('No v3 targets are declared in this repository. Add a target with "hush config" or re-bootstrap the repo.');
  }

  throw new Error(
    `Multiple v3 targets are available (${candidates.map(([name]) => name).join(', ')}). Use --target to choose one explicitly.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getLegacyMigrationTargetMetadata(repository: HushV3Repository): LegacyMigrationTargetMetadata[] {
  const metadata = repository.manifest.metadata;
  if (!isRecord(metadata)) {
    return [];
  }

  const legacyMigration = metadata.legacyMigration;
  if (!isRecord(legacyMigration) || !Array.isArray(legacyMigration.targets)) {
    return [];
  }

  return legacyMigration.targets.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.path !== 'string') {
      return [];
    }

    const pushTo = entry.push_to;
    return [{
      name: entry.name,
      path: entry.path,
      push_to: isPushConfig(pushTo) ? pushTo : null,
    }];
  });
}

function isPushConfig(value: unknown): value is PushConfig {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.type === 'cloudflare-workers') {
    return true;
  }

  if (value.type === 'vercel') {
    return typeof value.projectId === 'string'
      && Array.isArray(value.environments)
      && value.environments.length > 0
      && value.environments.every((environment) => environment === 'production' || environment === 'preview' || environment === 'development')
      && (value.token === undefined || typeof value.token === 'string')
      && (value.teamId === undefined || typeof value.teamId === 'string');
  }

  return value.type === 'cloudflare-pages' && typeof value.project === 'string';
}

function getLegacyTargetMetadataForName(repository: HushV3Repository, targetName: string): LegacyMigrationTargetMetadata | undefined {
  const legacyTargets = getLegacyMigrationTargetMetadata(repository);
  const exactMatch = legacyTargets.find((target) => target.name === targetName);
  if (exactMatch) {
    return exactMatch;
  }

  return legacyTargets.find((target) => `${target.name}-production` === targetName);
}

function isWithinPath(parentPath: string, candidatePath: string): boolean {
  const pathDelta = relative(parentPath, candidatePath);
  return pathDelta === '' || (!pathDelta.startsWith('..') && pathDelta !== '.');
}

export function selectRuntimeTargetForCommand(
  repository: HushV3Repository,
  store: StoreContext,
  command: { name: string; args: string[] },
  requestedTarget?: string,
  currentWorkingDirectory?: string,
): { targetName: string; target: HushTargetDefinition } {
  if (requestedTarget) {
    return selectRuntimeTarget(repository, requestedTarget);
  }

  try {
    return selectRuntimeTarget(repository, undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('Multiple v3 targets are available')) {
      throw error;
    }
  }

  const cwd = resolve(currentWorkingDirectory ?? store.root);
  const legacyMatches = getLegacyMigrationTargetMetadata(repository)
    .filter((target) => isWithinPath(resolve(store.root, target.path), cwd))
    .sort((left, right) => right.path.length - left.path.length);

  if (legacyMatches.length > 0) {
    const targetName = legacyMatches[0]!.name;
    const target = repository.manifest.targets?.[targetName];
    if (target) {
      return { targetName, target };
    }
  }

  const availableTargets = Object.keys(repository.manifest.targets ?? {}).sort();
  throw new Error(
    `Multiple v3 targets are available (${availableTargets.join(', ')}). ${command.name} does not accept --target yet, so run it from a migrated target directory or add a runtime target for the repository root.`,
  );
}

export function resolveTargetDeploymentContext(
  store: StoreContext,
  repository: HushV3Repository,
  targetName: string,
): V3DeploymentContext {
  const legacyTarget = getLegacyTargetMetadataForName(repository, targetName);

  return {
    cwd: legacyTarget ? resolve(store.root, legacyTarget.path) : store.root,
    pushTo: legacyTarget?.push_to,
  };
}

export function getMachineLocalOverridePath(store: StoreContext): string {
  const statePaths = getProjectStatePaths(store);
  return join(statePaths.projectRoot, 'user', LOCAL_OVERRIDE_FILENAME);
}

/**
 * Read the machine-local override document for this store.
 *
 * MUST stay symmetric with `writeMachineLocalOverrides`: the writer persists
 * for every store mode, so the reader must look in every store mode too. An
 * earlier `store.mode === 'global'` early-return here made `hush set --global
 * --repo-local` a silent no-op — the write landed on disk and no read path
 * ever looked at it.
 */
export function loadMachineLocalOverrides(ctx: HushContext, store: StoreContext): HushFileDocument | null {
  const overridePath = getMachineLocalOverridePath(store);
  if (!ctx.fs.existsSync(overridePath)) {
    return null;
  }

  try {
    const content = ctx.sops.decryptYaml(overridePath, {
      root: store.root,
      keyIdentity: store.keyIdentity,
    });
    return createFileDocument(parseYamlObject(overridePath, content) as HushFileDocument);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid machine-local override file at ${overridePath}: ${message}`);
  }
}

export function writeMachineLocalOverrides(ctx: HushContext, store: StoreContext, document: HushFileDocument): string {
  const filePath = getMachineLocalOverridePath(store);
  const parentDir = join(getProjectStatePaths(store).projectRoot, 'user');
  ctx.fs.mkdirSync(parentDir, { recursive: true });
  ctx.sops.encryptYamlContent(stringifyYaml(document, { indent: 2 }), filePath, {
    root: store.root,
    keyIdentity: store.keyIdentity,
  });
  return filePath;
}

export function ensureEditableFileDocument(
  ctx: HushContext,
  store: StoreContext,
  repository: HushV3Repository,
  fileKey: FileKey,
): { document: HushFileDocument; filePath: string; systemPath: string; scope: 'repository' | 'machine-local' } {
  if (fileKey === 'local') {
    const document = loadMachineLocalOverrides(ctx, store) ?? createLocalOverrideDocument();
    const systemPath = writeMachineLocalOverrides(ctx, store, document);
    return {
      document,
      filePath: document.path,
      systemPath,
      scope: 'machine-local',
    };
  }

  const filePath = DEFAULT_V3_FILE_PATHS[fileKey];
  const existing = repository.filesByPath[filePath];
  if (existing) {
    return {
      document: repository.loadFile(filePath),
      filePath,
      systemPath: repository.fileSystemPaths[filePath]!,
      scope: 'repository',
    };
  }

  const document = createRepositoryFileDocument(repository, filePath);
  const systemPath = getV3EncryptedFilePath(store.root, filePath);
  ctx.fs.mkdirSync(join(store.root, '.hush', 'files', ...filePath.split('/').slice(0, -1)), { recursive: true });
  persistV3FileDocument(ctx, store, repository, systemPath, document);
  return {
    document,
    filePath,
    systemPath,
    scope: 'repository',
  };
}

export function setEnvValueInDocument(document: HushFileDocument, key: string, value: string): HushFileDocument {
  const logicalPath = envVarKeyToLogicalPath(document.path, key);
  return createFileDocument({
    ...document,
    entries: {
      ...document.entries,
      [logicalPath]: {
        value,
        sensitive: true,
      },
    },
  });
}

export function writeEditableFileDocument(
  ctx: HushContext,
  store: StoreContext,
  repository: HushV3Repository,
  systemPath: string,
  document: HushFileDocument,
): void {
  persistV3FileDocument(ctx, store, repository, systemPath, document);
}

export interface EditableWriteTarget {
  filePath: string;
  scope: 'repository' | 'machine-local';
}

/**
 * Re-read a just-written logical path from durable storage, using the SAME
 * reader the runtime resolution path uses for that scope.
 *
 * Machine-local writes are read back through `loadMachineLocalOverrides` and
 * repository writes through a freshly loaded repository (never the caller's
 * in-memory repository, whose file cache would happily echo a document that
 * was never persisted). Returns `undefined` when the value is not readable.
 */
export function readBackEditableValue(
  ctx: HushContext,
  store: StoreContext,
  target: EditableWriteTarget,
  key: string,
): string | undefined {
  const document = target.scope === 'machine-local'
    ? loadMachineLocalOverrides(ctx, store)
    : loadV3Repository(store.root, { keyIdentity: store.keyIdentity }).loadFile(target.filePath);

  if (!document) {
    return undefined;
  }

  const entry = document.entries[envVarKeyToLogicalPath(target.filePath, key)];
  if (!entry || 'type' in entry || typeof entry.value !== 'string') {
    return undefined;
  }

  return entry.value;
}

/**
 * Fail-loud write verification. A secrets tool that prints success without
 * proving the value is readable is worse than one that errors, so every `set`
 * write is confirmed against durable storage before any success line is
 * emitted. Never includes the secret value in the error message.
 */
export function assertEditableValuePersisted(
  ctx: HushContext,
  store: StoreContext,
  target: EditableWriteTarget,
  key: string,
  expectedValue: string,
): void {
  let persisted: string | undefined;

  try {
    persisted = readBackEditableValue(ctx, store, target, key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Write verification failed for ${key} in ${target.filePath} (${target.scope}): `
      + `the value could not be read back after writing (${message}). Nothing was reported as saved.`,
    );
  }

  if (persisted === undefined) {
    throw new Error(
      `Write verification failed for ${key} in ${target.filePath} (${target.scope}): `
      + 'the value is missing when read back from durable storage. '
      + 'The write did not persist; do not treat this secret as saved.',
    );
  }

  if (persisted !== expectedValue) {
    throw new Error(
      `Write verification failed for ${key} in ${target.filePath} (${target.scope}): `
      + 'the value read back from durable storage does not match the value written. '
      + 'Do not treat this secret as saved.',
    );
  }
}

/**
 * Second-order check after a verified write: the value is durably stored, but
 * does the runtime target actually select the file it landed in?
 *
 * This is a warning rather than an error because writing into a file the
 * current target does not resolve is legitimate (stage-split production and
 * staging files are written from a development checkout all the time). It
 * exists so the common misconfiguration — a declared file that no bundle
 * includes — stops looking like a fully successful write.
 *
 * Returns `undefined` when the value resolves, or when resolution cannot be
 * determined at all; never throws.
 */
export function describeUnresolvedWrite(
  ctx: HushContext,
  store: StoreContext,
  key: string,
  filePath: string,
): string | undefined {
  try {
    const view = resolveTargetEnvView(ctx, store, undefined, { name: 'set', args: [key] });
    if (view.envVars.some((variable) => variable.key === key)) {
      return undefined;
    }

    return `${key} is stored in ${filePath}, but target "${view.targetName}" does not resolve that file, `
      + `so "hush get ${key}" will not return it here. `
      + `Add ${filePath} to that target's bundle, or run "hush trace ${key}" to see which targets select it.`;
  } catch {
    // Resolution is unavailable (no runtime target, ambiguous target, unreadable
    // file). The write itself is already verified, so stay quiet.
    return undefined;
  }
}

export function openEditor(ctx: HushContext, systemPath: string, editorOverride?: string): void {
  const resolvedEditor = editorOverride ?? ctx.process.env.EDITOR ?? 'vi';
  ctx.logger.info(pc.dim(`Using editor: ${resolvedEditor}`));
  const [bin, ...editorArgs] = resolvedEditor.split(/\s+/);
  ctx.exec.spawnSync(bin, [...editorArgs, systemPath], { stdio: 'inherit' });
}

export function validateEditedFileDocument(ctx: HushContext, systemPath: string): HushFileDocument {
  return createFileDocument(readPlainYamlObject(ctx, systemPath) as HushFileDocument);
}

function createPrivateTempYaml(): { tempDir: string; tempPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'hush-edit-'));
  const tempPath = join(tempDir, 'document.yaml');
  chmodSync(tempDir, 0o700);
  return { tempDir, tempPath };
}

export function openEncryptedDocumentEditor(
  ctx: HushContext,
  store: StoreContext,
  systemPath: string,
  repository?: HushV3Repository,
  editorOverride?: string,
): HushFileDocument {
  const { tempDir, tempPath } = createPrivateTempYaml();

  try {
    const decrypted = ctx.sops.decryptYaml(systemPath, {
      root: store.root,
      keyIdentity: store.keyIdentity,
    });
    writeFileSync(tempPath, decrypted, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(tempPath, 0o600);
    openEditor(ctx, tempPath, editorOverride);
    const document = validateEditedFileDocument(ctx, tempPath);
    if (repository) {
      persistV3FileDocument(ctx, store, repository, systemPath, document);
    } else {
      ctx.sops.encryptYamlContent(stringifyYaml(document, { indent: 2 }), systemPath, {
        root: store.root,
        keyIdentity: store.keyIdentity,
      });
    }
    return document;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function resolveTargetEnvView(
  ctx: HushContext,
  store: StoreContext,
  requestedTarget: string | undefined,
  command: { name: string; args: string[] },
): V3ResolvedEnvView {
  const repository = requireV3Repository(store, command.name);
  const activeIdentity = requireActiveIdentity(ctx, store, repository.manifest.identities, command);
  const { targetName, target } = selectRuntimeTargetForCommand(repository, store, command, requestedTarget, ctx.process.cwd());
  const resolution = resolveV3Target(ctx, {
    store,
    repository,
    importedRepositories: loadImportedRepositories(repository),
    targetName,
    command,
  });
  const shaped = shapeTargetArtifacts(targetName, target, resolution);
  const localOverrides = loadMachineLocalOverrides(ctx, store);
  const localEnvVars = localOverrideEntriesToEnvVars(localOverrides);
  const envVars = upsertEnvVars(shaped.envVars, localEnvVars);
  const env = Object.fromEntries(envVars.map((variable) => [variable.key, variable.value]));
  const files = Array.from(new Set([
    ...resolution.files,
    ...(localOverrides ? [localOverrides.path] : []),
  ])).sort();
  const logicalPaths = Array.from(new Set([
    ...Object.keys(resolution.values),
    ...Object.keys(resolution.artifacts),
    ...(localOverrides ? Object.keys(localOverrides.entries) : []),
  ])).sort();

  return {
    repository,
    targetName,
    target,
    activeIdentity,
    resolution,
    envVars,
    env,
    files,
    logicalPaths,
    localOverrideFile: localOverrides?.path,
  };
}

function getCompactSource(record: HushProvenanceRecord): string {
  return record.filePath;
}

function getCompactPrecedence(node: Pick<HushResolvedNode, 'provenance'>): number {
  return Math.max(node.provenance.length - 1, 0);
}

export function toCompactRecord(key: string, target: string, node: Pick<HushResolvedNode, 'provenance'>): HushCompactRecord {
  const primarySource = node.provenance.at(-1) ?? node.provenance[0];

  return {
    key,
    source: primarySource ? getCompactSource(primarySource) : '-',
    target,
    precedence: getCompactPrecedence(node),
  };
}

export function formatCompactRecord(record: HushCompactRecord): string {
  return `  ${pc.cyan(record.key)} ${pc.dim(`source=${record.source} target=${record.target} precedence=${record.precedence}`)}`;
}

export function appendCommandReadAudit(
  ctx: HushContext,
  store: StoreContext,
  view: Pick<V3ResolvedEnvView, 'activeIdentity' | 'files' | 'logicalPaths' | 'targetName' | 'resolution'>,
  command: { name: string; args: string[] },
): void {
  appendAuditEvent(ctx, store, {
    type: 'read_attempt',
    activeIdentity: view.activeIdentity,
    success: true,
    command,
    files: view.files,
    logicalPaths: view.logicalPaths,
    bundle: view.resolution.bundle,
    target: view.targetName,
  });
}

export function requireMutableIdentity(ctx: HushContext, store: StoreContext, repository: HushV3Repository, command: { name: string; args: string[] }): string {
  const activeIdentity = requireActiveIdentity(ctx, store, repository.manifest.identities, command);
  const identityRecord = repository.manifest.identities[activeIdentity];

  if (!identityRecord?.roles.includes('owner')) {
    appendAuditEvent(ctx, store, {
      type: 'access_denied',
      activeIdentity,
      requestedIdentity: activeIdentity,
      success: false,
      command,
      reason: `Active identity "${activeIdentity}" must have the owner role to mutate v3 repository data`,
    });

    throw new Error(`Active identity "${activeIdentity}" must have the owner role to mutate v3 repository data`);
  }

  return activeIdentity;
}

export function readCurrentIdentity(ctx: HushContext, store: StoreContext): string | undefined {
  try {
    return getActiveIdentity(ctx, store) ?? undefined;
  } catch {
    return undefined;
  }
}

export function formatDuplicateKeyHint(key: string, files: string[], target: string): string {
  const fileList = files.map((f) => `  - ${f}`).join('\n');
  const precedence = files.map((f, i) => `  ${i + 1}. ${f}`).join('\n');
  
  return `\n\nTo fix this duplicate key conflict:\n\n1. Choose which file should own the key\n2. Remove the duplicate from the other file(s):\n\n   hush move-key ${key} --from <source> --to <destination>\n   # or\n   hush delete-key ${key} --from <file-to-remove-from>\n\nFiles containing the duplicate:\n${fileList}\n\nPrecedence order for target "${target}":\n${precedence}\n\nKeys in earlier files take precedence when the same key exists in multiple files.`;
}
