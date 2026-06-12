import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import { parseArgs } from '../src/cli.js';
import { migrateCommand } from '../src/commands/migrate.js';
import { createProjectSlug } from '../src/index.js';
import { decrypt, decryptYaml, encryptYamlContent } from '../src/core/sops.js';
import type { HushContext } from '../src/types.js';
import { ensureTestSopsEnv, readDecryptedYamlFile, writeEncryptedDotenvFile } from './helpers/sops-test.js';

const TEST_DIR = join('/tmp', 'hush-test-migrate-v2-to-v3');
const ORIGINAL_HOME = process.env.HOME;

function createContext(root: string): HushContext {
  ensureTestSopsEnv();

  return {
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
    logger: {
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    },
    process: {
      cwd: () => root,
      exit: ((code: number) => { throw new Error(`Process exit: ${code}`); }) as never,
      env: {},
      stdin: {} as NodeJS.ReadStream,
      stdout: { write: vi.fn() } as unknown as NodeJS.WriteStream,
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    config: {
      loadConfig: vi.fn(),
      findProjectRoot: vi.fn((startDir: string) => ({
        repositoryKind: 'legacy-v2' as const,
        configPath: join(startDir, 'hush.yaml'),
        projectRoot: startDir,
      })),
    },
    age: {
      ageAvailable: vi.fn(() => true),
      ageGenerate: vi.fn(),
      keyExists: vi.fn(() => false),
      keySave: vi.fn(),
      keyPath: vi.fn(() => ''),
      keyLoad: vi.fn(() => null),
      agePublicFromPrivate: vi.fn(() => ''),
    },
    sops: {
      decrypt: vi.fn((filePath: string, options?: { root?: string; keyIdentity?: string }) => decrypt(filePath, options)),
      decryptYaml: vi.fn((filePath: string, options?: { root?: string; keyIdentity?: string }) => decryptYaml(filePath, options)),
      encrypt: vi.fn(),
      encryptYaml: vi.fn(),
      encryptYamlContent: vi.fn((content: string, outputPath: string, options?: { root?: string; keyIdentity?: string }) => encryptYamlContent(content, outputPath, options)),
      edit: vi.fn(),
      isSopsInstalled: vi.fn(() => true),
    },
  };
}

function writeLegacyRepo(root: string, overrides?: { pagesTarget?: boolean; plaintextLocal?: string; sharedOverrideContent?: string }): void {
  nodeFs.mkdirSync(root, { recursive: true });
  nodeFs.writeFileSync(join(root, 'hush.yaml'), `version: 2
project: test/repo
sources:
  shared: .env
  development: .env.development
  production: .env.production
  local: .env.local
targets:
  - name: web
    path: ./apps/web
    format: dotenv
    include:
      - NEXT_PUBLIC_*
  - name: api
    path: ./apps/api
    format: wrangler
    exclude:
      - NEXT_PUBLIC_*
${overrides?.pagesTarget ? '  - name: pages\n    path: ./apps/pages\n    format: wrangler\n    push_to:\n      type: cloudflare-pages\n      project: docs\n' : ''}`.replace(/^\n/, ''), 'utf-8');
  writeEncryptedDotenvFile(root, join(root, '.env.encrypted'), overrides?.sharedOverrideContent ?? 'DATABASE_URL=postgres://db\nNEXT_PUBLIC_API_URL=https://example.com');
  writeEncryptedDotenvFile(root, join(root, '.env.development.encrypted'), 'DEBUG=true\nAPI_BASE=http://localhost:3000');
  writeEncryptedDotenvFile(root, join(root, '.env.production.encrypted'), 'DEBUG=false\nAPI_BASE=https://api.example.com');
  if (overrides?.plaintextLocal) {
    nodeFs.writeFileSync(join(root, '.env.local'), `${overrides.plaintextLocal}\n`, 'utf-8');
  } else {
    writeEncryptedDotenvFile(root, join(root, '.env.local.encrypted'), 'LOCAL_ONLY=yes');
  }
  nodeFs.writeFileSync(join(root, 'README.md'), 'Use `hush run -- npm start` after migration.\n', 'utf-8');
}

describe('migrateCommand v2 -> v3', () => {
  beforeEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
    process.env.HOME = join(TEST_DIR, 'home');
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    process.env.HOME = ORIGINAL_HOME;
    vi.clearAllMocks();
  });

  it('inventories a legacy repo in dry-run mode without mutating it', async () => {
    const root = join(TEST_DIR, 'dry-run-repo');
    writeLegacyRepo(root);
    const ctx = createContext(root);

    await migrateCommand(ctx, { root, dryRun: true, from: 'v2', cleanup: false });

    expect(nodeFs.existsSync(join(root, 'hush.yaml'))).toBe(true);
    expect(nodeFs.existsSync(join(root, '.hush', 'manifest.encrypted'))).toBe(false);
    expect(ctx.sops.decrypt).not.toHaveBeenCalled();
  });

  it('converts a legacy repo to v3 state and writes machine-local overrides', async () => {
    const root = join(TEST_DIR, 'migrate-repo');
    writeLegacyRepo(root);
    const ctx = createContext(root);

    await migrateCommand(ctx, { root, dryRun: false, from: 'v2', cleanup: false });

    expect(nodeFs.existsSync(join(root, '.hush', 'manifest.encrypted'))).toBe(true);
    expect(nodeFs.existsSync(join(root, '.hush', 'files', 'env', 'project', 'shared.encrypted'))).toBe(true);
    expect(nodeFs.existsSync(join(root, '.hush', 'files', 'env', 'project', 'development.encrypted'))).toBe(true);
    expect(nodeFs.existsSync(join(root, '.hush', 'files', 'env', 'project', 'production.encrypted'))).toBe(true);
    expect(nodeFs.existsSync(join(root, '.hush', 'migration-v2-state.json'))).toBe(true);
    expect(nodeFs.existsSync(join(root, 'hush.yaml'))).toBe(true);

    const manifest = readDecryptedYamlFile(root, join(root, '.hush', 'manifest.encrypted'));
    expect(manifest).toContain('owner-local');
    expect(manifest).toContain('web-production');
    expect(manifest).toContain('api-production');

    const projectSlug = createProjectSlug('test/repo');
    const localOverridePath = join(process.env.HOME!, '.hush', 'state', 'projects', projectSlug, 'user', 'local-overrides.encrypted');
    expect(nodeFs.existsSync(localOverridePath)).toBe(true);
    expect(readDecryptedYamlFile(root, localOverridePath)).toContain('env/project/local/LOCAL_ONLY');
  }, 60000);

  it('cleanup is rerun-safe and removes transitional leftovers after validation', async () => {
    const root = join(TEST_DIR, 'cleanup-repo');
    writeLegacyRepo(root);
    const ctx = createContext(root);

    await migrateCommand(ctx, { root, dryRun: false, from: 'v2', cleanup: false });
    await migrateCommand(ctx, { root, dryRun: false, from: 'v2', cleanup: true });
    await migrateCommand(ctx, { root, dryRun: false, from: 'v2', cleanup: true });

    expect(nodeFs.existsSync(join(root, 'hush.yaml'))).toBe(false);
    expect(nodeFs.existsSync(join(root, '.env.encrypted'))).toBe(false);
    expect(nodeFs.existsSync(join(root, '.env.local.encrypted'))).toBe(false);
    expect(nodeFs.existsSync(join(root, '.hush', 'migration-v2-state.json'))).toBe(false);
  }, 60000);

  it('short-circuits safely when the repo is already migrated', async () => {
    const root = join(TEST_DIR, 'already-migrated');
    writeLegacyRepo(root);
    const ctx = createContext(root);

    await migrateCommand(ctx, { root, dryRun: false, from: 'v2', cleanup: false });
    const firstManifest = readDecryptedYamlFile(root, join(root, '.hush', 'manifest.encrypted'));

    await migrateCommand(ctx, { root, dryRun: false, from: 'v2', cleanup: false });

    expect(readDecryptedYamlFile(root, join(root, '.hush', 'manifest.encrypted'))).toBe(firstManifest);
    expect(ctx.logger.log).toHaveBeenCalledWith(expect.stringMatching(/already has \.hush\/ v3 state/i));
  }, 60000);

  it('fails without leaving mixed state when .hush is still a legacy file', async () => {
    const root = join(TEST_DIR, 'root-file-conflict');
    writeLegacyRepo(root);
    nodeFs.writeFileSync(join(root, '.hush'), 'LEGACY_TEMPLATE=yes\n', 'utf-8');
    const ctx = createContext(root);

    await expect(migrateCommand(ctx, { root, dryRun: false, from: 'v2', cleanup: false })).rejects.toThrow(/is a file/i);

    expect(nodeFs.existsSync(join(root, '.hush', 'manifest.encrypted'))).toBe(false);
    expect(nodeFs.existsSync(join(root, 'hush.yaml'))).toBe(true);
    expect(nodeFs.existsSync(join(root, '.env.encrypted'))).toBe(true);
  });

  it('fails clearly on keyless template repos and recommends hush bootstrap', async () => {
    const root = join(TEST_DIR, 'keyless-template-repo');
    nodeFs.mkdirSync(root, { recursive: true });
    nodeFs.writeFileSync(join(root, 'hush.yaml'), 'version: 2\nproject: test/keyless\nsources:\n  shared: .hush\ntargets: []\n', 'utf-8');
    const ctx = createContext(root);

    await expect(migrateCommand(ctx, { root, dryRun: false, from: 'v2', cleanup: false })).rejects.toThrow(/hush bootstrap/i);
    expect(nodeFs.existsSync(join(root, '.hush', 'manifest.encrypted'))).toBe(false);
  });

  it('repairs bare .hush gitignore entries so v3 files remain committable', async () => {
    const root = join(TEST_DIR, 'gitignore-repo');
    writeLegacyRepo(root);
    nodeFs.writeFileSync(join(root, '.gitignore'), '.hush\nnode_modules\n', 'utf-8');
    const ctx = createContext(root);

    await migrateCommand(ctx, { root, dryRun: false, from: 'v2', cleanup: false });

    const gitignore = nodeFs.readFileSync(join(root, '.gitignore'), 'utf-8');
    expect(gitignore).not.toMatch(/^\.hush\/?$/m);
    expect(gitignore).toMatch(/^\.hush-materialized\/$/m);
    expect(ctx.logger.log).toHaveBeenCalledWith(expect.stringMatching(/Updated \.gitignore/i));
  }, 60000);

  it('migrates plaintext local overrides and resolves self-referential placeholders before v3 validation', async () => {
    const root = join(TEST_DIR, 'plaintext-local-repo');
    writeLegacyRepo(root, {
      sharedOverrideContent: 'OLLAMA_API_KEY=${OLLAMA_API_KEY}\nOPENROUTER_API_KEY=${OPENROUTER_API_KEY}',
      plaintextLocal: 'OLLAMA_API_KEY=http://localhost:11434\nOPENROUTER_API_KEY=sk-local',
    });
    const ctx = createContext(root);

    await migrateCommand(ctx, { root, dryRun: false, from: 'v2', cleanup: false });

    const runtimeFile = readDecryptedYamlFile(root, join(root, '.hush', 'files', 'env', 'targets', 'api', 'runtime.encrypted'));
    const localFile = readDecryptedYamlFile(root, join(process.env.HOME!, '.hush', 'state', 'projects', createProjectSlug('test/repo'), 'user', 'local-overrides.encrypted'));

    expect(runtimeFile).toContain('http://localhost:11434');
    expect(runtimeFile).not.toContain('${OLLAMA_API_KEY}');
    expect(localFile).toContain('env/project/local/OLLAMA_API_KEY');
  }, 60000);

  it('fails migration with a clear unresolved interpolation error before v3 materialization crashes', async () => {
    const root = join(TEST_DIR, 'unresolved-placeholder-repo');
    writeLegacyRepo(root, {
      sharedOverrideContent: 'OLLAMA_API_KEY=${OLLAMA_API_KEY}\n',
    });
    const ctx = createContext(root);

    await expect(migrateCommand(ctx, { root, dryRun: false, from: 'v2', cleanup: false })).rejects.toThrow(/Legacy interpolation placeholders remained unresolved/i);
    expect(nodeFs.existsSync(join(root, '.hush', 'manifest.encrypted'))).toBe(false);
  });

  it('migrates cloudflare pages targets and preserves their deployment metadata', async () => {
    const root = join(TEST_DIR, 'pages-repo');
    writeLegacyRepo(root, { pagesTarget: true });
    const ctx = createContext(root);

    await migrateCommand(ctx, { root, dryRun: false, from: 'v2', cleanup: false });

    const manifest = readDecryptedYamlFile(root, join(root, '.hush', 'manifest.encrypted'));
    expect(manifest).toContain('pages:');
    expect(manifest).toContain('pages-production:');
    expect(manifest).toContain('type: cloudflare-pages');
    expect(manifest).toContain('project: docs');
  }, 60000);

  it('migrates object-keyed legacy targets without crashing', async () => {
    const root = join(TEST_DIR, 'object-keyed-targets');
    nodeFs.mkdirSync(root, { recursive: true });
    nodeFs.writeFileSync(join(root, 'hush.yaml'), `version: 2
project: test/object-keyed
sources:
  shared: .hush
targets:
  api:
    path: ./apps/api
    format: wrangler
    exclude:
      - NEXT_PUBLIC_*
  web:
    path: ./apps/web
    format: dotenv
    include:
      - NEXT_PUBLIC_*
  schema_only:
    env:
      NODE_ENV: production
`, 'utf-8');
    writeEncryptedDotenvFile(root, join(root, '.hush.encrypted'), 'DATABASE_URL=postgres://db\nNEXT_PUBLIC_API_URL=https://example.com');
    const ctx = createContext(root);

    await migrateCommand(ctx, { root, dryRun: false, from: 'v2', cleanup: false });

    const manifest = readDecryptedYamlFile(root, join(root, '.hush', 'manifest.encrypted'));
    expect(manifest).toContain('api:');
    expect(manifest).toContain('web:');
    expect(manifest).not.toContain('schema_only:');
  }, 60000);

  it('parses migrate flags correctly', () => {
    const parsed = parseArgs(['migrate', '--from', 'v2', '--cleanup', '--dry-run']);

    expect(parsed.command).toBe('migrate');
    expect(parsed.from).toBe('v2');
    expect(parsed.cleanup).toBe(true);
    expect(parsed.dryRun).toBe(true);
  });

  it('parses --cwd as a migrate root alias', () => {
    const parsed = parseArgs(['--cwd', '/tmp/custom-root', 'migrate', '--from', 'v2']);

    expect(parsed.command).toBe('migrate');
    expect(parsed.root).toBe('/tmp/custom-root');
    expect(parsed.from).toBe('v2');
  });
});
