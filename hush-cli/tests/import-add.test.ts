/**
 * Tests for `hush import add` (Feature #2 — ergonomic import composition command).
 *
 * Strategy:
 * - Creates two isolated temp-dir repos: a "source" (acts as external global store)
 *   and a "target" (the project repo the command is run against).
 * - Runs importAddCommand and inspects the written manifest.
 * - Never touches real ~/.hush; all paths are temp dirs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { importAddCommand } from '../src/commands/import.js';
import {
  createFileDocument,
  createFileIndexEntry,
  createManifestDocument,
  createProjectSlug,
  loadV3Repository,
  setActiveIdentity,
} from '../src/index.js';
import {
  decrypt,
  decryptYaml,
  encrypt,
  encryptYaml,
  encryptYamlContent,
  isSopsInstalled,
} from '../src/core/sops.js';
import type { HushContext, HushManifestDocument, LegacyHushConfig, StoreContext } from '../src/types.js';
import { ensureTestSopsEnv, writeEncryptedYamlFile } from './helpers/sops-test.js';

const TEST_DIR = join('/tmp', 'hush-test-import-add');

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\[[0-9;]*m`, 'g'), '');
}

function createStore(root: string): StoreContext {
  const projectSlug = createProjectSlug(root);
  const stateRoot = join(TEST_DIR, '.machine-state');
  const projectStateRoot = join(stateRoot, 'projects', projectSlug);

  return {
    mode: 'project',
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

  const logger = {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };

  const defaultConfig: LegacyHushConfig = {
    sources: {
      shared: '.hush',
      development: '.hush.development',
      production: '.hush.production',
      local: '.hush.local',
    },
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
    exec: {
      spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
      execSync: vi.fn(() => ''),
    },
    logger,
    process: {
      cwd: () => root,
      exit: (code: number) => {
        throw new Error(`Process exit: ${code}`);
      },
      env: process.env,
      stdin: process.stdin,
      stdout: process.stdout,
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    config: {
      loadConfig: vi.fn(() => defaultConfig),
      findProjectRoot: vi.fn(() => null),
    },
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
      decrypt: vi.fn((filePath: string, options?: { root?: string; keyIdentity?: string }) => decrypt(filePath, options)),
      decryptYaml: vi.fn((filePath: string, options?: { root?: string; keyIdentity?: string }) => decryptYaml(filePath, options)),
      encrypt: vi.fn((inputPath: string, outputPath: string, options?: { root?: string; keyIdentity?: string }) => encrypt(inputPath, outputPath, options)),
      encryptYaml: vi.fn((inputPath: string, outputPath: string, options?: { root?: string; keyIdentity?: string }) => encryptYaml(inputPath, outputPath, options)),
      encryptYamlContent: vi.fn((content: string, outputPath: string, options?: { root?: string; keyIdentity?: string }) => encryptYamlContent(content, outputPath, options)),
      edit: vi.fn(),
      isSopsInstalled: vi.fn(() => isSopsInstalled()),
    },
  };

  return { ctx, logger, store: createStore(root) };
}

function normalizeYaml(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  while (lines[0]?.trim() === '') lines.shift();
  while (lines.at(-1)?.trim() === '') lines.pop();
  const indent = lines
    .filter((line) => line.trim().length > 0)
    .reduce<number>((smallest, line) => {
      const match = line.match(/^\s*/);
      return Math.min(smallest, match?.[0].length ?? 0);
    }, Number.POSITIVE_INFINITY);
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
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
    const filePath = join(root, '.hush', 'files', `${relativePath}.encrypted`);
    writeEncryptedYamlFile(root, filePath, normalizeYaml(content));
  }

  return loadV3Repository(root, { keyIdentity: root });
}

const BASE_MANIFEST = `
  version: 3
  identities:
    owner-local:
      roles:
        - owner
      description: Default owner identity
  bundles:
    project:
      files:
        - path: env/project/shared
  targets:
    runtime:
      bundle: project
      format: dotenv
      mode: process
  metadata:
    project: test-project
`;

const BASE_FILE = `
  version: 3
  path: env/project/shared
  readers:
    roles:
      - owner
    identities: []
  sensitive: true
  entries: {}
`;

describe('importAddCommand', () => {
  let tempDir: string;
  let sourceRoot: string;
  let targetRoot: string;

  beforeEach(() => {
    ensureTestSopsEnv();
    tempDir = `/tmp/hush-test-import-add-${Date.now()}`;
    sourceRoot = join(tempDir, 'source-store');
    targetRoot = join(tempDir, 'target-repo');
    nodeFs.mkdirSync(sourceRoot, { recursive: true });
    nodeFs.mkdirSync(targetRoot, { recursive: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });

    // Write an encrypted source store (acts as the global/external store).
    writeRepo(sourceRoot, BASE_MANIFEST, { 'env/project/shared': BASE_FILE });
    // Write an encrypted target repo (where the import is added).
    writeRepo(targetRoot, BASE_MANIFEST, { 'env/project/shared': BASE_FILE });
  });

  afterEach(() => {
    nodeFs.rmSync(tempDir, { recursive: true, force: true });
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function setOwnerIdentity(ctx: HushContext, store: StoreContext) {
    const repo = loadV3Repository(store.root, { keyIdentity: store.keyIdentity });
    setActiveIdentity(ctx, {
      store,
      identity: 'owner-local',
      identities: repo.manifest.identities,
      command: { name: 'import', args: ['add'] },
    });
  }

  it('writes an import declaration into the target repo manifest', async () => {
    const { ctx, store } = createContext(targetRoot);
    setOwnerIdentity(ctx, store);

    await importAddCommand(ctx, {
      store,
      sourceRoot,
      bundle: 'project',
      importName: 'external-project',
      json: false,
    });

    const repo = loadV3Repository(targetRoot, { keyIdentity: targetRoot });
    expect(repo.manifest.imports).toBeDefined();
    const decl = repo.manifest.imports!['external-project'];
    expect(decl).toBeDefined();
    // Bundle names in pull.bundles are stored with namespace prefix (bundles/project).
    expect(decl.pull.bundles?.some((b) => b.includes('project'))).toBe(true);
  });

  it('is idempotent — same call twice does not duplicate', async () => {
    const { ctx, store } = createContext(targetRoot);
    setOwnerIdentity(ctx, store);

    const opts = { store, sourceRoot, bundle: 'project', importName: 'ext', json: false };
    await importAddCommand(ctx, opts);
    await importAddCommand(ctx, opts);

    const repo = loadV3Repository(targetRoot, { keyIdentity: targetRoot });
    const imports = Object.keys(repo.manifest.imports ?? {});
    expect(imports.filter((k) => k === 'ext')).toHaveLength(1);
  });

  it('fails when source root does not exist', async () => {
    const { ctx, store } = createContext(targetRoot);
    setOwnerIdentity(ctx, store);

    await expect(
      importAddCommand(ctx, {
        store,
        sourceRoot: '/nonexistent/path/to/store',
        bundle: 'project',
        json: false,
      }),
    ).rejects.toThrow('Process exit:');
  });

  it('fails when source root is not a v3 store', async () => {
    const emptyDir = join(tempDir, 'empty');
    nodeFs.mkdirSync(emptyDir, { recursive: true });
    const { ctx, store } = createContext(targetRoot);
    setOwnerIdentity(ctx, store);

    await expect(
      importAddCommand(ctx, {
        store,
        sourceRoot: emptyDir,
        bundle: 'project',
        json: false,
      }),
    ).rejects.toThrow('Process exit:');
  });

  it('fails when named bundle does not exist in source store', async () => {
    const { ctx, store, logger } = createContext(targetRoot);
    setOwnerIdentity(ctx, store);

    await expect(
      importAddCommand(ctx, {
        store,
        sourceRoot,
        bundle: 'nonexistent-bundle',
        json: false,
      }),
    ).rejects.toThrow('Process exit:');

    const errorOutput = stripAnsi(logger.error.mock.calls.map(([m]) => String(m)).join('\n'));
    expect(errorOutput).toContain('nonexistent-bundle');
  });

  it('outputs JSON when --json flag is set', async () => {
    const { ctx, logger, store } = createContext(targetRoot);
    setOwnerIdentity(ctx, store);

    await importAddCommand(ctx, {
      store,
      sourceRoot,
      bundle: 'project',
      importName: 'json-import',
      json: true,
    });

    const logOutput = logger.log.mock.calls.map(([m]) => String(m)).join('\n');
    const parsed = JSON.parse(logOutput) as Record<string, unknown>;
    expect(parsed.importName).toBe('json-import');
    expect(parsed.added).toBe(true);
  });

  it('idempotent call outputs idempotent:true in JSON mode', async () => {
    const { ctx, logger, store } = createContext(targetRoot);
    setOwnerIdentity(ctx, store);

    const opts = { store, sourceRoot, bundle: 'project', importName: 'idem', json: true };
    await importAddCommand(ctx, opts);
    logger.log.mockClear();
    await importAddCommand(ctx, opts);

    const logOutput = logger.log.mock.calls.map(([m]) => String(m)).join('\n');
    const parsed = JSON.parse(logOutput) as Record<string, unknown>;
    expect(parsed.idempotent).toBe(true);
  });

  it('derives an import name from source root + bundle when no importName is given', async () => {
    const { ctx, store } = createContext(targetRoot);
    setOwnerIdentity(ctx, store);

    await importAddCommand(ctx, {
      store,
      sourceRoot,
      bundle: 'project',
      // No importName → derived
      json: false,
    });

    const repo = loadV3Repository(targetRoot, { keyIdentity: targetRoot });
    const importKeys = Object.keys(repo.manifest.imports ?? {});
    // The derived name should contain 'project' (the bundle name).
    expect(importKeys.some((k) => k.includes('project'))).toBe(true);
  });
});
