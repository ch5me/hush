import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  createFileDocument,
  createFileIndexEntry,
  createManifestDocument,
  createProjectSlug,
  loadV3Repository,
  resolveV3Bundle,
  resolveV3Target,
  setActiveIdentity,
  shapeTargetArtifacts,
  HushResolutionConflictError,
  type HushImportRepositoryMap,
  type HushV3Repository,
} from '../../src/index.js';
import { decrypt, decryptYaml, encrypt, encryptYaml, encryptYamlContent, isSopsInstalled } from '../../src/core/sops.js';
import type { HushContext, HushManifestDocument, LegacyHushConfig, StoreContext } from '../../src/types.js';
import { ensureEncryptedFixtureRepo, ensureTestSopsEnv, writeEncryptedYamlFile } from '../helpers/sops-test.js';

const TEST_DIR = join('/tmp', 'hush-test-v3-resolver');
const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures', 'v3');

function createContext(): HushContext {
  ensureTestSopsEnv();

const defaultConfig: LegacyHushConfig = {
    sources: {
      shared: '.hush',
      development: '.hush.development',
      production: '.hush.production',
      local: '.hush.local',
    },
    targets: [{ name: 'root', path: '.', format: 'dotenv' }],
  };

  return {
    fs: {
      existsSync: nodeFs.existsSync,
      readFileSync: nodeFs.readFileSync,
      writeFileSync: nodeFs.writeFileSync,
      mkdirSync: nodeFs.mkdirSync,
      readdirSync: nodeFs.readdirSync,
      unlinkSync: nodeFs.unlinkSync,
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
    logger: {
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    },
    process: {
      cwd: () => TEST_DIR,
      exit: (code: number) => {
        throw new Error(`Process exit: ${code}`);
      },
      env: {},
      stdin: process.stdin,
      stdout: process.stdout,
    },
    config: {
      loadConfig: () => defaultConfig,
      findProjectRoot: () => null,
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
}

function createStore(root: string): StoreContext {
  const stateRoot = join(TEST_DIR, '.machine-state');
  const projectSlug = createProjectSlug(root);
  const projectStateRoot = join(stateRoot, 'projects', projectSlug);

  return {
    mode: 'project',
    root,
    configPath: join(root, 'hush.yaml'),
    keyIdentity: root,
    displayLabel: root,
    projectSlug,
    stateRoot,
    projectStateRoot,
    activeIdentityPath: join(projectStateRoot, 'active-identity.json'),
    auditLogPath: join(projectStateRoot, 'audit.jsonl'),
  };
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
      const current = match?.[0].length ?? 0;
      return Math.min(smallest, current);
    }, Number.POSITIVE_INFINITY);

  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
}

function writeRepo(root: string, manifest: string, files: Record<string, string>): HushV3Repository {
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

function setIdentity(ctx: HushContext, store: StoreContext, repository: HushV3Repository, identity: string): void {
  setActiveIdentity(ctx, {
    store,
    identity,
    identities: repository.manifest.identities,
    command: { name: 'config', args: ['active-identity', identity] },
  });
}

beforeEach(() => {
  ensureTestSopsEnv();
  nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  for (const fixtureName of ['owner-member-acl-split', 'ci-only-readable-file', 'imported-bundle', 'bundle-conflict']) {
    ensureEncryptedFixtureRepo(join(FIXTURES_DIR, fixtureName));
  }
});

afterEach(() => {
  nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('resolveV3Target ACL enforcement', () => {
  it('honors an explicit identity reader grant when the identity has no roles', () => {
    const ctx = createContext();
    const root = join(TEST_DIR, 'identity-only-reader');
    const repository = writeRepo(root, `
      version: 3
      metadata:
        project: identity-only-reader
      identities:
        robot:
          roles: []
      activeIdentity: robot
      bundles:
        runtime:
          files:
            - path: env/project/shared
      targets:
        runtime:
          bundle: runtime
          format: dotenv
    `, {
      'env/project/shared': `
        version: 3
        path: env/project/shared
        readers:
          roles: []
          identities: [robot]
        sensitive: true
        entries:
          env/project/shared/ROBOT_TOKEN:
            value: synthetic
            sensitive: true
      `,
    });
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'robot');

    const resolution = resolveV3Target(ctx, {
      store,
      repository,
      targetName: 'runtime',
    });

    expect(resolution.values['env/project/shared/ROBOT_TOKEN']?.entry.value).toBe('synthetic');
  });

  it('allows owners to resolve readable files and returns provenance', () => {
    const ctx = createContext();
    const root = join(FIXTURES_DIR, 'owner-member-acl-split');
    const repository = loadV3Repository(root, { keyIdentity: root });
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'developer-local');

    const resolution = resolveV3Target(ctx, {
      store,
      repository,
      targetName: 'app-dev',
      command: { name: 'resolve', args: ['app-dev'] },
    });

    expect(Object.keys(resolution.values).sort()).toEqual([
      'env/apps/api/env/STRIPE_SECRET_KEY',
      'env/apps/web/env/NEXT_PUBLIC_API_URL',
    ]);
    expect(resolution.values['env/apps/api/env/STRIPE_SECRET_KEY']?.resolvedFrom).toEqual(['env/app/secrets']);
    expect(resolution.values['env/apps/web/env/NEXT_PUBLIC_API_URL']?.provenance[0]).toMatchObject({
      filePath: 'env/app/shared',
      bundle: 'app',
    });
  });

  it('denies members when a target requires an owner-only file', () => {
    const ctx = createContext();
    const root = join(FIXTURES_DIR, 'owner-member-acl-split');
    const repository = loadV3Repository(root, { keyIdentity: root });
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'teammate-local');

    expect(() =>
      resolveV3Target(ctx, {
        store,
        repository,
        targetName: 'app-dev',
        command: { name: 'resolve', args: ['app-dev'] },
      }),
    ).toThrow(/requires unreadable file/);
  });

  it('allows ci identities to resolve ci-only artifacts', () => {
    const ctx = createContext();
    const root = join(FIXTURES_DIR, 'ci-only-readable-file');
    const repository = loadV3Repository(root, { keyIdentity: root });
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'ci');

    const resolution = resolveV3Target(ctx, {
      store,
      repository,
      targetName: 'release-job',
      command: { name: 'resolve', args: ['release-job'] },
    });

    expect(Object.keys(resolution.artifacts)).toEqual(['artifacts/release/runtime/env-file']);
    expect(resolution.artifacts['artifacts/release/runtime/env-file']?.entry).toMatchObject({
      type: 'file',
      format: 'dotenv',
    });
  });
});

describe('resolveV3Target imports and collisions', () => {
  it('pulls imported bundles explicitly and lets local content beat imported content by default', () => {
    const ctx = createContext();
    const appRoot = join(TEST_DIR, 'app-imports');
    const platformRoot = join(TEST_DIR, 'platform-imports');
    const platformRepository = writeRepo(
      platformRoot,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      bundles:
        platform/runtime:
          files:
            - path: env/platform/shared
      `,
      {
        'env/platform/shared': `
          path: env/platform/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/apps/web/env/API_URL:
              value: https://platform.example.com
              sensitive: false
            env/apps/web/env/PLATFORM_URL:
              value: https://platform-only.example.com
              sensitive: false
        `,
      },
    );
    const appRepository = writeRepo(
      appRoot,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      imports:
        platform:
          project: github.com/example/platform-secrets
          pull:
            bundles: [bundles/platform/runtime]
      bundles:
        app:
          files:
            - path: env/app/shared
          imports:
            - project: platform
              bundle: bundles/platform/runtime
      targets:
        app-dev:
          bundle: app
          format: dotenv
      `,
      {
        'env/app/shared': `
          path: env/app/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/apps/web/env/API_URL:
              value: https://local.example.com
              sensitive: false
            env/apps/web/env/APP_ONLY_URL:
              value: https://app-only.example.com
              sensitive: false
        `,
      },
    );
    const store = createStore(appRoot);

    setIdentity(ctx, store, appRepository, 'developer-local');

    const resolution = resolveV3Target(ctx, {
      store,
      repository: appRepository,
      importedRepositories: { platform: platformRepository } satisfies HushImportRepositoryMap,
      targetName: 'app-dev',
      command: { name: 'resolve', args: ['app-dev'] },
    });

    expect(resolution.values['env/apps/web/env/API_URL']?.entry).toMatchObject({
      value: 'https://local.example.com',
    });
    expect(resolution.values['env/apps/web/env/PLATFORM_URL']?.provenance[0]?.import).toMatchObject({
      project: 'github.com/example/platform-secrets',
      bundle: 'bundles/platform/runtime',
    });
  });

  it('throws a hard conflict when equal-precedence imports define the same logical path', () => {
    const ctx = createContext();
    const root = join(TEST_DIR, 'equal-precedence-conflict');
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      bundles:
        one:
          files:
            - path: env/apps/one
        two:
          files:
            - path: env/apps/two
        app:
          imports:
            - bundle: bundles/one
            - bundle: bundles/two
      `,
      {
        'env/apps/one': `
          path: env/apps/one
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/apps/api/env/API_URL:
              value: https://one.example.com
              sensitive: false
        `,
        'env/apps/two': `
          path: env/apps/two
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/apps/api/env/API_URL:
              value: https://two.example.com
              sensitive: false
        `,
      },
    );
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'developer-local');

    expect(() =>
      resolveV3Bundle(ctx, {
        store,
        repository,
        bundleName: 'app',
        command: { name: 'resolve', args: ['app'] },
      }),
    ).toThrow(HushResolutionConflictError);

    try {
      resolveV3Bundle(ctx, {
        store,
        repository,
        bundleName: 'app',
        command: { name: 'resolve', args: ['app'] },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(HushResolutionConflictError);
      expect((error as HushResolutionConflictError).conflicts[0]?.path).toBe('env/apps/api/env/API_URL');
      expect((error as Error).message).toContain('Files containing the duplicate:');
      expect((error as Error).message).toContain('env/apps/one');
      expect((error as Error).message).toContain('env/apps/two');
      expect((error as Error).message).toContain('hush move-key API_URL --from <source> --to <destination>');
      expect((error as Error).message).toContain('hush delete-key API_URL --from <file-to-remove-from>');
    }
  });

  it('adds duplicate-key remediation when target env keys collide after resolution', () => {
    const ctx = createContext();
    const root = join(TEST_DIR, 'target-env-key-collision');
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      bundles:
        app:
          files:
            - path: env/apps/one
            - path: env/apps/two
      targets:
        app-env:
          bundle: app
          format: dotenv
      `,
      {
        'env/apps/one': `
          path: env/apps/one
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/apps/one/API_URL:
              value: https://one.example.com
              sensitive: false
        `,
        'env/apps/two': `
          path: env/apps/two
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/apps/two/API_URL:
              value: https://two.example.com
              sensitive: false
        `,
      },
    );
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'developer-local');

    const resolution = resolveV3Target(ctx, {
      store,
      repository,
      targetName: 'app-env',
      command: { name: 'resolve', args: ['app-env'] },
    });

    expect(() => shapeTargetArtifacts('app-env', repository.manifest.targets!['app-env']!, resolution)).toThrow(/Files containing the duplicate:/);
    expect(() => shapeTargetArtifacts('app-env', repository.manifest.targets!['app-env']!, resolution)).toThrow(/env\/apps\/one/);
    expect(() => shapeTargetArtifacts('app-env', repository.manifest.targets!['app-env']!, resolution)).toThrow(/env\/apps\/two/);
    expect(() => shapeTargetArtifacts('app-env', repository.manifest.targets!['app-env']!, resolution)).toThrow(/hush move-key API_URL --from <source> --to <destination>/);
    expect(() => shapeTargetArtifacts('app-env', repository.manifest.targets!['app-env']!, resolution)).toThrow(/hush delete-key API_URL --from <file-to-remove-from>/);
  });
});

describe('resolveV3Target interpolation', () => {
  it('detects interpolation cycles', () => {
    const ctx = createContext();
    const root = join(TEST_DIR, 'interpolation-cycle');
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      bundles:
        app:
          files:
            - path: env/app/shared
      targets:
        app-dev:
          bundle: app
          format: dotenv
      `,
      {
        'env/app/shared': `
          path: env/app/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/app/shared/A:
              value: ${'${env/app/shared/B}'}
              sensitive: false
            env/app/shared/B:
              value: ${'${env/app/shared/A}'}
              sensitive: false
        `,
      },
    );
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'developer-local');

    expect(() =>
      resolveV3Target(ctx, {
        store,
        repository,
        targetName: 'app-dev',
        command: { name: 'resolve', args: ['app-dev'] },
      }),
    ).toThrow(/Interpolation cycle detected/);
  });

  it('fails when interpolation points at an unreadable source path', () => {
    const ctx = createContext();
    const root = join(TEST_DIR, 'interpolation-unreadable');
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
        teammate-local:
          roles: [member]
      bundles:
        app:
          files:
            - path: env/app/public
      targets:
        app-dev:
          bundle: app
          format: dotenv
      `,
      {
        'env/app/public': `
          path: env/app/public
          readers:
            roles: [owner, member]
            identities: [developer-local, teammate-local]
          sensitive: false
          entries:
            env/apps/web/env/COMPOSED_URL:
              value: ${'${env/apps/api/env/SECRET_TOKEN}'}
              sensitive: false
        `,
        'env/app/private': `
          path: env/app/private
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
          entries:
            env/apps/api/env/SECRET_TOKEN:
              value: shh-owner-only
              sensitive: true
        `,
      },
    );
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'teammate-local');

    expect(() =>
      resolveV3Target(ctx, {
        store,
        repository,
        targetName: 'app-dev',
        command: { name: 'resolve', args: ['app-dev'] },
      }),
    ).toThrow(/Interpolation source "env\/apps\/api\/env\/SECRET_TOKEN" is unreadable/);
  });

  it('preserves provenance for interpolated values and artifacts', () => {
    const ctx = createContext();
    const root = join(TEST_DIR, 'interpolation-provenance');
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      bundles:
        app:
          files:
            - path: env/app/shared
            - path: env/app/secrets
            - path: artifacts/app/runtime
      targets:
        app-dev:
          bundle: app
          format: dotenv
      `,
      {
        'env/app/shared': `
          path: env/app/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/apps/web/env/BASE_URL:
              value: https://example.com
              sensitive: false
        `,
        'env/app/secrets': `
          path: env/app/secrets
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
          entries:
            env/apps/api/env/API_URL:
              value: ${'${env/apps/web/env/BASE_URL}'}/v1
              sensitive: true
        `,
        'artifacts/app/runtime': `
          path: artifacts/app/runtime
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
          entries:
            artifacts/app/runtime/env-file:
              type: file
              format: dotenv
              sensitive: true
              value: |
                API_URL=${'${env/apps/api/env/API_URL}'}
        `,
      },
    );
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'developer-local');

    const resolution = resolveV3Target(ctx, {
      store,
      repository,
      targetName: 'app-dev',
      command: { name: 'resolve', args: ['app-dev'] },
    });

    expect(resolution.values['env/apps/api/env/API_URL']?.entry).toMatchObject({
      value: 'https://example.com/v1',
    });
    expect(resolution.values['env/apps/api/env/API_URL']?.resolvedFrom.sort()).toEqual([
      'env/app/secrets',
      'env/app/shared',
    ]);
    expect(resolution.artifacts['artifacts/app/runtime/env-file']?.entry).toMatchObject({
      value: 'API_URL=https://example.com/v1\n',
    });
    expect(resolution.artifacts['artifacts/app/runtime/env-file']?.resolvedFrom.sort()).toEqual([
      'artifacts/app/runtime',
      'env/app/secrets',
      'env/app/shared',
    ]);
  });
});
