import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import { bootstrapCommand } from '../src/commands/bootstrap.js';
import { configCommand } from '../src/commands/config.js';
import { editCommand } from '../src/commands/edit.js';
import * as helpers from '../src/commands/v3-command-helpers.js';
import { decrypt, decryptYaml, encrypt, encryptYaml, encryptYamlContent, isSopsInstalled } from '../src/core/sops.js';
import type { HushContext, StoreContext } from '../src/types.js';
import { TEST_AGE_PRIVATE_KEY, TEST_AGE_PUBLIC_KEY, ensureTestSopsEnv } from './helpers/sops-test.js';

const TEST_DIR = join('/tmp', 'hush-test-edit-command');

function createStore(root: string): StoreContext {
  return {
    mode: 'project',
    root,
    configPath: null,
    keyIdentity: root,
    displayLabel: root,
    stateRoot: join(root, '.state-root'),
    projectStateRoot: join(root, '.state-root', 'projects', 'hush-test-edit-command'),
    activeIdentityPath: join(root, '.state-root', 'projects', 'hush-test-edit-command', 'active-identity.json'),
    auditLogPath: join(root, '.state-root', 'projects', 'hush-test-edit-command', 'audit.jsonl'),
  };
}

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
      stdin: process.stdin,
      stdout: process.stdout,
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    config: {
      loadConfig: vi.fn(),
      findProjectRoot: vi.fn(() => null),
    },
    age: {
      ageAvailable: vi.fn(() => true),
      ageGenerate: vi.fn(() => ({ private: TEST_AGE_PRIVATE_KEY, public: TEST_AGE_PUBLIC_KEY })),
      keyExists: vi.fn(() => false),
      keySave: vi.fn(),
      keyPath: vi.fn(() => join(TEST_DIR, 'keys', 'edit.txt')),
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
  };
}

describe('editCommand', () => {
  beforeEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function bootstrapEditableRepo(rootName: string): Promise<{ ctx: HushContext; store: StoreContext }> {
    const root = join(TEST_DIR, rootName);
    nodeFs.mkdirSync(root, { recursive: true });
    nodeFs.writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ repository: 'https://github.com/hassoncs/hush' }),
      'utf-8',
    );

    const ctx = createContext(root);
    const store = createStore(root);

    await bootstrapCommand(ctx, { store, yes: true });

    return { ctx, store };
  }

  it('denies edits when the active identity is not an owner', async () => {
    const { ctx, store } = await bootstrapEditableRepo('member-edit-denied');

    await configCommand(ctx, { store, subcommand: 'active-identity', args: ['member-local'] });

    await expect(editCommand(ctx, {
      store,
      file: 'shared',
    })).rejects.toThrow(/must have the owner role/i);
  });

  it('honors EDITOR env var when no override is provided', async () => {
    const { ctx, store } = await bootstrapEditableRepo('editor-env-var');
    const openEncryptedDocumentEditorSpy = vi.spyOn(helpers, 'openEncryptedDocumentEditor').mockImplementation(() => {
      return {} as never;
    });

    ctx.process.env.EDITOR = 'cat';

    await editCommand(ctx, {
      store,
      file: 'shared',
    });

    expect(openEncryptedDocumentEditorSpy).toHaveBeenCalledWith(
      ctx,
      store,
      expect.any(String),
      expect.anything(),
      undefined,
    );
  });

  it('prefers explicit editor override over EDITOR env var', async () => {
    const { ctx, store } = await bootstrapEditableRepo('editor-flag-override');
    const openEncryptedDocumentEditorSpy = vi.spyOn(helpers, 'openEncryptedDocumentEditor').mockImplementation(() => {
      return {} as never;
    });

    ctx.process.env.EDITOR = 'cat';

    await editCommand(ctx, {
      store,
      file: 'shared',
      editor: 'sed -n 1p',
    });

    expect(openEncryptedDocumentEditorSpy).toHaveBeenCalledWith(
      ctx,
      store,
      expect.any(String),
      expect.anything(),
      'sed -n 1p',
    );
    expect(ctx.logger.info).not.toHaveBeenCalled();
  });
});
