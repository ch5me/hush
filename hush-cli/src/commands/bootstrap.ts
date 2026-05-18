import { basename, dirname, resolve } from 'node:path';
import pc from 'picocolors';
import { stringify as stringifyYaml } from 'yaml';
import type { BootstrapOptions, HushContext, HushV3Repository, StoreContext } from '../types.js';
import {
  V3_SCHEMA_VERSION,
  createFileDocument,
  createManifestDocument,
  getActiveIdentity,
  getV3EncryptedFilePath,
  getV3ManifestPath,
  loadV3Repository,
  setActiveIdentity,
} from '../index.js';
import { getProjectIdentifier } from '../project.js';
import { GLOBAL_STORE_KEY_IDENTITY } from '../store.js';
import { resolveStoreContext } from '../store.js';
import { findProjectRoot, isV3RepositoryRoot } from '../config/loader.js';

interface KeySetupResult {
  publicKey: string;
  source: 'existing' | 'generated';
}

const DEFAULT_SHARED_FILE_PATH = 'env/project/shared';
const DEFAULT_ACTIVE_IDENTITY = 'owner-local';

function tryExistingLocalKey(ctx: HushContext, project: string): KeySetupResult | null {
  if (!ctx.age.keyExists(project)) {
    return null;
  }

  const existing = ctx.age.keyLoad(project);
  if (!existing) {
    return null;
  }

  ctx.logger.log(pc.green(`Using existing key for ${pc.cyan(project)}`));
  return { publicKey: existing.public, source: 'existing' };
}

function generateLocalKey(ctx: HushContext, project: string): KeySetupResult {
  if (!ctx.age.ageAvailable()) {
    throw new Error('age is not installed. Install it before bootstrapping a v3 repository.');
  }

  ctx.logger.log(pc.blue(`Generating new key for ${pc.cyan(project)}...`));
  const key = ctx.age.ageGenerate();
  ctx.age.keySave(project, key);
  ctx.logger.log(pc.green(`Saved to ${ctx.age.keyPath(project)}`));

  return { publicKey: key.public, source: 'generated' };
}

function resolveBootstrapProjectIdentity(root: string, keyIdentity: string | undefined, mode: 'project' | 'global'): string {
  if (mode === 'global') {
    return GLOBAL_STORE_KEY_IDENTITY;
  }

  if (keyIdentity) {
    return keyIdentity;
  }

  const detectedProject = getProjectIdentifier(root);
  if (detectedProject) {
    return detectedProject;
  }

  return basename(root) || 'hush-project';
}

async function setupKey(ctx: HushContext, project: string): Promise<KeySetupResult> {
  return (
    tryExistingLocalKey(ctx, project)
    ?? generateLocalKey(ctx, project)
  );
}

function createSopsConfig(ctx: HushContext, root: string, publicKey: string): void {
  const sopsPath = ctx.path.join(root, '.sops.yaml');
  if (ctx.fs.existsSync(sopsPath)) {
    ctx.logger.log(pc.dim('Keeping existing .sops.yaml'));
    return;
  }

  const sopsConfig = stringifyYaml({
    creation_rules: [{ encrypted_regex: '.*', age: publicKey }],
  });

  ctx.fs.writeFileSync(sopsPath, sopsConfig, 'utf-8');
  ctx.logger.log(pc.green('Created .sops.yaml'));
}

function writeYamlDocument(ctx: HushContext, root: string, keyIdentity: string, filePath: string, document: unknown): void {
  ctx.fs.mkdirSync(dirname(filePath), { recursive: true });
  ctx.sops.encryptYamlContent(stringifyYaml(document, { indent: 2 }), filePath, {
    root,
    keyIdentity,
  });
}

function ensureManifestShell(ctx: HushContext, root: string, projectIdentity: string): boolean {
  const manifestPath = getV3ManifestPath(root);
  if (ctx.fs.existsSync(manifestPath)) {
    return false;
  }

  const manifest = createManifestDocument({
    version: V3_SCHEMA_VERSION,
    identities: {
      'owner-local': {
        roles: ['owner'],
        description: 'Default owner identity for local operators',
      },
      'member-local': {
        roles: ['member'],
        description: 'Default member identity for local operators',
      },
      ci: {
        roles: ['ci'],
        description: 'Default automation identity',
      },
    },
    fileIndex: {
      [DEFAULT_SHARED_FILE_PATH]: {
        path: DEFAULT_SHARED_FILE_PATH,
        readers: {
          roles: ['owner', 'member', 'ci'],
          identities: [],
        },
        sensitive: true,
        logicalPaths: [],
      },
    },
    bundles: {
      project: {
        files: [{ path: DEFAULT_SHARED_FILE_PATH }],
      },
    },
    targets: {
      runtime: {
        bundle: 'project',
        format: 'dotenv',
        mode: 'process',
      },
      example: {
        bundle: 'project',
        format: 'dotenv',
        mode: 'example',
      },
    },
    metadata: {
      project: projectIdentity,
    },
  });

  writeYamlDocument(ctx, root, projectIdentity, manifestPath, manifest);
  ctx.logger.log(pc.green('Created .hush/manifest.encrypted'));
  return true;
}

function ensureSharedFileShell(ctx: HushContext, root: string, projectIdentity: string): boolean {
  const sharedFilePath = getV3EncryptedFilePath(root, DEFAULT_SHARED_FILE_PATH);
  if (ctx.fs.existsSync(sharedFilePath)) {
    return false;
  }

  const sharedFile = createFileDocument({
    path: DEFAULT_SHARED_FILE_PATH,
    readers: {
      roles: ['owner', 'member', 'ci'],
      identities: [],
    },
    sensitive: true,
    entries: {},
  });

  writeYamlDocument(ctx, root, projectIdentity, sharedFilePath, sharedFile);
  ctx.logger.log(pc.green('Created .hush/files/env/project/shared.encrypted'));
  return true;
}

function resolveBootstrapStore(store: StoreContext, root: string): StoreContext {
  if (store.mode === 'global') {
    return store;
  }

  return resolveStoreContext(root, store.mode, {
    explicitRoot: root,
    ignoreAncestors: true,
  });
}

function persistActiveIdentity(
  ctx: HushContext,
  repository: HushV3Repository,
  store: StoreContext,
  nextIdentity: string,
): void {
  setActiveIdentity(ctx, {
    store,
    identity: nextIdentity,
    identities: repository.manifest.identities,
    command: { name: 'bootstrap', args: [] },
  });
}

function ensureActiveIdentity(
  ctx: HushContext,
  repository: HushV3Repository,
  options: BootstrapOptions,
  resolvedStore: StoreContext,
  forceDefaultIdentity: boolean,
): string {
  const currentIdentity = forceDefaultIdentity
    ? null
    : getActiveIdentity(ctx, resolvedStore) ?? getActiveIdentity(ctx, options.store);

  if (currentIdentity && repository.manifest.identities[currentIdentity]) {
    persistActiveIdentity(ctx, repository, resolvedStore, currentIdentity);
    if (resolvedStore.activeIdentityPath !== options.store.activeIdentityPath) {
      persistActiveIdentity(ctx, repository, options.store, currentIdentity);
    }
    return currentIdentity;
  }

  const nextIdentity = repository.manifest.identities[DEFAULT_ACTIVE_IDENTITY]
    ? DEFAULT_ACTIVE_IDENTITY
    : Object.keys(repository.manifest.identities)[0];

  if (!nextIdentity) {
    throw new Error('Bootstrapped repository is missing declared identities.');
  }

  persistActiveIdentity(ctx, repository, resolvedStore, nextIdentity);
  if (resolvedStore.activeIdentityPath !== options.store.activeIdentityPath) {
    persistActiveIdentity(ctx, repository, options.store, nextIdentity);
  }

  return nextIdentity;
}

function findGitRoot(startDir: string, ctx: HushContext): string | null {
  let current = resolve(startDir);
  while (true) {
    if (ctx.fs.existsSync(ctx.path.join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function readLine(ctx: HushContext): Promise<string> {
  return new Promise((resolve) => {
    const { stdin } = ctx.process;
    stdin.resume();
    stdin.setEncoding('utf-8');
    stdin.once('data', (data: string) => {
      stdin.pause();
      resolve(data.toString());
    });
  });
}

async function verifyBootstrap(
  ctx: HushContext,
  root: string,
  projectIdentity: string,
  store: StoreContext,
): Promise<void> {
  ctx.logger.log('');
  ctx.logger.log(pc.blue('━'.repeat(50)));
  ctx.logger.log(pc.blue(pc.bold('  Bootstrap Verification')));
  ctx.logger.log(pc.blue('━'.repeat(50)));
  ctx.logger.log('');

  let allPassed = true;

  // Check 1: hush status — can load the repo
  try {
    const manifestPath = getV3ManifestPath(root);
    const manifestContent = ctx.sops.decryptYaml(manifestPath, { root, keyIdentity: projectIdentity });
    if (manifestContent && manifestContent.length > 0) {
      ctx.logger.log(pc.green(`  ✓  hush status — manifest decrypts`));
    } else {
      ctx.logger.log(pc.red(`  ✗  hush status — manifest is empty`));
      allPassed = false;
    }
  } catch (error) {
    ctx.logger.log(pc.red(`  ✗  hush status — failed: ${(error as Error).message}`));
    allPassed = false;
  }

  // Check 2: hush inspect — can decrypt files
  try {
    const filePath = getV3EncryptedFilePath(root, 'env/project/shared');
    if (ctx.fs.existsSync(filePath)) {
      const activeIdentity = getActiveIdentity(ctx, store);
      if (!activeIdentity) {
        throw new Error('Active identity was not persisted for the bootstrapped project state');
      }

      const repository = loadV3Repository(root, { keyIdentity: projectIdentity });
      if (!repository.manifest.identities[activeIdentity]) {
        throw new Error(`Active identity "${activeIdentity}" is not declared in the bootstrapped repository`);
      }

      repository.loadFile(DEFAULT_SHARED_FILE_PATH);
      ctx.logger.log(pc.green('  ✓  hush inspect — shared file decrypts'));
    } else {
      ctx.logger.log(pc.red('  ✗  hush inspect — shared file not found'));
      allPassed = false;
    }
  } catch (error) {
    ctx.logger.log(pc.red(`  ✗  hush inspect — failed: ${(error as Error).message}`));
    allPassed = false;
  }

  // Check 3: runtime key resolution (non-blocking)
  try {
    const { resolveAgeKeySource } = await import('../core/sops.js');
    const resolution = resolveAgeKeySource({ root, keyIdentity: projectIdentity });
    if (resolution.selectedKeySource) {
      ctx.logger.log(pc.green(`  ✓  Key resolution — using ${resolution.selectedKeySource}`));
    } else if (process.env.SOPS_AGE_KEY_FILE || process.env.SOPS_AGE_KEY) {
      ctx.logger.log(pc.green('  ✓  Key resolution — explicit SOPS env var set'));
    } else {
      ctx.logger.log(pc.yellow('  ⚠  Key resolution — no key found (run "hush keys setup")'));
    }
  } catch {
    ctx.logger.log(pc.yellow('  ⚠  Key resolution — skipped (non-standard environment)'));
  }

  ctx.logger.log('');
  if (allPassed) {
    ctx.logger.log(pc.green(pc.bold('  All checks passed. Repository is ready for use.')));
  } else {
    ctx.logger.log(pc.red(pc.bold('  Some checks failed. Run "hush doctor" for diagnostics.')));
  }
  ctx.logger.log(pc.blue('━'.repeat(50)));
  ctx.logger.log('');
}

export async function bootstrapCommand(ctx: HushContext, options: BootstrapOptions): Promise<void> {
  const cwd = ctx.process.cwd();
  const startDir = options.explicitRoot ? resolve(options.explicitRoot) : cwd;

  const gitRoot = findGitRoot(startDir, ctx);
  const parentDiscovery = options.newRepo ? null : findProjectRoot(startDir);
  const parentRoot = parentDiscovery?.projectRoot ?? null;

  if (options.newRepo && isV3RepositoryRoot(startDir)) {
    ctx.logger.error(pc.red(`A Hush repository already exists at ${startDir}.`));
    ctx.logger.error(pc.dim('Remove .hush/ and .sops.yaml first, or run without --new-repo.'));
    ctx.process.exit(1);
  }

  const reason = parentRoot
    ? 'nearest parent .hush/ was found'
    : 'no parent Hush repository found; using current directory';

  const effectiveRoot = options.newRepo ? startDir : (parentRoot ?? startDir);

  ctx.logger.log(pc.blue('Hush bootstrap plan'));
  ctx.logger.log(pc.dim(`  Current directory:  ${cwd}`));
  ctx.logger.log(pc.dim(`  Detected git root:  ${gitRoot ?? '(none)'}`));
  if (parentRoot) {
    ctx.logger.log(pc.dim(`  Detected parent Hush repo:  ${parentRoot}`));
  }
  ctx.logger.log(pc.dim(`  Selected repository root:  ${effectiveRoot}`));
  ctx.logger.log(pc.dim(`  Reason:  ${options.newRepo ? '--new-repo flag; forcing child-local repo' : reason}`));
  ctx.logger.log('');

  if (!options.yes) {
    const isInteractive = ctx.process.stdin.isTTY;
    if (!isInteractive) {
      ctx.logger.error(pc.red('Non-interactive mode: bootstrap requires --yes (-y) when a plan is displayed.'));
      ctx.logger.error(pc.dim('Run: hush bootstrap --yes'));
      ctx.process.exit(1);
    }

    ctx.logger.log(pc.bold('Proceed with bootstrap?'));
    ctx.logger.log(pc.dim('  This will create encrypted repository files.'));
    ctx.logger.log(pc.dim('  Type "yes" to confirm, or anything else to abort.'));
    ctx.logger.log('');

    const answer = await readLine(ctx);
    if (answer.trim().toLowerCase() !== 'yes') {
      ctx.logger.log(pc.yellow('Bootstrap cancelled.'));
      ctx.process.exit(0);
    }
  }

  if (!ctx.fs.existsSync(effectiveRoot)) {
    ctx.fs.mkdirSync(effectiveRoot, { recursive: true });
  }

  ctx.logger.log(pc.blue('\nBootstrapping Hush v3...\n'));

  const projectIdentity = resolveBootstrapProjectIdentity(effectiveRoot, options.store.keyIdentity, options.store.mode);
  const keyResult = await setupKey(ctx, projectIdentity);

  createSopsConfig(ctx, effectiveRoot, keyResult.publicKey);
  const createdManifestShell = ensureManifestShell(ctx, effectiveRoot, projectIdentity);
  const createdSharedFileShell = ensureSharedFileShell(ctx, effectiveRoot, projectIdentity);

  const repository = loadV3Repository(effectiveRoot, { keyIdentity: projectIdentity });
  const resolvedStore = resolveBootstrapStore(options.store, effectiveRoot);
  const activeIdentity = ensureActiveIdentity(
    ctx,
    repository,
    options,
    resolvedStore,
    createdManifestShell || createdSharedFileShell,
  );

  ctx.logger.log(pc.bold('\nBootstrap summary:'));
  ctx.logger.log(pc.dim(`  Key identity: ${projectIdentity}`));
  ctx.logger.log(pc.dim(`  Key source: ${keyResult.source}`));
  ctx.logger.log(pc.dim(`  Active identity: ${activeIdentity}`));
  ctx.logger.log(pc.dim(`  Bundle shells: ${Object.keys(repository.manifest.bundles ?? {}).join(', ') || '(none)'}`));
  ctx.logger.log(pc.dim(`  Target shells: ${Object.keys(repository.manifest.targets ?? {}).join(', ') || '(none)'}`));

  try {
    await verifyBootstrap(ctx, effectiveRoot, projectIdentity, resolvedStore);
  } catch {
    ctx.logger.log(pc.yellow('Verification skipped (non-critical).'));
  }

  ctx.logger.log(pc.bold('\nNext steps:'));
  ctx.logger.log(pc.dim('  1. hush config show'));
  ctx.logger.log(pc.dim('  2. hush config active-identity member-local'));
  ctx.logger.log(pc.dim('  3. hush config readers env/project/shared --roles owner,member,ci'));
}
