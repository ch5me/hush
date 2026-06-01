import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { inspectCommand } from '../src/commands/inspect.js';
import { resolveCommand } from '../src/commands/resolve.js';
import { statusCommand } from '../src/commands/status.js';
import { traceCommand } from '../src/commands/trace.js';
import { verifyTargetCommand } from '../src/commands/verify-target.js';
import { createFileDocument, createFileIndexEntry, createManifestDocument, createProjectSlug, loadV3Repository, setActiveIdentity } from '../src/index.js';
import { decrypt, decryptYaml, encrypt, encryptYaml, encryptYamlContent, isSopsInstalled } from '../src/core/sops.js';
import type { HushContext, HushManifestDocument, LegacyHushConfig, StoreContext } from '../src/types.js';
import { ensureEncryptedFixtureRepo, ensureTestSopsEnv, writeEncryptedYamlFile } from './helpers/sops-test.js';

const TEST_DIR = join('/tmp', 'hush-test-diagnostics-v3');
const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures', 'v3');

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\u001B\[[0-9;]*m`, 'g'), '');
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
    path: {
      join,
    },
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

function getLogOutput(logger: { log: ReturnType<typeof vi.fn> }): string {
  return stripAnsi(logger.log.mock.calls.map(([message]) => String(message)).join('\n'));
}

function getErrorOutput(logger: { error: ReturnType<typeof vi.fn> }): string {
  return stripAnsi(logger.error.mock.calls.map(([message]) => String(message)).join('\n'));
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

function setIdentity(ctx: HushContext, store: StoreContext, fixtureRootOrRepository: string | ReturnType<typeof loadV3Repository>, identity: string): void {
  const repository = typeof fixtureRootOrRepository === 'string'
    ? (() => {
      ensureEncryptedFixtureRepo(fixtureRootOrRepository);
      return loadV3Repository(fixtureRootOrRepository, { keyIdentity: fixtureRootOrRepository });
    })()
    : fixtureRootOrRepository;
  setActiveIdentity(ctx, {
    store,
    identity,
    identities: repository.manifest.identities,
    command: { name: 'config', args: ['active-identity', identity] },
  });
}

describe('task 7 v3 diagnostic commands', () => {
  beforeEach(() => {
    ensureTestSopsEnv();
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
    for (const fixtureName of ['single-user-repo', 'owner-member-acl-split']) {
      ensureEncryptedFixtureRepo(join(FIXTURES_DIR, fixtureName));
    }
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('status reports v3 repository counts and machine-local state', async () => {
    const fixtureRoot = join(FIXTURES_DIR, 'single-user-repo');
    const { ctx, logger, store } = createContext(fixtureRoot);
    setIdentity(ctx, store, fixtureRoot, 'developer-local');

    await statusCommand(ctx, { store });

    const output = getLogOutput(logger);
    expect(output).toContain('Repository: v3');
    expect(output).toContain('Active identity: developer-local');
    expect(output).toContain('encrypted files: 1');
    expect(output).toContain('active identity path:');
    expect(output).toContain('audit log path:');
  });

  it('inspect shows logical paths with sensitive redaction', async () => {
    const fixtureRoot = join(FIXTURES_DIR, 'single-user-repo');
    const { ctx, logger, store } = createContext(fixtureRoot);
    setIdentity(ctx, store, fixtureRoot, 'developer-local');

    await inspectCommand(ctx, { store, env: 'development' });

    const output = getLogOutput(logger);
    expect(output).toContain('Readable entries:');
    expect(output).toContain('env/apps/web/env/NEXT_PUBLIC_API_URL');
    expect(output).toContain('https://api.example.com');
    expect(output).toContain('env/apps/api/env/DATABASE_URL');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('postgres://single-user-db');
  });

  it('resolve supports only filtering within full json output', async () => {
    const root = join(TEST_DIR, 'resolve-only-project');
    const repository = writeRepo(
      root,
      `
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
      `,
      {
        'env/project/shared': `
          path: env/project/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
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

    await resolveCommand(ctx, { store, env: 'development', target: 'runtime', only: 'API_URL' });

    const output = getLogOutput(logger);
    expect(output).toContain('Filtered by: API_URL');
    expect(output).toContain('env/project/shared/API_URL');
    expect(output).not.toContain('env/project/shared/API_KEY');
  });

  it('resolve json compact emits minimal machine records', async () => {
    const root = join(TEST_DIR, 'resolve-json-compact-project');
    const repository = writeRepo(
      root,
      `
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
      `,
      {
        'env/project/shared': `
          path: env/project/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
          entries:
            env/project/shared/API_URL:
              value: https://example.com
              sensitive: false
        `,
      },
    );
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, 'developer-local');

    await resolveCommand(ctx, { store, env: 'development', target: 'runtime', jsonCompact: true, only: 'API_URL' });

    const payload = JSON.parse(getLogOutput(logger)) as Array<{ key: string; source: string; target: string; precedence: number }>;
    expect(payload).toEqual([
      {
        key: 'env/project/shared/API_URL',
        source: 'env/project/shared',
        target: 'runtime',
        precedence: 0,
      },
    ]);
  });

  it('resolve reports file-level acl denial reasons', async () => {
    const fixtureRoot = join(FIXTURES_DIR, 'owner-member-acl-split');
    const { ctx, logger, store } = createContext(fixtureRoot);
    setIdentity(ctx, store, fixtureRoot, 'teammate-local');

    await expect(resolveCommand(ctx, { store, env: 'development', target: 'app-dev' })).rejects.toThrow('Process exit: 1');

    const output = getErrorOutput(logger);
    expect(output).toContain('requires unreadable file');
    expect(output).toContain('Unreadable files:');
    expect(output).toContain('env/app/secrets');
    expect(output).toContain('roles=owner identities=developer-local');
  });

  it('trace reports matching files and acl-denied targets', async () => {
    const fixtureRoot = join(FIXTURES_DIR, 'owner-member-acl-split');
    const { ctx, logger, store } = createContext(fixtureRoot);
    setIdentity(ctx, store, fixtureRoot, 'teammate-local');

    await traceCommand(ctx, { store, env: 'development', key: 'STRIPE_SECRET_KEY' });

    const output = getLogOutput(logger);
    expect(output).toContain('Selector: STRIPE_SECRET_KEY');
    expect(output).toContain('env/app/secrets (unreadable; roles=owner identities=developer-local)');
    expect(output).toContain('app-dev (acl denied)');
  });

  it('trace explains when an existing key is not selected by a target bundle', async () => {
    const root = join(TEST_DIR, 'trace-diagnosis-project');
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      bundles:
        project-production:
          files:
            - path: env/project/production
        api-production:
          files:
            - path: env/api/production
      targets:
        api-production:
          bundle: api-production
          format: dotenv
      `,
      {
        'env/project/production': `
          path: env/project/production
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
          entries:
            env/project/production/RESEND_API_KEY:
              value: resend-secret
              sensitive: true
        `,
        'env/api/production': `
          path: env/api/production
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
          entries:
            env/api/production/JWT_SECRET:
              value: jwt-secret
              sensitive: true
        `,
      },
    );
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, 'developer-local');

    await traceCommand(ctx, { store, env: 'development', key: 'RESEND_API_KEY' });

    const output = getLogOutput(logger);
    expect(output).toContain('api-production (not selected by target bundle)');
    expect(output).toContain('diagnosis: secret exists in env/project/production');
    expect(output).toContain('Add an explicit bundle import or copy/move the key into the target bundle file.');
    expect(output).not.toContain('resend-secret');
  });

  it('trace supports safe machine-readable diagnostics', async () => {
    const root = join(TEST_DIR, 'trace-json-project');
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      bundles:
        project-production:
          files:
            - path: env/project/production
        api-production:
          files:
            - path: env/api/production
      targets:
        api-production:
          bundle: api-production
          format: dotenv
      `,
      {
        'env/project/production': `
          path: env/project/production
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
          entries:
            env/project/production/RESEND_API_KEY:
              value: resend-secret
              sensitive: true
        `,
        'env/api/production': `
          path: env/api/production
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
          entries:
            env/api/production/JWT_SECRET:
              value: jwt-secret
              sensitive: true
        `,
      },
    );
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, 'developer-local');

    await traceCommand(ctx, { store, env: 'development', key: 'RESEND_API_KEY', json: true });

    const payload = JSON.parse(getLogOutput(logger)) as {
      selector: string;
      targets: Array<{ target: string; status: string; diagnosis?: string }>;
    };
    expect(payload.selector).toBe('RESEND_API_KEY');
    expect(payload.targets.some((target) => target.status === 'not_selected_by_target_bundle' && target.diagnosis?.includes('env/project/production'))).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('resend-secret');
  });

  it('trace compact shows minimal resolved rows', async () => {
    const root = join(TEST_DIR, 'trace-compact-project');
    const repository = writeRepo(
      root,
      `
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
      `,
      {
        'env/project/shared': `
          path: env/project/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
          entries:
            env/project/shared/API_URL:
              value: https://example.com
              sensitive: false
        `,
      },
    );
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, 'developer-local');

    await traceCommand(ctx, { store, env: 'development', key: 'API_URL', compact: true });

    const output = getLogOutput(logger);
    expect(output).toContain('Hush trace compact');
    expect(output).toContain('API_URL');
    expect(output).toContain('source=env/project/shared target=runtime precedence=0');
    expect(output).not.toContain('Active identity:');
    expect(output).not.toContain('diagnosis:');
  });

  it('trace json compact emits minimal machine records', async () => {
    const root = join(TEST_DIR, 'trace-json-compact-project');
    const repository = writeRepo(
      root,
      `
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
      `,
      {
        'env/project/shared': `
          path: env/project/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
          entries:
            env/project/shared/API_URL:
              value: https://example.com
              sensitive: false
        `,
      },
    );
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, 'developer-local');

    await traceCommand(ctx, { store, env: 'development', key: 'API_URL', jsonCompact: true });

    const payload = JSON.parse(getLogOutput(logger)) as Array<{ key: string; source: string; target: string; precedence: number }>;
    expect(payload).toEqual([
      {
        key: 'env/project/shared/API_URL',
        source: 'env/project/shared',
        target: 'runtime',
        precedence: 0,
      },
    ]);
  });

  it('verify-target passes when required keys resolve', async () => {
    const fixtureRoot = join(FIXTURES_DIR, 'owner-member-acl-split');
    const { ctx, logger, store } = createContext(fixtureRoot);
    setIdentity(ctx, store, fixtureRoot, 'developer-local');

    await verifyTargetCommand(ctx, { store, env: 'development', target: 'app-dev', require: ['STRIPE_SECRET_KEY'] });

    const output = getLogOutput(logger);
    expect(output).toContain('Target verification passed.');
    expect(output).toContain('✓ STRIPE_SECRET_KEY');
  });

  it('verify-target fails safely when required keys are missing', async () => {
    const fixtureRoot = join(FIXTURES_DIR, 'owner-member-acl-split');
    const { ctx, logger, store } = createContext(fixtureRoot);
    setIdentity(ctx, store, fixtureRoot, 'developer-local');

    await expect(verifyTargetCommand(ctx, { store, env: 'development', target: 'app-dev', require: ['RESEND_API_KEY'], json: true })).rejects.toThrow('Process exit: 1');

    const payload = JSON.parse(getLogOutput(logger)) as { ok: boolean; missing: string[]; resolvedKeys: Record<string, string[]> };
    expect(payload.ok).toBe(false);
    expect(payload.missing).toEqual(['RESEND_API_KEY']);
    expect(JSON.stringify(payload)).not.toContain('postgres://single-user-db');
  });
});
