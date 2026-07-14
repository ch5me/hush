import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { inspectCommand } from '../src/commands/inspect.js';
import { createFileDocument, createFileIndexEntry, createManifestDocument, createProjectSlug, loadV3Repository, setActiveIdentity } from '../src/index.js';
import { decrypt, decryptYaml, encrypt, encryptYaml, encryptYamlContent, isSopsInstalled } from '../src/core/sops.js';
import type { HushContext, HushManifestDocument, LegacyHushConfig, StoreContext } from '../src/types.js';
import { ensureTestSopsEnv, writeEncryptedYamlFile } from './helpers/sops-test.js';

const TEST_DIR = join('/tmp', 'hush-test-inspect-json');

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\[[0-9;]*m`, 'g'), '');
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

describe('inspect --json', () => {
  beforeEach(() => {
    ensureTestSopsEnv();
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('emits valid JSON with expected fields', async () => {
    const root = join(TEST_DIR, 'inspect-json-basic');
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      `,
      {
        'env/project/shared': `
          path: env/project/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/project/shared/API_URL:
              value: https://example.com
              sensitive: false
            env/project/shared/API_KEY:
              value: top-secret
              sensitive: true
        `,
      },
    );
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, 'developer-local');

    await inspectCommand(ctx, { store, env: 'development', json: true });

    const raw = logger.log.mock.calls.map(([message]) => String(message)).join('');
    const envelope = JSON.parse(raw) as { data: {
      target: string;
      entries: Array<{ key: string; file: string; sensitive: boolean; set: boolean; value?: string }>;
    } };
    const payload = envelope.data;

    expect(payload).toHaveProperty('target');
    expect(payload).toHaveProperty('entries');
    expect(Array.isArray(payload.entries)).toBe(true);
  });

  it('includes value field only for non-sensitive entries', async () => {
    const root = join(TEST_DIR, 'inspect-json-values');
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      `,
      {
        'env/project/shared': `
          path: env/project/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/project/shared/PUBLIC_URL:
              value: https://example.com
              sensitive: false
            env/project/shared/SECRET_KEY:
              value: ultra-secret-value
              sensitive: true
        `,
      },
    );
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, 'developer-local');

    await inspectCommand(ctx, { store, env: 'development', json: true });

    const raw = logger.log.mock.calls.map(([message]) => String(message)).join('');
    const envelope = JSON.parse(raw) as { data: {
      target: string;
      entries: Array<{ key: string; file: string; sensitive: boolean; set: boolean; value?: string }>;
    } };
    const payload = envelope.data;

    const publicEntry = payload.entries.find((e) => e.key.includes('PUBLIC_URL'));
    const secretEntry = payload.entries.find((e) => e.key.includes('SECRET_KEY'));

    expect(publicEntry).toBeDefined();
    expect(publicEntry?.sensitive).toBe(false);
    expect(publicEntry?.value).toBe('https://example.com');

    expect(secretEntry).toBeDefined();
    expect(secretEntry?.sensitive).toBe(true);
    // sensitive entries must NOT have a value field
    expect(secretEntry).not.toHaveProperty('value');
  });

  it('never contains sensitive secret values in JSON output', async () => {
    const root = join(TEST_DIR, 'inspect-json-no-secrets');
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      `,
      {
        'env/project/shared': `
          path: env/project/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
          entries:
            env/project/shared/DATABASE_URL:
              value: postgres://secret-host/db
              sensitive: true
            env/project/shared/PUBLIC_URL:
              value: https://example.com
              sensitive: false
        `,
      },
    );
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, 'developer-local');

    await inspectCommand(ctx, { store, env: 'development', json: true });

    const raw = logger.log.mock.calls.map(([message]) => String(message)).join('');

    // Must not contain the sensitive value anywhere in the JSON output
    expect(raw).not.toContain('postgres://secret-host/db');
  });

  it('entries have required fields: key, file, sensitive, set', async () => {
    const root = join(TEST_DIR, 'inspect-json-fields');
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      `,
      {
        'env/project/shared': `
          path: env/project/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/project/shared/MY_KEY:
              value: my-value
              sensitive: false
        `,
      },
    );
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, 'developer-local');

    await inspectCommand(ctx, { store, env: 'development', json: true });

    const raw = logger.log.mock.calls.map(([message]) => String(message)).join('');
    const envelope = JSON.parse(raw) as { data: {
      target: string;
      entries: Array<{ key: string; file: string; sensitive: boolean; set: boolean }>;
    } };
    const payload = envelope.data;

    const entry = payload.entries[0];
    expect(entry).toBeDefined();
    expect(entry).toHaveProperty('key');
    expect(entry).toHaveProperty('file');
    expect(entry).toHaveProperty('sensitive');
    expect(entry).toHaveProperty('set');
    expect(typeof entry?.key).toBe('string');
    expect(typeof entry?.file).toBe('string');
    expect(typeof entry?.sensitive).toBe('boolean');
    expect(typeof entry?.set).toBe('boolean');
  });
});
