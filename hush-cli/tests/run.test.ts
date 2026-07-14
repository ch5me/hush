import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import { runCommand } from '../src/commands/run.js';
import type { HushContext, StoreContext } from '../src/types.js';

const TEST_DIR = join('/tmp', 'hush-test-run-command');

function createStore(root: string): StoreContext {
  return {
    mode: 'project',
    root,
    configPath: join(root, 'hush.yaml'),
    keyIdentity: root,
    displayLabel: root,
  };
}

function createContext(root: string): HushContext {
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
      findProjectRoot: vi.fn(),
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
      decrypt: vi.fn(() => ''),
      decryptYaml: vi.fn(() => ''),
      encrypt: vi.fn(),
      encryptYaml: vi.fn(),
      encryptYamlContent: vi.fn(),
      edit: vi.fn(),
      isSopsInstalled: vi.fn(() => true),
    },
  };
}

describe('runCommand legacy repo rejection', () => {
  beforeEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('fails with migration guidance when no v3 repository exists yet', async () => {
    const root = join(TEST_DIR, 'legacy-repo');
    nodeFs.mkdirSync(root, { recursive: true });
    nodeFs.writeFileSync(join(root, 'hush.yaml'), 'version: 2\nsources:\n  shared: .env\ntargets:\n  - name: root\n    path: .\n    format: dotenv\n', 'utf-8');
    nodeFs.writeFileSync(join(root, '.env.encrypted'), 'HELLO=world\n', 'utf-8');

    const ctx = createContext(root);
    await expect(runCommand(ctx, {
      store: createStore(root),
      cwd: root,
      env: 'development',
      command: ['echo', 'hello'],
    })).rejects.toThrow('Process exit: 1');

    expect(ctx.exec.spawnSync).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringMatching(/requires a v3 repository|Bootstrap or migrate before using this command/i));
  });

  it('rejects json mode with one structured stderr document before starting a child', async () => {
    const root = join(TEST_DIR, 'json-mode');
    const ctx = createContext(root);

    await expect(runCommand(ctx, {
      store: createStore(root),
      cwd: root,
      command: ['echo', 'synthetic'],
      json: true,
    })).rejects.toThrow('Process exit: 2');

    expect(ctx.logger.log).not.toHaveBeenCalled();
    expect(ctx.exec.spawnSync).not.toHaveBeenCalled();
    const errorLogger = ctx.logger.error as ReturnType<typeof vi.fn>;
    const payload = JSON.parse(String(errorLogger.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      version: 1,
      ok: false,
      command: 'run',
      error: { code: 'UNSUPPORTED_MACHINE_MODE' },
    });
  });
});
