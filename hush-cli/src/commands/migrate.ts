import { dirname, join, relative } from 'node:path';
import pc from 'picocolors';
import { stringify as stringifyYaml } from 'yaml';
import { parseEnvContent } from '../core/parse.js';
import { getUnresolvedVars, interpolateVars } from '../core/interpolate.js';
import { mergeVars } from '../core/merge.js';
import { getProjectIdentifier } from '../project.js';
import { loadLegacyV2Inventory } from '../v3/legacy-v2.js';
import { MACHINE_LOCAL_FILE_PATH } from '../v3/schema.js';
import type {
  EnvVar,
  HushContext,
  HushFileDocument,
  HushManifestDocument,
  HushTargetDefinition,
  LegacyTarget,
  LegacyV2Inventory,
  StoreContext,
} from '../types.js';
import {
  V3_SCHEMA_VERSION,
  createFileDocument,
  createFileIndexEntry,
  createManifestDocument,
  getProjectStatePaths,
  getV3EncryptedFilePath,
  getV3ManifestPath,
  loadV3Repository,
  materializeV3Target,
  setActiveIdentity,
} from '../index.js';

export interface MigrateOptions {
  root: string;
  dryRun: boolean;
  from?: string;
  cleanup: boolean;
}

interface LegacySourceInventory {
  name: 'shared' | 'development' | 'production' | 'local';
  sourcePath: string;
  encryptedPath: string;
  encryptedExists: boolean;
  plaintextExists: boolean;
}

interface MigrationReference {
  filePath: string;
  lines: string[];
}

interface MigrationMarker {
  version: 1;
  source: 'v2';
  validated: boolean;
  createdAt: string;
  configPath: string;
  legacyEncryptedFiles: string[];
  cleanupCandidates: string[];
  targetNames: string[];
}

const MIGRATION_MARKER_BASENAME = 'migration-v2-state.json';
const DEFAULT_IDENTITY = 'owner-local';

function getMigrationMarkerPath(root: string): string {
  return join(root, '.hush', MIGRATION_MARKER_BASENAME);
}

function toRelativePath(root: string, filePath: string): string {
  const value = relative(root, filePath);
  return value === '' ? '.' : value;
}

function sanitizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'target';
}

function matchesPattern(key: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
  return regex.test(key);
}

function filterLegacyVars(vars: EnvVar[], target: LegacyTarget): EnvVar[] {
  let filtered = [...vars];

  if (target.include && target.include.length > 0) {
    filtered = filtered.filter((variable) => target.include?.some((pattern) => matchesPattern(variable.key, pattern)));
  }

  if (target.exclude && target.exclude.length > 0) {
    filtered = filtered.filter((variable) => !target.exclude?.some((pattern) => matchesPattern(variable.key, pattern)));
  }

  return filtered;
}

function getLegacySources(inventory: LegacyV2Inventory): LegacySourceInventory[] {
  return inventory.sources.map((source) => ({
    name: source.name,
    sourcePath: source.path,
    encryptedPath: `${source.path}.encrypted`,
    encryptedExists: false,
    plaintextExists: false,
  }));
}

function withSourcePresence(ctx: HushContext, root: string, sources: LegacySourceInventory[]): LegacySourceInventory[] {
  return sources.map((source) => ({
    ...source,
    encryptedExists: ctx.fs.existsSync(join(root, source.encryptedPath)),
    plaintextExists: ctx.fs.existsSync(join(root, source.sourcePath)),
  }));
}

function collectCommandReferences(ctx: HushContext, root: string): MigrationReference[] {
  const discovered: MigrationReference[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of ctx.fs.readdirSync(current) as string[]) {
      const filePath = join(current, entry);
      let stats: ReturnType<typeof ctx.fs.statSync>;
      try {
        stats = ctx.fs.statSync(filePath);
      } catch {
        // broken symlink or inaccessible file — skip silently
        continue;
      }

      if (stats.isDirectory()) {
        if (
          entry === 'node_modules' ||
          entry === '.git' ||
          entry === '.hush' ||
          entry === '.pnpm-store' ||
          entry === '.worktrees' ||
          entry === 'dist' ||
          entry === 'build' ||
          entry === '.cache' ||
          entry === 'coverage'
        ) {
          continue;
        }
        // skip sub-repos (directories with their own .git)
        try {
          const gitPath = join(filePath, '.git');
          if (ctx.fs.existsSync(gitPath)) {
            continue;
          }
        } catch {
          // ignore
        }
        queue.push(filePath);
        continue;
      }

      if (!(entry === 'package.json' || entry.endsWith('.md') || entry.endsWith('.mdx') || entry === 'README' || entry === 'README.md')) {
        continue;
      }

      const content = ctx.fs.readFileSync(filePath, 'utf-8');
      const text = typeof content === 'string' ? content : content.toString('utf-8');
      const matches = text
        .split(/\r?\n/)
        .filter((line) => line.includes('hush '))
        .slice(0, 6);

        if (matches.length > 0) {
          discovered.push({
          filePath: toRelativePath(root, filePath),
            lines: matches,
          });
        }
    }
  }

  return discovered.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function createSourceDocument(filePath: string, vars: EnvVar[]): HushFileDocument {
  const entries = Object.fromEntries(vars.map((variable) => [
    `${filePath}/${variable.key}`,
    { value: variable.value, sensitive: true },
  ]));

  return createFileDocument({
    path: filePath,
    readers: {
      roles: ['owner', 'member', 'ci'],
      identities: [],
    },
    sensitive: true,
    entries,
  });
}

function writeYamlDocument(
  ctx: HushContext,
  root: string,
  keyIdentity: string | undefined,
  filePath: string,
  value: unknown,
): void {
  ctx.fs.mkdirSync(dirname(filePath), { recursive: true });
  ctx.sops.encryptYamlContent(stringifyYaml(value, { indent: 2 }), filePath, {
    root,
    keyIdentity,
  });
}

function getRepositoryStore(root: string, projectKeyIdentity: string | undefined): StoreContext {
  const store: StoreContext = {
    mode: 'project',
    root,
    configPath: null,
    keyIdentity: projectKeyIdentity,
    displayLabel: root,
  };

  if (process.env.HOME) {
    store.stateRoot = join(process.env.HOME, '.hush', 'state');
  }

  const statePaths = getProjectStatePaths(store);
  return {
    ...store,
    projectSlug: statePaths.projectSlug,
    stateRoot: statePaths.stateRoot,
    projectStateRoot: statePaths.projectRoot,
    activeIdentityPath: statePaths.activeIdentityPath,
    auditLogPath: statePaths.auditLogPath,
  };
}

function getLocalOverridePath(store: StoreContext): string {
  return join(store.projectStateRoot ?? getProjectStatePaths(store).projectRoot, 'user', 'local-overrides.encrypted');
}

function ensureNoRootFileConflict(ctx: HushContext, root: string): void {
  const hushPath = join(root, '.hush');
  if (ctx.fs.existsSync(hushPath) && !ctx.fs.statSync(hushPath).isDirectory()) {
    throw new Error(`Cannot migrate while ${hushPath} is a file. Remove or rename the legacy plaintext source before creating the v3 .hush/ directory.`);
  }
}

function validateMigrationPrerequisites(ctx: HushContext, root: string, sources: LegacySourceInventory[]): void {
  const hasLegacySourceInputs = sources.some((source) => source.encryptedExists || source.plaintextExists);
  const hasSopsConfig = ctx.fs.existsSync(join(root, '.sops.yaml'));

  if (!hasLegacySourceInputs && !hasSopsConfig) {
    throw new Error(
      `No legacy source files or .sops.yaml were found at ${root}. `
      + 'This looks like a keyless/template-only repo. Use "hush bootstrap" instead of "hush migrate --from v2".',
    );
  }
}

function repairGitignoreForV3(ctx: HushContext, root: string): string[] {
  const gitignorePath = join(root, '.gitignore');
  if (!ctx.fs.existsSync(gitignorePath)) {
    return [];
  }

  const raw = ctx.fs.readFileSync(gitignorePath, 'utf-8');
  const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
  const lines = text.split(/\r?\n/);
  const removedEntries: string[] = [];
  const keptLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed === '.hush' || trimmed === '.hush/') {
      removedEntries.push(trimmed);
      return false;
    }
    return true;
  });

  if (removedEntries.length === 0) {
    return [];
  }

  const nonEmptyLines = keptLines.filter((line, index, arr) => !(index === arr.length - 1 && line === ''));
  if (!nonEmptyLines.some((line) => line.trim() === '.hush-materialized/')) {
    nonEmptyLines.push('.hush-materialized/');
  }

  ctx.fs.writeFileSync(gitignorePath, `${nonEmptyLines.join('\n')}\n`, 'utf-8');
  return removedEntries;
}

function readLegacySourceVars(ctx: HushContext, root: string, source: LegacySourceInventory, keyIdentity: string | undefined): EnvVar[] {
  if (source.encryptedExists) {
    const decrypted = ctx.sops.decrypt(join(root, source.encryptedPath), { root, keyIdentity });
    return interpolateVars(parseEnvContent(decrypted));
  }

  if (source.plaintextExists) {
    const raw = ctx.fs.readFileSync(join(root, source.sourcePath), 'utf-8');
    const content = typeof raw === 'string' ? raw : raw.toString('utf-8');
    return interpolateVars(parseEnvContent(content));
  }

  return [];
}

function assertResolvedLegacyVars(label: string, vars: EnvVar[]): void {
  const unresolved = getUnresolvedVars(vars);
  if (unresolved.length === 0) {
    return;
  }

  throw new Error(
    `Legacy interpolation placeholders remained unresolved while building ${label}: ${unresolved.join(', ')}. `
    + 'Ensure the referenced values exist in the legacy shared/development/production/local sources before migrating.',
  );
}

function buildTargetRuntimeDocument(filePath: string, vars: EnvVar[]): HushFileDocument {
  const entries = Object.fromEntries(vars.map((variable) => [
    `${filePath}/${variable.key}`,
    { value: variable.value, sensitive: true },
  ]));

  return createFileDocument({
    path: filePath,
    readers: {
      roles: ['owner', 'member', 'ci'],
      identities: [],
    },
    sensitive: true,
    entries,
  });
}

function buildManifest(
  inventory: LegacyV2Inventory,
  fileDocuments: HushFileDocument[],
  repositoryFiles: string[],
  targetDefinitions: Record<string, HushTargetDefinition>,
  bundleFiles: Record<string, string>,
  references: MigrationReference[],
): HushManifestDocument {
  return createManifestDocument({
    version: V3_SCHEMA_VERSION,
    identities: {
      'owner-local': { roles: ['owner'], description: 'Default owner identity migrated from v2' },
      'member-local': { roles: ['member'], description: 'Default member identity migrated from v2' },
      ci: { roles: ['ci'], description: 'Default automation identity migrated from v2' },
    },
    fileIndex: Object.fromEntries(fileDocuments.map((document) => [document.path, createFileIndexEntry(document)])),
    bundles: {
      project: {
        files: repositoryFiles.map((path) => ({ path })),
      },
      ...Object.fromEntries(Object.entries(bundleFiles).map(([bundleName, filePath]) => [bundleName, {
        files: [{ path: filePath }],
      }])),
    },
    targets: targetDefinitions,
    metadata: {
      project: inventory.config.project ?? getProjectIdentifier(inventory.projectRoot) ?? inventory.projectRoot,
      legacyMigration: {
        from: 'v2',
        configPath: inventory.configPath,
        targets: inventory.targets.map((target) => ({
          name: target.name,
          path: target.path,
          format: target.format,
          include: target.include ?? [],
          exclude: target.exclude ?? [],
          push_to: target.push_to ? { ...target.push_to } : null,
        })),
        references: references.map((reference) => ({
          file: reference.filePath,
          lines: reference.lines,
        })),
      },
    },
  });
}

function writeMarker(ctx: HushContext, root: string, marker: MigrationMarker): void {
  const markerPath = getMigrationMarkerPath(root);
  ctx.fs.mkdirSync(dirname(markerPath), { recursive: true });
  ctx.fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');
}

function readMarker(ctx: HushContext, root: string): MigrationMarker | null {
  const markerPath = getMigrationMarkerPath(root);
  if (!ctx.fs.existsSync(markerPath)) {
    return null;
  }

  const raw = ctx.fs.readFileSync(markerPath, 'utf-8');
  return JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8')) as MigrationMarker;
}

function printInventory(root: string, inventory: LegacyV2Inventory, sources: LegacySourceInventory[], references: MigrationReference[]): void {
  console.log(pc.bold('Inventory:'));
  console.log(`  Root: ${root}`);
  console.log(`  Config: ${inventory.configPath}`);
  console.log(`  Legacy sources: ${sources.filter((source) => source.encryptedExists || source.plaintextExists).length}/${sources.length} source files found`);
  console.log(`  Legacy targets: ${inventory.targets.length}`);
  console.log(`  Repo refs to review: ${references.length}`);
  for (const source of sources) {
    const locatedPath = source.encryptedExists ? source.encryptedPath : source.plaintextExists ? source.sourcePath : source.encryptedPath;
    const suffix = source.encryptedExists ? '' : source.plaintextExists ? ' (plaintext)' : ' (missing)';
    console.log(`    - ${source.name}: ${locatedPath}${suffix}`);
  }
}

function validateMigratedRepository(ctx: HushContext, store: StoreContext, targetNames: string[]): void {
  const repository = loadV3Repository(store.root, { keyIdentity: store.keyIdentity });

  setActiveIdentity(ctx, {
    store,
    identity: DEFAULT_IDENTITY,
    identities: repository.manifest.identities,
    command: { name: 'migrate', args: ['--from', 'v2'] },
  });

  for (const targetName of targetNames) {
    materializeV3Target(ctx, {
      store,
      repository,
      targetName,
      activeIdentity: DEFAULT_IDENTITY,
      command: { name: 'migrate', args: ['--from', 'v2', '--validate', targetName] },
      mode: 'memory',
      // Validating the migrated repository, not this machine: an override must
      // never be able to make a repository with a missing key look migrated.
      machineLocal: 'exclude',
    }).cleanup();
  }
}

function cleanupMigratedLegacyFiles(ctx: HushContext, root: string, marker: MigrationMarker): string[] {
  const removed: string[] = [];
  for (const relativePath of marker.cleanupCandidates) {
    const fullPath = join(root, relativePath);
    if (!ctx.fs.existsSync(fullPath)) {
      continue;
    }

    ctx.fs.unlinkSync(fullPath);
    removed.push(relativePath);
  }

  const markerPath = getMigrationMarkerPath(root);
  if (ctx.fs.existsSync(markerPath)) {
    ctx.fs.unlinkSync(markerPath);
    removed.push('.hush/migration-v2-state.json');
  }

  return removed;
}

export async function migrateCommand(ctx: HushContext, options: MigrateOptions): Promise<void> {
  const { root, dryRun, from, cleanup } = options;

  if (from !== 'v2') {
    throw new Error('Use "hush migrate --from v2" for the big-bang legacy migration flow.');
  }

  ctx.logger.log(pc.blue('Hush v2 → v3 migration\n'));
  if (dryRun) {
    ctx.logger.log(pc.yellow('DRY RUN - inventory only, no changes will be made\n'));
  }

  const marker = readMarker(ctx, root);
  const manifestPath = getV3ManifestPath(root);
  const v3Exists = ctx.fs.existsSync(manifestPath);

  if (cleanup) {
    if (!marker?.validated) {
      if (v3Exists) {
        ctx.logger.log(pc.dim('No validated v2 cleanup marker found. Nothing to clean.'));
        return;
      }

      throw new Error('Cleanup requires a successful prior "hush migrate --from v2" run.');
    }

    if (dryRun) {
      ctx.logger.log(pc.bold('Cleanup candidates:'));
      for (const candidate of marker.cleanupCandidates) {
        ctx.logger.log(`  - ${candidate}`);
      }
      ctx.logger.log('  - .hush/migration-v2-state.json');
      return;
    }

    const removed = cleanupMigratedLegacyFiles(ctx, root, marker);
    ctx.logger.log(pc.green(pc.bold('Cleanup complete.')));
    if (removed.length === 0) {
      ctx.logger.log(pc.dim('No transitional files remained.'));
    } else {
      for (const item of removed) {
        ctx.logger.log(`  Removed ${item}`);
      }
    }
    return;
  }

  if (v3Exists) {
    ctx.logger.log(pc.dim('This repository already has .hush/ v3 state.'));
    if (marker?.validated) {
      ctx.logger.log(pc.dim('Run "hush migrate --from v2 --cleanup" to remove any remaining legacy files.'));
    }
    return;
  }

  const configPath = ctx.config.findProjectRoot(root)?.configPath;
  if (!configPath) {
    throw new Error(`No legacy hush.yaml repository found at ${root}.`);
  }

  const inventory = loadLegacyV2Inventory(root, configPath);
  const sources = withSourcePresence(ctx, root, getLegacySources(inventory));
  const references = collectCommandReferences(ctx, root);

  printInventory(root, inventory, sources, references);

  if (dryRun) {
    ctx.logger.log('');
    ctx.logger.log(pc.dim('Run without --dry-run to convert this repo to the v3 .hush/ layout.'));
    return;
  }

  ensureNoRootFileConflict(ctx, root);
  validateMigrationPrerequisites(ctx, root, sources);

  const keyIdentity = inventory.config.project ?? getProjectIdentifier(root);
  const store = getRepositoryStore(root, keyIdentity);
  const repoRoot = join(root, '.hush');
  const hadRepoRootBefore = ctx.fs.existsSync(repoRoot);
  const localOverridePath = getLocalOverridePath(store);
  const hadLocalOverrideBefore = ctx.fs.existsSync(localOverridePath);
  const fileDocuments: HushFileDocument[] = [];
  const repositoryFiles: string[] = [];
  const targetDefinitions: Record<string, HushTargetDefinition> = {};
  const bundleFiles: Record<string, string> = {};

  const sharedSource = sources.find((source) => source.name === 'shared')!;
  const developmentSource = sources.find((source) => source.name === 'development')!;
  const productionSource = sources.find((source) => source.name === 'production')!;
  const localSource = sources.find((source) => source.name === 'local')!;
  const sharedVars = readLegacySourceVars(ctx, root, sharedSource, keyIdentity);
  const developmentVars = readLegacySourceVars(ctx, root, developmentSource, keyIdentity);
  const productionVars = readLegacySourceVars(ctx, root, productionSource, keyIdentity);
  const localVars = readLegacySourceVars(ctx, root, localSource, keyIdentity);

  let repairedGitignoreEntries: string[] = [];

  try {
    for (const sourceName of ['shared', 'development', 'production'] as const) {
      const filePath = `env/project/${sourceName}`;
      const vars = sourceName === 'shared' ? sharedVars : sourceName === 'development' ? developmentVars : productionVars;
      const document = createSourceDocument(filePath, vars);
      writeYamlDocument(ctx, root, keyIdentity, getV3EncryptedFilePath(root, filePath), document);
      fileDocuments.push(document);
      repositoryFiles.push(filePath);
    }

    for (const target of inventory.targets) {
      const sanitizedTarget = sanitizeName(target.name);
      const developmentView = filterLegacyVars(interpolateVars(mergeVars(sharedVars, developmentVars, localVars)), target);
      const productionView = filterLegacyVars(interpolateVars(mergeVars(sharedVars, productionVars, localVars)), target);
      assertResolvedLegacyVars(`${target.name} runtime target`, developmentView);
      assertResolvedLegacyVars(`${target.name} production target`, productionView);

      const developmentFilePath = `env/targets/${sanitizedTarget}/runtime`;
      const developmentDocument = buildTargetRuntimeDocument(developmentFilePath, developmentView);
      writeYamlDocument(ctx, root, keyIdentity, getV3EncryptedFilePath(root, developmentFilePath), developmentDocument);
      fileDocuments.push(developmentDocument);

      const developmentBundle = `${sanitizedTarget}-runtime`;
      bundleFiles[developmentBundle] = developmentFilePath;
      targetDefinitions[target.name] = {
        bundle: developmentBundle,
        format: target.format,
        mode: 'process',
      };

      if (productionView.length > 0) {
        const productionFilePath = `env/targets/${sanitizedTarget}/production`;
        const productionDocument = buildTargetRuntimeDocument(productionFilePath, productionView);
        writeYamlDocument(ctx, root, keyIdentity, getV3EncryptedFilePath(root, productionFilePath), productionDocument);
        fileDocuments.push(productionDocument);
        const productionBundle = `${sanitizedTarget}-production`;
        bundleFiles[productionBundle] = productionFilePath;
        targetDefinitions[`${target.name}-production`] = {
          bundle: productionBundle,
          format: target.format,
          mode: 'process',
        };
      }
    }

    if (inventory.targets.length === 0) {
      targetDefinitions.runtime = {
        bundle: 'project',
        format: 'dotenv',
        mode: 'process',
      };
    }

    const manifest = buildManifest(inventory, fileDocuments, repositoryFiles, targetDefinitions, bundleFiles, references);
    writeYamlDocument(ctx, root, keyIdentity, getV3ManifestPath(root), manifest);

    if (localVars.length > 0) {
      const localDocument = createSourceDocument(MACHINE_LOCAL_FILE_PATH, localVars);
      writeYamlDocument(ctx, root, keyIdentity, localOverridePath, localDocument);
    }

    const targetNames = Object.keys(targetDefinitions);
    validateMigratedRepository(ctx, store, targetNames);
    repairedGitignoreEntries = repairGitignoreForV3(ctx, root);

    writeMarker(ctx, root, {
      version: 1,
      source: 'v2',
      validated: true,
      createdAt: new Date().toISOString(),
      configPath: toRelativePath(root, inventory.configPath),
      legacyEncryptedFiles: sources.filter((source) => source.encryptedExists).map((source) => source.encryptedPath),
      cleanupCandidates: [
        toRelativePath(root, inventory.configPath),
        ...sources.filter((source) => source.encryptedExists).map((source) => source.encryptedPath),
      ],
      targetNames,
    });
  } catch (error) {
    if (!hadRepoRootBefore && ctx.fs.existsSync(repoRoot)) {
      ctx.fs.rmSync?.(repoRoot, { recursive: true, force: true });
    }

    if (!hadLocalOverrideBefore && ctx.fs.existsSync(localOverridePath)) {
      ctx.fs.unlinkSync(localOverridePath);
    }

    throw error;
  }

  ctx.logger.log('');
  ctx.logger.log(pc.green(pc.bold('Migration complete.')));
  ctx.logger.log(pc.dim('Created .hush/ manifest and file documents, migrated machine-local overrides, and validated the new v3 repo state.'));
  if (repairedGitignoreEntries.length > 0) {
    ctx.logger.log(pc.yellow(`Updated .gitignore to stop ignoring the v3 .hush/ repo (${repairedGitignoreEntries.join(', ')} removed; .hush-materialized/ kept ignored).`));
  }
  ctx.logger.log(pc.dim('Run "hush migrate --from v2 --cleanup" after you review the migrated repo to remove legacy hush.yaml and encrypted source leftovers.'));
}
