import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import { loadLegacyV2Inventory } from '../../src/v3/legacy-v2.js';
import { createFileDocument } from '../../src/index.js';
import { loadV3Repository, persistV3FileDocument, persistV3ManifestDocument } from '../../src/v3/repository.js';
import { ensureEncryptedFixtureRepo, ensureTestSopsConfig, writeEncryptedYamlFile } from '../helpers/sops-test.js';

const TESTS_DIR = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES_DIR = join(TESTS_DIR, 'fixtures');
const TMP_DIR = join(TESTS_DIR, 'tmp-v3-repository-tests');

function resetTempDir(): void {
  nodeFs.rmSync(TMP_DIR, { recursive: true, force: true });
  nodeFs.mkdirSync(TMP_DIR, { recursive: true });
}

afterEach(() => {
  nodeFs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('loadV3Repository', () => {
  it('loads an encrypted v3 repository fixture as the runtime authority', () => {
    const fixtureRoot = join(FIXTURES_DIR, 'v3/already-migrated-repo');
    ensureEncryptedFixtureRepo(fixtureRoot);
    const repository = loadV3Repository(fixtureRoot, { keyIdentity: fixtureRoot });

    expect(repository.kind).toBe('v3');
    expect(repository.manifest.identities.ci.roles).toContain('ci');
    expect(repository.filesByPath['artifacts/api/runtime']?.logicalPaths).toContain('artifacts/api/runtime/env-file');
    expect(repository.loadFile('artifacts/api/runtime').entries['artifacts/api/runtime/env-file']).toBeDefined();
    expect(repository.fileSystemPaths['env/app/shared']).toContain('.hush/files/env/app/shared.encrypted');
  });

  it('fails clearly when the manifest is missing', () => {
    resetTempDir();
    ensureTestSopsConfig(TMP_DIR);
    nodeFs.mkdirSync(join(TMP_DIR, '.hush/files/env/app'), { recursive: true });
    writeEncryptedYamlFile(
      TMP_DIR,
      join(TMP_DIR, '.hush/files/env/app/shared.encrypted'),
      [
        'path: env/app/shared',
        'readers:',
        '  roles: [owner]',
        '  identities: [dev]',
        'sensitive: false',
        'entries:',
        '  env/apps/web/env/NEXT_PUBLIC_API_URL:',
        '    value: https://example.com',
        '    sensitive: false',
      ].join('\n'),
    );

    expect(() => loadV3Repository(TMP_DIR)).toThrowError(/Missing v3 manifest/i);
    expect(() => loadV3Repository(TMP_DIR)).toThrowError(/hush bootstrap/i);
  });

  it('defers file doc validation until the file is actually loaded', () => {
    resetTempDir();
    ensureTestSopsConfig(TMP_DIR);
    nodeFs.mkdirSync(join(TMP_DIR, '.hush/files/env/app'), { recursive: true });
    writeEncryptedYamlFile(
      TMP_DIR,
      join(TMP_DIR, '.hush/manifest.encrypted'),
      [
        'version: 3',
        'identities:',
        '  dev:',
        '    roles: [owner]',
        'fileIndex:',
        '  env/app/shared:',
        '    path: env/app/shared',
        '    readers:',
        '      roles: [owner]',
        '      identities: [dev]',
        '    sensitive: false',
        '    logicalPaths:',
        '      - env/apps/web/env/NEXT_PUBLIC_API_URL',
        'bundles:',
        '  app:',
        '    files:',
        '      - path: env/app/shared',
      ].join('\n'),
    );
    writeEncryptedYamlFile(
      TMP_DIR,
      join(TMP_DIR, '.hush/files/env/app/shared.encrypted'),
      [
        'path: env/app/other',
        'readers:',
        '  roles: [owner]',
        '  identities: [dev]',
        'sensitive: false',
        'entries:',
        '  env/apps/web/env/NEXT_PUBLIC_API_URL:',
        '    value: https://example.com',
        '    sensitive: false',
      ].join('\n'),
    );

    const repository = loadV3Repository(TMP_DIR);

    expect(() => repository.loadFile('env/app/shared')).toThrowError(/Invalid v3 file document/i);
    expect(() => repository.loadFile('env/app/shared')).toThrowError(/does not match repository location/i);
  });
});

describe('loadLegacyV2Inventory', () => {
  it('extracts migration inventory from current hush.yaml repositories', () => {
    const projectRoot = join(FIXTURES_DIR, 'monorepo');
    const inventory = loadLegacyV2Inventory(projectRoot, join(projectRoot, 'hush.yaml'));

    expect(inventory.kind).toBe('legacy-v2');
    expect(inventory.sources.map((source) => source.name)).toEqual([
      'shared',
      'development',
      'production',
      'local',
    ]);
    expect(inventory.targets.map((target) => target.name)).toEqual(['root', 'app', 'api']);
    expect(inventory.config.targets[1]?.include).toContain('EXPO_PUBLIC_*');
  });
});

describe('persistV3ManifestDocument', () => {
  it('writes a valid manifest to manifest.encrypted and updates repository.manifest', () => {
    const fixtureRoot = join(FIXTURES_DIR, 'v3/already-migrated-repo');
    ensureEncryptedFixtureRepo(fixtureRoot);
    const repository = loadV3Repository(fixtureRoot, { keyIdentity: fixtureRoot });

    const nextManifest = {
      ...repository.manifest,
      metadata: { updatedAt: '2026-01-01' },
    };

    const mockCtx = {
      sops: {
        encryptYamlContent: vi.fn(),
      },
    } as unknown as Parameters<typeof persistV3ManifestDocument>[0];

    const result = persistV3ManifestDocument(
      mockCtx,
      { root: fixtureRoot, keyIdentity: fixtureRoot },
      repository,
      nextManifest,
    );

    expect(mockCtx.sops.encryptYamlContent).toHaveBeenCalledOnce();
    const [content, manifestPath] = mockCtx.sops.encryptYamlContent.mock.calls[0]!;
    expect(manifestPath).toContain('manifest.encrypted');
    expect(result.metadata?.updatedAt).toBe('2026-01-01');
    expect(repository.manifest.metadata?.updatedAt).toBe('2026-01-01');
  });

  it('throws before disk write when manifest is invalid (wrong version)', () => {
    const fixtureRoot = join(FIXTURES_DIR, 'v3/already-migrated-repo');
    ensureEncryptedFixtureRepo(fixtureRoot);
    const repository = loadV3Repository(fixtureRoot, { keyIdentity: fixtureRoot });

    const invalidManifest = {
      ...repository.manifest,
      version: '999', // invalid version
    };

    const encryptSpy = vi.fn();
    const mockCtx = {
      sops: {
        encryptYamlContent: encryptSpy,
      },
    } as unknown as Parameters<typeof persistV3ManifestDocument>[0];

    expect(() =>
      persistV3ManifestDocument(
        mockCtx,
        { root: fixtureRoot, keyIdentity: fixtureRoot },
        repository,
        invalidManifest,
      ),
    ).toThrowError(/version/i);

    expect(encryptSpy).not.toHaveBeenCalled();
  });

  it('throws before disk write when manifest references a non-declared active identity', () => {
    const fixtureRoot = join(FIXTURES_DIR, 'v3/already-migrated-repo');
    ensureEncryptedFixtureRepo(fixtureRoot);
    const repository = loadV3Repository(fixtureRoot, { keyIdentity: fixtureRoot });

    const invalidManifest = {
      ...repository.manifest,
      activeIdentity: 'non-existent-identity',
    };

    const encryptSpy = vi.fn();
    const mockCtx = {
      sops: {
        encryptYamlContent: encryptSpy,
      },
    } as unknown as Parameters<typeof persistV3ManifestDocument>[0];

    expect(() =>
      persistV3ManifestDocument(
        mockCtx,
        { root: fixtureRoot, keyIdentity: fixtureRoot },
        repository,
        invalidManifest,
      ),
    ).toThrowError(/active identity/i);

    expect(encryptSpy).not.toHaveBeenCalled();
  });

  it('throws before disk write when manifest has an empty bundle name', () => {
    const fixtureRoot = join(FIXTURES_DIR, 'v3/already-migrated-repo');
    ensureEncryptedFixtureRepo(fixtureRoot);
    const repository = loadV3Repository(fixtureRoot, { keyIdentity: fixtureRoot });

    const invalidManifest = {
      ...repository.manifest,
      bundles: {
        '': {
          files: [],
        },
      },
    };

    const encryptSpy = vi.fn();
    const mockCtx = {
      sops: {
        encryptYamlContent: encryptSpy,
      },
    } as unknown as Parameters<typeof persistV3ManifestDocument>[0];

    expect(() =>
      persistV3ManifestDocument(
        mockCtx,
        { root: fixtureRoot, keyIdentity: fixtureRoot },
        repository,
        invalidManifest,
      ),
    ).toThrowError(/empty/i);

    expect(encryptSpy).not.toHaveBeenCalled();
  });

  it('refreshes the in-memory file cache after file writes', () => {
    const fixtureRoot = join(FIXTURES_DIR, 'v3/already-migrated-repo');
    ensureEncryptedFixtureRepo(fixtureRoot);
    const repository = loadV3Repository(fixtureRoot, { keyIdentity: fixtureRoot });
    const initial = repository.loadFile('env/app/shared');

    const nextDocument = createFileDocument({
      ...initial,
      entries: {},
    });

    const mockCtx = {
      sops: {
        encryptYamlContent: vi.fn(),
      },
    } as unknown as Parameters<typeof persistV3FileDocument>[0];

    persistV3FileDocument(
      mockCtx,
      { root: fixtureRoot, keyIdentity: fixtureRoot },
      repository,
      repository.fileSystemPaths['env/app/shared']!,
      nextDocument,
    );

    expect(repository.loadFile('env/app/shared').entries).toEqual({});
  });
});
