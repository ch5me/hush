import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { copyKeyCommand } from '../src/commands/copy-key.js';
import { deleteKeyCommand } from '../src/commands/delete-key.js';
import { fileCommand } from '../src/commands/file.js';
import { hasCommand } from '../src/commands/has.js';
import { setCommand } from '../src/commands/set.js';
import {
  createProjectSlug,
  createFileDocument,
  createFileIndexEntry,
  createManifestDocument,
  loadV3Repository,
  setActiveIdentity,
} from '../src/index.js';
import { decrypt, decryptYaml, encrypt, encryptYaml, encryptYamlContent, isSopsInstalled, SopsPreflightTimeoutError } from '../src/core/sops.js';
import type { HushContext, HushManifestDocument, LegacyHushConfig, StoreContext } from '../src/types.js';
import { getMachineLocalOverridePath, loadMachineLocalOverrides } from '../src/commands/v3-command-helpers.js';
import { ensureTestSopsEnv, writeEncryptedYamlFile } from './helpers/sops-test.js';

const TEST_DIR = join('/tmp', 'hush-test-set-local-write-verification');

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\u001B\[[0-9;]*m`, 'g'), '');
}

function normalizeYaml(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  while (lines[0] !== undefined && lines[0].trim() === '') lines.shift();
  while (lines.at(-1) !== undefined && lines.at(-1)?.trim() === '') lines.pop();
  const indent = lines
    .filter((line) => line.trim().length > 0)
    .reduce<number>((smallest, line) => Math.min(smallest, line.match(/^\s*/)?.[0].length ?? 0), Number.POSITIVE_INFINITY);
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
}

function createStore(root: string, mode: 'project' | 'global' = 'project'): StoreContext {
  const projectSlug = createProjectSlug(root);
  const stateRoot = join(TEST_DIR, '.machine-state');
  const projectStateRoot = join(stateRoot, 'projects', projectSlug);

  return {
    mode,
    root,
    configPath: null,
    keyIdentity: root,
    displayLabel: root,
    projectSlug,
    stateRoot,
    projectStateRoot,
    activeIdentityPath: join(projectStateRoot, 'active-identity.json'),
    auditLogPath: join(projectStateRoot, 'audit.jsonl'),
  };
}

function createContext(root: string) {
  ensureTestSopsEnv();

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const defaultConfig: LegacyHushConfig = {
    sources: { shared: '.hush', development: '.hush.development', production: '.hush.production', local: '.hush.local' },
    targets: [{ name: 'root', path: '.', format: 'dotenv' }],
  };

  const ctx: HushContext = {
    fs: {
      existsSync: nodeFs.existsSync,
      readFileSync: nodeFs.readFileSync,
      writeFileSync: nodeFs.writeFileSync,
      mkdirSync: nodeFs.mkdirSync,
      readdirSync: nodeFs.readdirSync as HushContext['fs']['readdirSync'],
      unlinkSync: nodeFs.unlinkSync,
      rmSync: nodeFs.rmSync,
      statSync: nodeFs.statSync,
      renameSync: nodeFs.renameSync,
    },
    path: { join },
    exec: { spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })), execSync: vi.fn(() => '') },
    logger,
    process: {
      cwd: () => root,
      exit: (code: number) => { throw new Error(`Process exit: ${code}`); },
      env: { EDITOR: 'true' },
      stdin: {
        isTTY: true,
        setEncoding: vi.fn(),
        on: vi.fn(),
        resume: vi.fn(),
        pause: vi.fn(),
        setRawMode: vi.fn(),
        removeListener: vi.fn(),
      } as unknown as NodeJS.ReadStream,
      stdout: { write: vi.fn() } as unknown as NodeJS.WriteStream,
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    config: { loadConfig: vi.fn(() => defaultConfig), findProjectRoot: vi.fn(() => null) },
    age: {
      ageAvailable: vi.fn(() => true),
      ageGenerate: vi.fn(() => ({ private: 'private', public: 'public' })),
      keyExists: vi.fn(() => false),
      keySave: vi.fn(),
      keyPath: vi.fn(() => ''),
      keyLoad: vi.fn(() => null),
      agePublicFromPrivate: vi.fn(() => 'public'),
    },
    sops: {
      decrypt: vi.fn((p: string, o?: { root?: string; keyIdentity?: string }) => decrypt(p, o)),
      decryptYaml: vi.fn((p: string, o?: { root?: string; keyIdentity?: string }) => decryptYaml(p, o)),
      encrypt: vi.fn((i: string, o: string, opt?: { root?: string; keyIdentity?: string }) => encrypt(i, o, opt)),
      encryptYaml: vi.fn((i: string, o: string, opt?: { root?: string; keyIdentity?: string }) => encryptYaml(i, o, opt)),
      encryptYamlContent: vi.fn((c: string, o: string, opt?: { root?: string; keyIdentity?: string }) => encryptYamlContent(c, o, opt)),
      edit: vi.fn(),
      isSopsInstalled: vi.fn(() => isSopsInstalled()),
    },
  };

  return { ctx, logger };
}

function writeRepo(root: string, manifest: string, files: Record<string, string>) {
  nodeFs.mkdirSync(join(root, '.hush', 'files'), { recursive: true });
  const parsedFiles = Object.values(files).map((content) => createFileDocument(parseYaml(normalizeYaml(content))));
  const manifestDocument = createManifestDocument({
    ...(parseYaml(normalizeYaml(manifest)) as Record<string, unknown>),
    fileIndex: Object.fromEntries(parsedFiles.map((file) => [file.path, createFileIndexEntry(file)])),
  } as HushManifestDocument);
  writeEncryptedYamlFile(root, join(root, '.hush', 'manifest.encrypted'), stringifyYaml(manifestDocument, { indent: 2 }));

  for (const [relativePath, content] of Object.entries(files)) {
    writeEncryptedYamlFile(root, join(root, '.hush', 'files', `${relativePath}.encrypted`), normalizeYaml(content));
  }

  return loadV3Repository(root, { keyIdentity: root });
}

function setIdentity(ctx: HushContext, store: StoreContext, repository: ReturnType<typeof loadV3Repository>, identity: string): void {
  setActiveIdentity(ctx, {
    store,
    identity,
    identities: repository.manifest.identities,
    command: { name: 'config', args: ['active-identity', identity] },
  });
}

const MANIFEST = `
version: 3
identities:
  owner-local:
    roles: [owner]
bundles:
  project:
    files:
      - path: env/project/shared
targets:
  runtime:
    bundle: project
    format: dotenv
`;

const SHARED_FILE = `
path: env/project/shared
readers:
  roles: [owner]
  identities: [owner-local]
sensitive: true
entries: {}
`;

const DECLARED_LOCAL_FILE = `
path: env/project/local
readers:
  roles: [owner]
  identities: [owner-local]
sensitive: true
entries: {}
`;

/**
 * Read the key back through the runtime resolution path, exactly as a later
 * `hush get` / `hush has` would. Returns true only when the value resolves.
 */
async function resolvesThroughRuntime(ctx: HushContext, store: StoreContext, key: string): Promise<boolean> {
  try {
    await hasCommand(ctx, { store, env: 'development', key, quiet: true });
  } catch (error) {
    return (error as Error).message === 'Process exit: 0';
  }
  return false;
}

function getLogOutput(logger: { log: ReturnType<typeof vi.fn> }): string {
  return stripAnsi(logger.log.mock.calls.map(([message]) => String(message)).join('\n'));
}

/**
 * Minimal stdin double that behaves like a pipe (`isTTY` false) and emits the
 * given value, so `hush set KEY` with no inline value takes the piped path.
 */
function createPipedStdin(value: string): NodeJS.ReadStream {
  const handlers = new Map<string, (chunk?: string) => void>();

  return {
    isTTY: false,
    setEncoding: vi.fn(),
    on: vi.fn((event: string, handler: (chunk?: string) => void) => {
      handlers.set(event, handler);
    }),
    resume: vi.fn(() => {
      handlers.get('data')?.(value);
      handlers.get('end')?.();
    }),
    pause: vi.fn(),
    setRawMode: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as NodeJS.ReadStream;
}

describe('set writes to the machine-local store are persisted and verified', () => {
  beforeEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('set --file user/local resolves back through the runtime target view', async () => {
    const root = join(TEST_DIR, 'local-path-form');
    const repository = writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx, logger } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    await setCommand(ctx, { store, file: 'user/local', key: 'LOCAL_PATH_FORM', value: 'value-path-form' });

    expect(getLogOutput(logger)).toContain('LOCAL_PATH_FORM set in user/local');
    await expect(resolvesThroughRuntime(ctx, store, 'LOCAL_PATH_FORM')).resolves.toBe(true);
  }, 60000);

  it('piped stdin value to --file user/local resolves back through the runtime target view', async () => {
    const root = join(TEST_DIR, 'local-stdin-form');
    const repository = writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    // `hush set KEY --file user/local` with no inline value reads the value
    // from a stdin pipe (isTTY false).
    const pipedStdin = createPipedStdin('value-from-stdin');
    const contextWithPipe: HushContext = { ...ctx, process: { ...ctx.process, stdin: pipedStdin } };

    await setCommand(contextWithPipe, { store, file: 'user/local', key: 'LOCAL_STDIN_FORM' });

    await expect(resolvesThroughRuntime(ctx, store, 'LOCAL_STDIN_FORM')).resolves.toBe(true);
  }, 60000);

  it('set --file local (alias form) resolves back through the runtime target view', async () => {
    const root = join(TEST_DIR, 'local-alias-form');
    const repository = writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    await setCommand(ctx, { store, file: 'local', key: 'LOCAL_ALIAS_FORM', value: 'value-alias-form' });

    await expect(resolvesThroughRuntime(ctx, store, 'LOCAL_ALIAS_FORM')).resolves.toBe(true);
  }, 60000);

  it('set --repo-local resolves back in global store mode', async () => {
    // Regression: loadMachineLocalOverrides used to return null for global
    // stores while writeMachineLocalOverrides still persisted, so every
    // `hush set --global --repo-local` reported success and stored nothing
    // any read path would ever consult.
    const root = join(TEST_DIR, 'global-local');
    const repository = writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx } = createContext(root);
    const store = createStore(root, 'global');
    setIdentity(ctx, store, repository, 'owner-local');

    await setCommand(ctx, { store, repoLocal: true, key: 'GLOBAL_LOCAL_KEY', value: 'value-global-local' });

    await expect(resolvesThroughRuntime(ctx, store, 'GLOBAL_LOCAL_KEY')).resolves.toBe(true);
  }, 60000);

  it('warns instead of reporting a clean success when the written file is not selected by the target', async () => {
    // A declared repository file at env/project/local that no bundle includes
    // is a legitimate write, but `hush get` will never return it. The success
    // line must be accompanied by an explicit warning rather than implying the
    // value is live.
    const root = join(TEST_DIR, 'declared-but-unbundled-local');
    const repository = writeRepo(root, MANIFEST, {
      'env/project/shared': SHARED_FILE,
      'env/project/local': DECLARED_LOCAL_FILE,
    });
    const { ctx, logger } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    await setCommand(ctx, { store, file: 'env/project/local', key: 'UNBUNDLED_KEY', value: 'value-unbundled' });

    const warnings = stripAnsi(logger.warn.mock.calls.map(([message]) => String(message)).join('\n'));
    expect(warnings).toContain('UNBUNDLED_KEY is stored in env/project/local');
    expect(warnings).toContain('does not resolve that file');
  }, 60000);

  it('does not warn when the written file is selected by the target', async () => {
    const root = join(TEST_DIR, 'declared-and-bundled-local');
    const repository = writeRepo(root, `
      version: 3
      identities:
        owner-local:
          roles: [owner]
      bundles:
        project:
          files:
            - path: env/project/shared
            - path: env/project/local
      targets:
        runtime:
          bundle: project
          format: dotenv
    `, {
      'env/project/shared': SHARED_FILE,
      'env/project/local': DECLARED_LOCAL_FILE,
    });
    const { ctx, logger } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    await setCommand(ctx, { store, file: 'env/project/local', key: 'BUNDLED_KEY', value: 'value-bundled' });

    const warnings = stripAnsi(logger.warn.mock.calls.map(([message]) => String(message)).join('\n'));
    expect(warnings).not.toContain('BUNDLED_KEY is stored in');
    await expect(resolvesThroughRuntime(ctx, store, 'BUNDLED_KEY')).resolves.toBe(true);
  }, 60000);

  it('fails loud instead of reporting success when a machine-local write does not persist', async () => {
    const root = join(TEST_DIR, 'unpersisted-local-write');
    const repository = writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx, logger } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    const overridePath = getMachineLocalOverridePath(store);
    const realEncryptYamlContent = ctx.sops.encryptYamlContent;
    ctx.sops.encryptYamlContent = vi.fn((content: string, outputPath: string, options?: { root?: string; keyIdentity?: string }) => {
      // Simulate a broken write path that silently drops the document.
      if (outputPath === overridePath) {
        return;
      }
      return realEncryptYamlContent(content, outputPath, options);
    });

    await expect(
      setCommand(ctx, { store, repoLocal: true, key: 'DROPPED_KEY', value: 'value-dropped' }),
    ).rejects.toThrow(/Write verification failed for DROPPED_KEY in user\/local \(machine-local\)/);

    expect(getLogOutput(logger)).not.toContain('DROPPED_KEY set in');
  }, 60000);

  it('fails loud instead of reporting success when a repository write does not persist', async () => {
    const root = join(TEST_DIR, 'unpersisted-repo-write');
    const repository = writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx, logger } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    const sharedSystemPath = join(root, '.hush', 'files', 'env', 'project', 'shared.encrypted');
    const realEncryptYamlContent = ctx.sops.encryptYamlContent;
    ctx.sops.encryptYamlContent = vi.fn((content: string, outputPath: string, options?: { root?: string; keyIdentity?: string }) => {
      if (outputPath === sharedSystemPath) {
        return;
      }
      return realEncryptYamlContent(content, outputPath, options);
    });

    await expect(
      setCommand(ctx, { store, file: 'shared', key: 'DROPPED_SHARED_KEY', value: 'value-dropped-shared' }),
    ).rejects.toThrow(/Write verification failed for DROPPED_SHARED_KEY in env\/project\/shared \(repository\)/);

    expect(getLogOutput(logger)).not.toContain('DROPPED_SHARED_KEY set in');
  }, 60000);

  it('never includes the secret value in a write-verification error', async () => {
    const root = join(TEST_DIR, 'no-secret-leak');
    const repository = writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    const overridePath = getMachineLocalOverridePath(store);
    const realEncryptYamlContent = ctx.sops.encryptYamlContent;
    ctx.sops.encryptYamlContent = vi.fn((content: string, outputPath: string, options?: { root?: string; keyIdentity?: string }) => {
      if (outputPath === overridePath) {
        return;
      }
      return realEncryptYamlContent(content, outputPath, options);
    });

    const canaryValue = 'canary-secret-must-not-appear';
    await expect(
      setCommand(ctx, { store, repoLocal: true, key: 'CANARY_KEY', value: canaryValue }),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(canaryValue) }) as Error,
    );
  }, 60000);
});

describe('storage class is named by the path, never by manifest state', () => {
  beforeEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('rejects undeclared env/project/local instead of silently writing machine-local', async () => {
    const root = join(TEST_DIR, 'undeclared-legacy-path');
    const repository = writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    await expect(
      setCommand(ctx, { store, file: 'env/project/local', key: 'AMBIGUOUS_KEY', value: 'value-ambiguous' }),
    ).rejects.toThrow(/no longer an alias for machine-local storage/);

    // The silent fallback is what made the old behavior dangerous: nothing may
    // reach the machine-local store on a rejected repository selector.
    expect(nodeFs.existsSync(getMachineLocalOverridePath(store))).toBe(false);
  }, 60000);

  it('keeps writing a declared env/project/local to the repository file', async () => {
    const root = join(TEST_DIR, 'declared-legacy-path');
    const repository = writeRepo(root, MANIFEST, {
      'env/project/shared': SHARED_FILE,
      'env/project/local': DECLARED_LOCAL_FILE,
    });
    const { ctx } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    await setCommand(ctx, { store, file: 'env/project/local', key: 'DECLARED_KEY', value: 'value-declared' });

    const repositoryFile = decryptYaml(join(root, '.hush', 'files', 'env', 'project', 'local.encrypted'), { root, keyIdentity: root });
    expect(repositoryFile).toContain('env/project/local/DECLARED_KEY');
    expect(nodeFs.existsSync(getMachineLocalOverridePath(store))).toBe(false);
  }, 60000);

  it('warns that a committed file named local is repository storage, not machine-local', async () => {
    const root = join(TEST_DIR, 'legacy-local-warning');
    const repository = writeRepo(root, MANIFEST, {
      'env/project/shared': SHARED_FILE,
      'env/project/local': DECLARED_LOCAL_FILE,
    });
    const { ctx, logger } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    await setCommand(ctx, { store, file: 'env/project/local', key: 'WARNED_KEY', value: 'value-warned' });

    const warnings = stripAnsi(logger.warn.mock.calls.map(([message]) => String(message)).join('\n'));
    expect(warnings).toContain('is a committed repository file, not machine-local storage');
    expect(warnings).toContain('rotate it');
  }, 60000);

  it('does not let a declared env/project/local collide with the machine-local store', async () => {
    // Both stores used to key entries `env/project/local/KEY`, so a machine
    // override silently shadowed the committed file under one logical path.
    const root = join(TEST_DIR, 'no-logical-path-collision');
    const repository = writeRepo(root, MANIFEST, {
      'env/project/shared': SHARED_FILE,
      'env/project/local': DECLARED_LOCAL_FILE,
    });
    const { ctx } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    await setCommand(ctx, { store, file: 'env/project/local', key: 'SHADOWED_KEY', value: 'repository-value' });
    await setCommand(ctx, { store, repoLocal: true, key: 'SHADOWED_KEY', value: 'machine-value' });

    const repositoryFile = decryptYaml(join(root, '.hush', 'files', 'env', 'project', 'local.encrypted'), { root, keyIdentity: root });
    const machineLocal = decryptYaml(getMachineLocalOverridePath(store), { root, keyIdentity: root });

    expect(repositoryFile).toContain('env/project/local/SHADOWED_KEY');
    expect(machineLocal).toContain('user/local/SHADOWED_KEY');
    expect(machineLocal).not.toContain('env/project/local/SHADOWED_KEY');
  }, 60000);

  it('reads a legacy machine-local store written before the user/ split', async () => {
    const root = join(TEST_DIR, 'legacy-machine-local-store');
    const repository = writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    // Seed the store exactly as pre-8.0 hush persisted it.
    const overridePath = getMachineLocalOverridePath(store);
    nodeFs.mkdirSync(join(overridePath, '..'), { recursive: true });
    writeEncryptedYamlFile(root, overridePath, normalizeYaml(`
      path: env/project/local
      readers:
        roles: [owner, member, ci]
        identities: []
      sensitive: true
      entries:
        env/project/local/LEGACY_KEY:
          value: legacy-value
          sensitive: true
    `));

    await expect(resolvesThroughRuntime(ctx, store, 'LEGACY_KEY')).resolves.toBe(true);

    // Writing rewrites the label onto user/local without losing the entry.
    await setCommand(ctx, { store, repoLocal: true, key: 'NEW_KEY', value: 'new-value' });
    const rewritten = decryptYaml(overridePath, { root, keyIdentity: root });
    expect(rewritten).toContain('path: user/local');
    expect(rewritten).toContain('user/local/LEGACY_KEY');
    expect(rewritten).toContain('user/local/NEW_KEY');
    expect(rewritten).not.toContain('env/project/local/');
  }, 60000);

  it('refuses to declare a repository file in the reserved user/ namespace', async () => {
    const root = join(TEST_DIR, 'reserved-namespace');
    const repository = writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    await expect(
      fileCommand(ctx, { store, subcommand: 'add', path: 'user/local' }),
    ).rejects.toThrow(/reserved "user\/" namespace/);

    await expect(
      fileCommand(ctx, { store, subcommand: 'add', path: 'user/anything-else' }),
    ).rejects.toThrow(/reserved "user\/" namespace/);
  }, 60000);

  it('never lets copy-key reach the machine-local store', async () => {
    const root = join(TEST_DIR, 'key-transfer-fail-closed');
    const repository = writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    await expect(
      copyKeyCommand(ctx, { store, key: 'ANY_KEY', from: 'env/project/shared', to: 'user/local', move: false }),
    ).rejects.toThrow(/reserved "user\/" namespace/);
  }, 60000);

  /**
   * `delete-key` REACHES the machine-local store on purpose; `copy-key` still
   * does not.
   *
   * The asymmetry is deliberate. Copying INTO the machine-local store creates a
   * shadowing override, which is the hazard. Deleting FROM it removes one — and
   * that removal is the remediation the shadow guard prints, so it has to exist
   * as a runnable command. It previously did not: `--from user/local` was
   * refused here, leaving an interactive `hush edit --file local` as the only
   * way to clear an override.
   *
   * "Not found" (rather than a namespace refusal) is the proof that the command
   * reached the machine-local store and looked.
   */
  it('lets delete-key target the machine-local store, without reinterpreting selectors', async () => {
    const root = join(TEST_DIR, 'delete-key-machine-local');
    const repository = writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx } = createContext(root);
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'owner-local');

    for (const from of ['user/local', 'local']) {
      await expect(
        deleteKeyCommand(ctx, { store, key: 'ANY_KEY', from, yes: true }),
      ).rejects.toThrow(/was not found in user\/local/);
    }

    // Any OTHER reserved-namespace path is still refused: an explicit selector
    // is never widened into "some machine-local file".
    await expect(
      deleteKeyCommand(ctx, { store, key: 'ANY_KEY', from: 'user/anything-else', yes: true }),
    ).rejects.toThrow(/reserved "user\/" namespace/);
  }, 60000);

  /**
   * Regression for the 2026-07-25 chrislaptop delivery failure: a starved
   * `sops --version` preflight surfaced as "Invalid machine-local override file
   * at .../local-overrides.encrypted", so `ch5-managed-runtime ensure
   * ch5-devtools` looked like file corruption for hours. An environment failure
   * must keep its own diagnosis instead of being relabeled a bad file.
   */
  it('reports a sops preflight timeout as itself, not as a corrupt machine-local override file', () => {
    const root = join(TEST_DIR, 'preflight-timeout-attribution');
    writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx } = createContext(root);
    const store = createStore(root);

    const overridePath = getMachineLocalOverridePath(store);
    nodeFs.mkdirSync(join(overridePath, '..'), { recursive: true });
    nodeFs.writeFileSync(overridePath, 'placeholder\n', 'utf-8');

    const preflightFailure = new SopsPreflightTimeoutError(20_000, 2);
    const ctxWithWedgedSops: HushContext = {
      ...ctx,
      sops: { ...ctx.sops, decryptYaml: () => { throw preflightFailure; } },
    };

    expect(() => loadMachineLocalOverrides(ctxWithWedgedSops, store)).toThrow(SopsPreflightTimeoutError);
    try {
      loadMachineLocalOverrides(ctxWithWedgedSops, store);
    } catch (error) {
      expect(error).toBe(preflightFailure);
      expect((error as Error).message).not.toMatch(/Invalid machine-local override file/);
    }
  }, 60000);

  it('still reports a genuinely corrupt machine-local override file as a bad file', () => {
    const root = join(TEST_DIR, 'corrupt-override-attribution');
    writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
    const { ctx } = createContext(root);
    const store = createStore(root);

    const overridePath = getMachineLocalOverridePath(store);
    nodeFs.mkdirSync(join(overridePath, '..'), { recursive: true });
    nodeFs.writeFileSync(overridePath, 'placeholder\n', 'utf-8');

    const ctxWithBadFile: HushContext = {
      ...ctx,
      sops: { ...ctx.sops, decryptYaml: () => 'not: [a, valid, document' },
    };

    expect(() => loadMachineLocalOverrides(ctxWithBadFile, store)).toThrow(
      /Invalid machine-local override file/,
    );
  }, 60000);
});
