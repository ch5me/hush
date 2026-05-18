import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import { hasCommand } from '../src/commands/has.js';
import { inspectCommand } from '../src/commands/inspect.js';
import { materializeCommand } from '../src/commands/materialize.js';
import { runCommand } from '../src/commands/run.js';
import { setCommand } from '../src/commands/set.js';
import { decrypt, decryptYaml, encrypt, encryptYaml, encryptYamlContent, isSopsInstalled } from '../src/core/sops.js';
import type { HushContext, LegacyHushConfig, StoreContext } from '../src/types.js';
import { TEST_AGE_PRIVATE_KEY, TEST_AGE_PUBLIC_KEY, ensureTestSopsEnv } from './helpers/sops-test.js';

const TEST_DIR = join('/tmp', 'hush-test-global-runtime');

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\u001B\[[0-9;]*m`, 'g'), '');
}

function createStore(root: string, mode: 'project' | 'global' = 'project'): StoreContext {
  const stateRoot = join(root, '.state-root');
  return {
    mode,
    root,
    configPath: mode === 'project' ? join(root, 'hush.yaml') : null,
    keyIdentity: mode === 'global' ? 'hush-global' : root,
    displayLabel: root,
    stateRoot: mode === 'global' ? stateRoot : undefined,
    projectStateRoot: mode === 'global' ? join(stateRoot, 'projects', 'hush-global-test') : undefined,
    activeIdentityPath: mode === 'global' ? join(stateRoot, 'projects', 'hush-global-test', 'active-identity.json') : undefined,
    auditLogPath: mode === 'global' ? join(stateRoot, 'projects', 'hush-global-test', 'audit.jsonl') : undefined,
  };
}

function createContext(cwd: string): {
  ctx: HushContext;
  logger: { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  spawnCalls: Array<{ cmd: string; args: readonly string[]; options: Parameters<typeof nodeSpawnSync>[2] }>;
} {
  ensureTestSopsEnv();

  const logger = {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
  const spawnCalls: Array<{ cmd: string; args: readonly string[]; options: Parameters<typeof nodeSpawnSync>[2] }> = [];
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
    ctx: {
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
        spawnSync: vi.fn((cmd: string, args: readonly string[], options?: Parameters<typeof nodeSpawnSync>[2]) => {
          spawnCalls.push({ cmd, args, options });
          return nodeSpawnSync(cmd, args, options) as SpawnSyncReturns<string>;
        }),
        execSync: vi.fn(() => ''),
      },
      logger,
      process: {
        cwd: () => cwd,
        exit: ((code: number) => {
          throw new Error(`Process exit: ${code}`);
        }) as never,
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
        ageGenerate: vi.fn(() => ({ private: TEST_AGE_PRIVATE_KEY, public: TEST_AGE_PUBLIC_KEY })),
        keyExists: vi.fn((identity: string) => identity === 'hush-global'),
        keySave: vi.fn(),
        keyPath: vi.fn(() => join(TEST_DIR, 'keys', 'hush-global.txt')),
        keyLoad: vi.fn(() => ({ private: TEST_AGE_PRIVATE_KEY, public: TEST_AGE_PUBLIC_KEY })),
        agePublicFromPrivate: vi.fn(() => TEST_AGE_PUBLIC_KEY),
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
    logger,
    spawnCalls,
  };
}

function getLogOutput(logger: { log: ReturnType<typeof vi.fn> }): string {
  return stripAnsi(logger.log.mock.calls.map(([message]) => String(message)).join('\n'));
}

function getLastLogOutput(logger: { log: ReturnType<typeof vi.fn> }): string {
  const lastCall = logger.log.mock.calls.at(-1);
  return stripAnsi(lastCall ? String(lastCall[0]) : '');
}

async function bootstrapGlobalSecret(ctx: HushContext, store: StoreContext, key: string, value: string): Promise<void> {
  await setCommand(ctx, { store, key, value });
}

describe('global store runtime regressions', () => {
  beforeEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('run --global preserves child side effects, inherits stdio, and propagates exit codes', { timeout: 15000 }, async () => {
    const globalRoot = join(TEST_DIR, 'global-store');
    const workspace = join(TEST_DIR, 'workspace');
    const sideEffectPath = join(workspace, 'child-output.txt');
    nodeFs.mkdirSync(workspace, { recursive: true });
    const { ctx, spawnCalls } = createContext(workspace);
    const store = createStore(globalRoot, 'global');

    await bootstrapGlobalSecret(ctx, store, 'TEST_KEY', 'test-value');

    await expect(runCommand(ctx, {
      store,
      cwd: workspace,
      env: 'development',
      command: ['sh', '-c', `printf hello > "${sideEffectPath}"`],
    })).rejects.toThrow('Process exit: 0');

    expect(nodeFs.readFileSync(sideEffectPath, 'utf-8')).toBe('hello');
    expect(spawnCalls[0]).toMatchObject({
      cmd: 'sh',
      args: ['-c', `printf hello > "${sideEffectPath}"`],
      options: expect.objectContaining({
        cwd: workspace,
        stdio: 'inherit',
        env: expect.objectContaining({ TEST_KEY: 'test-value' }),
      }),
    });

    await expect(runCommand(ctx, {
      store,
      cwd: workspace,
      env: 'development',
      command: ['sh', '-c', 'exit 7'],
    })).rejects.toThrow('Process exit: 7');
  });

  it('inspect --global reports readable entries with redaction', async () => {
    const globalRoot = join(TEST_DIR, 'global-store');
    const { ctx, logger } = createContext(globalRoot);
    const store = createStore(globalRoot, 'global');

    await bootstrapGlobalSecret(ctx, store, 'GLOBAL_API_KEY', 'secret-value');
    await inspectCommand(ctx, { store, env: 'development' });

    const output = getLogOutput(logger);
    expect(output).toContain('Active identity: owner-local');
    expect(output).toContain('Readable files: 1');
    expect(output).toContain('env/project/shared/GLOBAL_API_KEY');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('secret-value');
  });

  it('has --global follows non-empty value semantics', { timeout: 15000 }, async () => {
    const globalRoot = join(TEST_DIR, 'global-store');
    const { ctx, logger } = createContext(globalRoot);
    const store = createStore(globalRoot, 'global');

    await bootstrapGlobalSecret(ctx, store, 'PRESENT_KEY', 'value');

    await expect(hasCommand(ctx, {
      store,
      env: 'development',
      key: 'PRESENT_KEY',
      quiet: false,
    })).rejects.toThrow('Process exit: 0');

    await expect(hasCommand(ctx, {
      store,
      env: 'development',
      key: 'MISSING_KEY',
      quiet: false,
    })).rejects.toThrow('Process exit: 1');

    const output = getLogOutput(logger);
    expect(output).toContain('PRESENT_KEY is set (5 chars)');
    expect(output).toContain('MISSING_KEY not found in target runtime');
  });

  it('materialize --global --json emits metadata for persisted outputs', async () => {
    const globalRoot = join(TEST_DIR, 'global-store');
    const outputRoot = join(TEST_DIR, 'materialized-output');
    const { ctx, logger } = createContext(globalRoot);
    const store = createStore(globalRoot, 'global');

    await bootstrapGlobalSecret(ctx, store, 'TEST_KEY', 'test-value');
    logger.log.mockClear();
    await materializeCommand(ctx, {
      store,
      target: 'runtime',
      json: true,
      outputRoot,
      cleanup: false,
      command: [],
    });

    const payload = JSON.parse(getLastLogOutput(logger));
    expect(payload).toMatchObject({
      kind: 'target',
      target: 'runtime',
      outputRoot,
      files: ['env/project/shared'],
      logicalPaths: ['env/project/shared/TEST_KEY'],
    });
    expect(payload.targetArtifact.path).toBe(join(outputRoot, 'targets', 'runtime.env'));
    expect(nodeFs.existsSync(payload.targetArtifact.path)).toBe(true);
  });
});
