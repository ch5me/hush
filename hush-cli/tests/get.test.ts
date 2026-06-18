import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getCommand } from '../src/commands/get.js';
import { createFileDocument, createFileIndexEntry, createManifestDocument, createProjectSlug, loadV3Repository, setActiveIdentity } from '../src/index.js';
import { decrypt, decryptYaml, encrypt, encryptYaml, encryptYamlContent, isSopsInstalled } from '../src/core/sops.js';
import type { HushContext, HushManifestDocument, LegacyHushConfig, StoreContext } from '../src/types.js';
import { ensureTestSopsEnv, writeEncryptedYamlFile } from './helpers/sops-test.js';

const TEST_DIR = join('/tmp', 'hush-test-get');

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\[[0-9;]*m`, 'g'), '');
}

function normalizeYaml(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  while (lines[0] !== undefined && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.at(-1) !== undefined && lines.at(-1)?.trim() === '') {
    lines.pop();
  }
  const indent = lines
    .filter((line) => line.trim().length > 0)
    .reduce<number>((smallest, line) => {
      const match = line.match(/^\s*/);
      return Math.min(smallest, match?.[0].length ?? 0);
    }, Number.POSITIVE_INFINITY);
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
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
      env: {},
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
    developer-local:
      roles: [owner]
  bundles:
    runtime:
      files:
        - path: env/project/shared
  targets:
    runtime:
      bundle: runtime
      format: dotenv
`;

const SHARED_FILE = `
  path: env/project/shared
  readers:
    roles: [owner]
    identities: [developer-local]
  sensitive: true
  entries:
    env/project/shared/API_KEY:
      value: top-secret-value
      sensitive: true
`;

function setup(name: string) {
  const root = join(TEST_DIR, name);
  const repository = writeRepo(root, MANIFEST, { 'env/project/shared': SHARED_FILE });
  const { ctx, logger, store } = createContext(root);
  setIdentity(ctx, store, repository, 'developer-local');
  return { ctx, logger, store };
}

describe('get command', () => {
  beforeEach(() => {
    ensureTestSopsEnv();
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('masks the value by default and never prints plaintext', async () => {
    const { ctx, logger, store } = setup('masked');
    await getCommand(ctx, { store, env: 'development', key: 'API_KEY' });

    const out = stripAnsi(logger.log.mock.calls.map(([m]) => String(m)).join('\n'));
    expect(out).toContain('API_KEY');
    expect(out).toContain('********');
    expect(out).toContain('env/project/shared'); // provenance
    expect(out).not.toContain('top-secret-value');
  });

  it('--reveal prints ONLY the bare value to stdout (scriptable)', async () => {
    const { ctx, logger, store } = setup('reveal');
    await getCommand(ctx, { store, env: 'development', key: 'API_KEY', reveal: true });

    // The value is logged on its own (no key=, no mask) so $(hush get … --reveal) captures it cleanly.
    const bareValueLogged = logger.log.mock.calls.some(([m]) => m === 'top-secret-value');
    expect(bareValueLogged).toBe(true);
    // The plaintext warning + provenance go to stderr, not stdout.
    const stderr = stripAnsi(logger.error.mock.calls.map(([m]) => String(m)).join('\n'));
    expect(stderr).toContain('plaintext');
  });

  it('--json emits a structured masked record with provenance', async () => {
    const { ctx, logger, store } = setup('json');
    await getCommand(ctx, { store, env: 'development', key: 'API_KEY', json: true });

    const raw = logger.log.mock.calls.map(([m]) => String(m)).join('');
    const payload = JSON.parse(raw) as { key: string; value: string; target: string; source: string | null; revealed: boolean };
    expect(payload.key).toBe('API_KEY');
    expect(payload.value).toBe('********');
    expect(payload.revealed).toBe(false);
    expect(payload.source).toContain('env/project/shared');
    expect(raw).not.toContain('top-secret-value');
  });

  it('--json --reveal includes the plaintext value', async () => {
    const { ctx, logger, store } = setup('json-reveal');
    await getCommand(ctx, { store, env: 'development', key: 'API_KEY', json: true, reveal: true });

    const raw = logger.log.mock.calls.map(([m]) => String(m)).join('');
    const payload = JSON.parse(raw) as { value: string; revealed: boolean };
    expect(payload.value).toBe('top-secret-value');
    expect(payload.revealed).toBe(true);
  });

  it('errors and exits non-zero for a missing key', async () => {
    const { ctx, logger, store } = setup('missing');
    await expect(getCommand(ctx, { store, env: 'development', key: 'NOPE' })).rejects.toThrow('Process exit: 1');
    const stderr = stripAnsi(logger.error.mock.calls.map(([m]) => String(m)).join('\n'));
    expect(stderr).toContain('not found');
  });
});
