import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import * as nodeFs from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  createFileDocument,
  createFileIndexEntry,
  createManifestDocument,
  createProjectSlug,
  loadV3Repository,
  materializeV3Bundle,
  materializeV3Target,
  setActiveIdentity,
  withMaterializedTarget,
} from '../../src/index.js';
import { decrypt, decryptYaml, encrypt, encryptYaml, encryptYamlContent, isSopsInstalled } from '../../src/core/sops.js';
import { materializeCommand } from '../../src/commands/materialize.js';
import type { HushContext, HushManifestDocument, LegacyHushConfig, StoreContext } from '../../src/types.js';
import { ensureTestSopsConfig, ensureTestSopsEnv, writeEncryptedYamlFile } from '../helpers/sops-test.js';

const TEST_DIR = join('/tmp', 'hush-test-v3-materialize');

function createSignalProcess() {
  const listeners = new Map<'SIGINT' | 'SIGTERM', Set<() => void>>();

  return {
    process: {
      cwd: () => TEST_DIR,
      exit: (code: number) => {
        throw new Error(`Process exit: ${code}`);
      },
      env: {},
      stdin: process.stdin,
      stdout: process.stdout,
      on: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => {
        const existing = listeners.get(event) ?? new Set<() => void>();
        existing.add(listener);
        listeners.set(event, existing);
      },
      removeListener: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => {
        listeners.get(event)?.delete(listener);
      },
    },
    emit(event: 'SIGINT' | 'SIGTERM') {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };
}

function createContext(): { ctx: HushContext; emitSignal: (signal: 'SIGINT' | 'SIGTERM') => void } {
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
  const signalProcess = createSignalProcess();

  return {
    ctx: {
      fs: {
        existsSync: nodeFs.existsSync,
        readFileSync: nodeFs.readFileSync,
        writeFileSync: nodeFs.writeFileSync,
        mkdirSync: nodeFs.mkdirSync,
        readdirSync: nodeFs.readdirSync,
        unlinkSync: nodeFs.unlinkSync,
        rmSync: nodeFs.rmSync,
        statSync: nodeFs.statSync,
        renameSync: nodeFs.renameSync,
        chmodSync: nodeFs.chmodSync,
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
      process: signalProcess.process,
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
    },
    emitSignal: signalProcess.emit,
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

function writeRepo(root: string, manifest: string, files: Record<string, string>) {
  nodeFs.mkdirSync(root, { recursive: true });
  ensureTestSopsConfig(root);
  nodeFs.mkdirSync(join(root, '.hush', 'files'), { recursive: true });
  const parsedFiles = Object.values(files).map((content) => createFileDocument(parseYaml(normalizeYaml(content))));
  const manifestDocument = createManifestDocument({
    ...(parseYaml(normalizeYaml(manifest)) as Record<string, unknown>),
    fileIndex: Object.fromEntries(parsedFiles.map((file) => [file.path, createFileIndexEntry(file)])),
  } as HushManifestDocument);
  nodeFs.mkdirSync(join(root, '.hush'), { recursive: true });
  writeEncryptedYamlFile(root, join(root, '.hush', 'manifest.encrypted'), stringifyYaml(manifestDocument, { indent: 2 }));

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(root, '.hush', 'files', `${relativePath}.encrypted`);
    nodeFs.mkdirSync(dirname(filePath), { recursive: true });
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

function readAuditTypes(store: StoreContext): string[] {
  return nodeFs
    .readFileSync(store.auditLogPath!, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).type);
}

beforeAll(() => {
  ensureTestSopsEnv();
  nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  nodeFs.mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe.sequential('v3 materialization runtime', () => {
  it('materializes env outputs in memory and audits success', () => {
    const { ctx } = createContext();
    const root = join(TEST_DIR, 'memory-target');
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
        app-env:
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
            env/apps/api/env/API_URL:
              value: https://example.com
              sensitive: false
            env/apps/api/env/FEATURE_FLAG:
              value: true
              sensitive: false
        `,
      },
    );
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'developer-local');

    const result = withMaterializedTarget(ctx, {
      store,
      repository,
      targetName: 'app-env',
      command: { name: 'run', args: ['--', 'bun', 'dev'] },
    }, (materialization) => ({
      env: materialization.env,
      targetArtifact: materialization.targetArtifact,
      stagedArtifacts: materialization.stagedArtifacts,
    }));

    expect(result.env).toEqual({
      API_URL: 'https://example.com',
      FEATURE_FLAG: 'true',
    });
    expect(result.targetArtifact?.content).toContain('API_URL=https://example.com');
    expect(result.stagedArtifacts).toEqual([]);
    expect(readAuditTypes(store)).toContain('materialize');
  });

  it('shapes file and binary artifact descriptors through shared emitters', () => {
    const { ctx } = createContext();
    const root = join(TEST_DIR, 'artifact-target');
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
            - path: env/app/shared
            - path: artifacts/app/runtime
      targets:
        runtime-files:
          bundle: runtime
          format: json
      `,
      {
        'env/app/shared': `
          path: env/app/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/apps/api/env/API_URL:
              value: https://example.com
              sensitive: false
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
            artifacts/app/runtime/client-cert:
              type: binary
              format: binary
              encoding: base64
              value: SGVsbG8=
              sensitive: true
        `,
      },
    );
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'developer-local');

    const materialization = materializeV3Target(ctx, {
      store,
      repository,
      targetName: 'runtime-files',
      command: { name: 'export', args: ['runtime-files'] },
    });

    expect(materialization.targetArtifact?.content).toContain('"API_URL": "https://example.com"');
    expect(materialization.artifacts).toHaveLength(2);
    expect(materialization.artifacts[0]).toMatchObject({ kind: 'binary', logicalPath: 'artifacts/app/runtime/client-cert' });
    expect(materialization.artifacts[1]).toMatchObject({ kind: 'file', logicalPath: 'artifacts/app/runtime/env-file' });
    const envFile = materialization.artifacts.find((artifact) => artifact.logicalPath === 'artifacts/app/runtime/env-file');
    expect(envFile && 'content' in envFile ? envFile.content : '').toContain('API_URL=https://example.com');

    materialization.cleanup();
  });

  it('materializes bundle artifacts and respects filename, subpath, and materializeAs metadata', () => {
    const { ctx } = createContext();
    const root = join(TEST_DIR, 'bundle-artifacts');
    const outputRoot = join(TEST_DIR, 'bundle-output');
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      bundles:
        signing:
          files:
            - path: env/app/shared
            - path: artifacts/app/signing
      `,
      {
        'env/app/shared': `
          path: env/app/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
          entries:
            env/apps/fitbot/signing/P12_PASSWORD:
              value: super-secret
              sensitive: true
        `,
        'artifacts/app/signing': `
          path: artifacts/app/signing
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: true
          entries:
            artifacts/app/signing/certificate:
              type: binary
              format: binary
              encoding: base64
              value: SGVsbG8=
              sensitive: true
              filename: certificate.p12
              subpath: apple/fitbot
            artifacts/app/signing/profile:
              type: file
              format: yaml
              value: "uuid: 123"
              sensitive: true
              materializeAs: apple/profiles/app.mobileprovision
        `,
      },
    );
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'developer-local');

    const materialization = materializeV3Bundle(ctx, {
      store,
      repository,
      bundleName: 'signing',
      mode: 'persisted',
      outputRoot,
    });

    expect(materialization.artifacts).toHaveLength(2);
    expect(materialization.artifacts[0]).toMatchObject({
      logicalPath: 'artifacts/app/signing/certificate',
      suggestedName: 'certificate.p12',
      relativePath: 'apple/fitbot/certificate.p12',
    });
    expect(materialization.artifacts[1]).toMatchObject({
      logicalPath: 'artifacts/app/signing/profile',
      suggestedName: 'app.mobileprovision',
      relativePath: 'apple/profiles/app.mobileprovision',
    });
    expect(materialization.stagedArtifacts.map((artifact) => artifact.path)).toEqual([
      join(outputRoot, 'apple', 'fitbot', 'certificate.p12'),
      join(outputRoot, 'apple', 'profiles', 'app.mobileprovision'),
    ]);
    expect(nodeFs.readFileSync(join(outputRoot, 'apple', 'profiles', 'app.mobileprovision'), 'utf-8')).toContain('uuid: 123');
    materialization.cleanup();
  });

  it('only persists outputs when explicitly requested', () => {
    const { ctx } = createContext();
    const root = join(TEST_DIR, 'persist-target');
    const outputRoot = join(TEST_DIR, 'persisted-output');
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
        app-env:
          bundle: app
          format: yaml
      `,
      {
        'env/app/shared': `
          path: env/app/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/apps/api/env/API_URL:
              value: https://example.com
              sensitive: false
        `,
      },
    );
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'developer-local');

    const memoryOnly = materializeV3Target(ctx, {
      store,
      repository,
      targetName: 'app-env',
      mode: 'memory',
    });
    expect(memoryOnly.stagedArtifacts).toEqual([]);
    memoryOnly.cleanup();

    const persisted = materializeV3Target(ctx, {
      store,
      repository,
      targetName: 'app-env',
      mode: 'persisted',
      outputRoot,
    });

    expect(persisted.stagedArtifacts).toHaveLength(1);
    expect(nodeFs.existsSync(persisted.stagedArtifacts[0]!.path)).toBe(true);
    persisted.cleanup();
    expect(nodeFs.existsSync(persisted.stagedArtifacts[0]!.path)).toBe(true);
  });

  it('cleans staged artifacts on child-process failure and audits failure', () => {
    const { ctx } = createContext();
    const root = join(TEST_DIR, 'child-failure-target');
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
        app-env:
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
            env/apps/api/env/API_URL:
              value: https://example.com
              sensitive: false
        `,
      },
    );
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'developer-local');

    let stagedPath = '';

    expect(() =>
      withMaterializedTarget(ctx, {
        store,
        repository,
        targetName: 'app-env',
        mode: 'staged',
        command: { name: 'run', args: ['--', 'false'] },
      }, (materialization) => {
        stagedPath = materialization.stagedArtifacts[0]!.path;
        expect(nodeFs.existsSync(stagedPath)).toBe(true);
        throw new Error('child process failed');
      }),
    ).toThrow('child process failed');

    expect(nodeFs.existsSync(stagedPath)).toBe(false);
    const audits = nodeFs.readFileSync(store.auditLogPath!, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(audits.at(-1)).toMatchObject({ type: 'materialize', success: false, reason: 'child process failed' });
  }, 15000);

  it('cleans staged artifacts on simulated SIGINT and SIGTERM', () => {
    const { ctx, emitSignal } = createContext();
    const root = join(TEST_DIR, 'signal-target');
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
        app-env:
          bundle: app
          format: shell
      `,
      {
        'env/app/shared': `
          path: env/app/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/apps/api/env/API_URL:
              value: https://example.com
              sensitive: false
        `,
      },
    );
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'developer-local');

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      let stagedPath = '';

      expect(() =>
        withMaterializedTarget(ctx, {
          store,
          repository,
          targetName: 'app-env',
          mode: 'staged',
          command: { name: 'run', args: ['--', 'bun', 'dev'] },
        }, (materialization) => {
          stagedPath = materialization.stagedArtifacts[0]!.path;
          expect(nodeFs.existsSync(stagedPath)).toBe(true);
          emitSignal(signal);
        }),
      ).toThrow(`Materialization interrupted by ${signal}`);

      expect(nodeFs.existsSync(stagedPath)).toBe(false);
    }
  });

  it('emits shell-export syntax for shell-safe env exports', async () => {
    const { ctx } = createContext();
    const root = join(TEST_DIR, 'shell-export-target');
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
        app-env:
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
            env/apps/api/env/INLINE:
              value: has "quotes" and $dollar
              sensitive: false
            env/apps/api/env/PEM:
              value: |
                -----BEGIN KEY-----
                line1
                line2
                -----END KEY-----
              sensitive: true
        `,
      },
    );
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'developer-local');

    await materializeCommand(ctx, {
      store,
      target: 'app-env',
      json: false,
      format: 'shell-export',
      cleanup: false,
    });

    expect(ctx.logger.log).toHaveBeenCalledTimes(1);
    expect(ctx.logger.log).toHaveBeenCalledWith([
      'export INLINE="has \\"quotes\\" and $dollar"',
      "export PEM=$'-----BEGIN KEY-----\\nline1\\nline2\\n-----END KEY-----\\n'",
    ].join('\n'));
  });

  it('uses compact json paths by default when requested', async () => {
    const { ctx } = createContext();
    const root = join(TEST_DIR, 'compact-json-target');
    const outputRoot = join(TEST_DIR, 'compact-json-output');
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
            - path: env/app/shared
            - path: artifacts/app/runtime
      targets:
        runtime-files:
          bundle: runtime
          format: json
      `,
      {
        'env/app/shared': `
          path: env/app/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/apps/api/env/API_URL:
              value: https://example.com
              sensitive: false
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
        `,
      },
    );
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'developer-local');

    await materializeCommand(ctx, {
      store,
      target: 'runtime-files',
      json: true,
      compactJson: true,
      outputRoot,
      cleanup: false,
    });

    const payload = JSON.parse(vi.mocked(ctx.logger.log).mock.calls.at(-1)?.[0] ?? '{}');
    expect(payload.status).toBe('materialized');
    expect(payload.repositoryRoot).toBeUndefined();
    expect(payload.files).toBeUndefined();
    expect(payload.logicalPaths).toBeUndefined();
    expect(payload.targetArtifact).toMatchObject({
      logicalPath: 'targets/runtime-files',
      path: join(outputRoot, 'targets', 'runtime-files.json'),
      relativePath: 'targets/runtime-files.json',
      source: 'target',
    });
    expect(payload.targetArtifact.provenance).toBeUndefined();
    expect(payload.artifacts[0]).toMatchObject({
      logicalPath: 'artifacts/app/runtime/env-file',
      path: join(outputRoot, 'artifacts', 'app', 'runtime', 'env-file.env'),
      relativePath: 'artifacts/app/runtime/env-file.env',
      source: 'artifact',
    });
    expect(payload.artifacts[0].resolvedFrom).toBeUndefined();
  });

  it('adds provenance to json only when include-provenance is set', async () => {
    const { ctx } = createContext();
    const root = join(TEST_DIR, 'include-provenance-target');
    const outputRoot = join(TEST_DIR, 'include-provenance-output');
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
            - path: env/app/shared
      targets:
        runtime-files:
          bundle: runtime
          format: json
      `,
      {
        'env/app/shared': `
          path: env/app/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/apps/api/env/API_URL:
              value: https://example.com
              sensitive: false
        `,
      },
    );
    const store = createStore(root);
    setIdentity(ctx, store, repository, 'developer-local');

    await materializeCommand(ctx, {
      store,
      target: 'runtime-files',
      json: true,
      includeProvenance: true,
      outputRoot,
      cleanup: false,
    });

    const payload = JSON.parse(vi.mocked(ctx.logger.log).mock.calls.at(-1)?.[0] ?? '{}');
    expect(payload.repositoryRoot).toBe(root);
    expect(payload.files).toEqual(['env/app/shared']);
    expect(payload.logicalPaths).toEqual(['env/apps/api/env/API_URL']);
    expect(payload.targetArtifact.provenance).toBeDefined();
    expect(payload.targetArtifact.resolvedFrom).toEqual(['env/app/shared']);
  });

  it('hardens staged plaintext with private temp root and restrictive permissions', () => {
    const { ctx } = createContext();
    const root = join(TEST_DIR, 'perm-target');
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
            - path: artifacts/app/runtime
      targets:
        runtime-files:
          bundle: runtime
          format: json
      `,
      {
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
            artifacts/app/runtime/client-cert:
              type: binary
              format: binary
              encoding: base64
              value: SGVsbG8=
              sensitive: true
        `,
      },
    );
    const store = createStore(root);

    setIdentity(ctx, store, repository, 'developer-local');

    const materialization = materializeV3Target(ctx, {
      store,
      repository,
      targetName: 'runtime-files',
      mode: 'staged',
    });

    const firstArtifact = materialization.stagedArtifacts[0]!;
    const tempRoot = firstArtifact.path
      .split('/')
      .slice(0, -firstArtifact.logicalPath.split('/').filter(Boolean).length)
      .join('/') || '/';
    const modeMask = 0o777;

    for (const artifact of materialization.stagedArtifacts) {
      const dir = artifact.path.split('/').slice(0, -1).join('/');
      const dirStat = nodeFs.statSync(dir);
      const fileStat = nodeFs.statSync(artifact.path);
      const dirMode = dirStat.mode & modeMask;
      const fileMode = fileStat.mode & modeMask;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }

    const tempRootStat = nodeFs.statSync(tempRoot);
    const tempRootMode = tempRootStat.mode & modeMask;
    expect(tempRootMode).toBe(0o700);

    materialization.cleanup();
  });
});
