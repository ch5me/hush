import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import {
  appendAuditEvent,
  createProjectSlug,
  getActiveIdentity,
  getProjectStatePaths,
  readActiveIdentityState,
  setActiveIdentity,
  type ActiveIdentityStateDocument,
} from '../../src/index.js';
import type { HushContext, LegacyHushConfig, StoreContext } from '../../src/types.js';

const TEST_DIR = join('/tmp', 'hush-test-v3-identity-audit');

function createContext(): HushContext {
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

function createStore(mode: 'project' | 'global' = 'project'): StoreContext {
  const root = join(TEST_DIR, mode);
  const stateRoot = join(TEST_DIR, '.machine-state');
  const projectSlug = createProjectSlug(mode === 'global' ? 'hush-global' : 'acme/hush');
  const projectStateRoot = join(stateRoot, 'projects', projectSlug);

  return {
    mode,
    root,
    configPath: mode === 'project' ? join(root, 'hush.yaml') : null,
    keyIdentity: mode === 'global' ? 'hush-global' : 'acme/hush',
    displayLabel: root,
    projectSlug,
    stateRoot,
    projectStateRoot,
    activeIdentityPath: join(projectStateRoot, 'active-identity.json'),
    auditLogPath: join(projectStateRoot, 'audit.jsonl'),
  };
}

describe('v3 identity and audit primitives', () => {
  beforeEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('round-trips the active identity and emits an identity change audit event', () => {
    const ctx = createContext();
    const store = createStore();

    const document = setActiveIdentity(ctx, {
      store,
      identity: 'owner-local',
      identities: ['owner-local', 'ci'],
      command: { name: 'config', args: ['active-identity', 'owner-local'] },
    });

    const stored = readActiveIdentityState(ctx, store) as ActiveIdentityStateDocument;
    const auditPath = getProjectStatePaths(store).auditLogPath;
    const auditLines = nodeFs.readFileSync(auditPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));

    expect(document.identity).toBe('owner-local');
    expect(stored.identity).toBe('owner-local');
    expect(getActiveIdentity(ctx, store)).toBe('owner-local');
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0]).toMatchObject({
      type: 'identity_change',
      success: true,
      activeIdentity: 'owner-local',
      nextIdentity: 'owner-local',
      requestedIdentity: 'owner-local',
    });
  });

  it('rejects invalid identities without mutating the pointer and records access denial', () => {
    const ctx = createContext();
    const store = createStore();

    setActiveIdentity(ctx, {
      store,
      identity: 'owner-local',
      identities: ['owner-local', 'ci'],
      command: { name: 'config', args: ['active-identity', 'owner-local'] },
    });

    expect(() =>
      setActiveIdentity(ctx, {
        store,
        identity: 'ghost',
        identities: ['owner-local', 'ci'],
        command: { name: 'config', args: ['active-identity', 'ghost'] },
      }),
    ).toThrow('Identity "ghost" is not declared in this repository');

    const auditPath = getProjectStatePaths(store).auditLogPath;
    const auditLines = nodeFs.readFileSync(auditPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));

    expect(getActiveIdentity(ctx, store)).toBe('owner-local');
    expect(auditLines).toHaveLength(2);
    expect(auditLines[1]).toMatchObject({
      type: 'access_denied',
      success: false,
      activeIdentity: 'owner-local',
      requestedIdentity: 'ghost',
    });
  });

  it('appends audit records as JSONL without truncating earlier lines', () => {
    const ctx = createContext();
    const store = createStore();
    const auditPath = getProjectStatePaths(store).auditLogPath;

    appendAuditEvent(ctx, store, {
      type: 'read_attempt',
      activeIdentity: 'owner-local',
      success: true,
      command: { name: 'inspect', args: ['env/project/shared'] },
      files: ['env/project/shared'],
    });

    const firstContents = nodeFs.readFileSync(auditPath, 'utf-8');

    appendAuditEvent(ctx, store, {
      type: 'materialize',
      activeIdentity: 'owner-local',
      success: true,
      command: { name: 'run', args: ['--', 'npm', 'start'] },
      files: ['env/project/shared'],
      target: 'web',
    });

    const secondContents = nodeFs.readFileSync(auditPath, 'utf-8');
    const auditLines = secondContents.trim().split('\n').map((line) => JSON.parse(line));

    expect(secondContents.startsWith(firstContents)).toBe(true);
    expect(auditLines).toHaveLength(2);
    expect(auditLines[0].type).toBe('read_attempt');
    expect(auditLines[1].type).toBe('materialize');
  });

  it('reports degraded audit telemetry without converting the operation into a failure', () => {
    const ctx = createContext();
    const store = createStore();
    ctx.fs.writeFileSync = vi.fn(() => {
      throw new Error('synthetic audit sink failure');
    });

    expect(() => appendAuditEvent(ctx, store, {
      type: 'write',
      activeIdentity: 'owner-local',
      success: true,
      command: { name: 'set', args: ['KEY'] },
    })).not.toThrow();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('synthetic audit sink failure'),
    );
  });
});
