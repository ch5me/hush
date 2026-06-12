import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { diffCommand } from '../src/commands/diff.js';
import { exportExampleCommand } from '../src/commands/export-example.js';
import { createFileDocument, createFileIndexEntry, createManifestDocument, createProjectSlug, loadV3Repository, setActiveIdentity } from '../src/index.js';
import { decrypt, decryptYaml, encrypt, encryptYaml, encryptYamlContent, isSopsInstalled } from '../src/core/sops.js';
import type { HushContext, HushManifestDocument, LegacyHushConfig, StoreContext } from '../src/types.js';
import { ensureTestSopsEnv, writeEncryptedYamlFile } from './helpers/sops-test.js';

const TEST_DIR = join('/tmp', 'hush-test-diff-export-example');

interface GitHistoryState {
  manifest: string;
  files: Record<string, string>;
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\u001B\[[0-9;]*m`, 'g'), '');
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

function parseGitShow(command: string): { ref: string; path: string } {
  const match = command.match(/show '([^']+):([^']+)'$/);
  if (!match) {
    throw new Error(`Unexpected git show command: ${command}`);
  }

  return {
    ref: match[1]!,
    path: match[2]!,
  };
}

function parseGitLsTree(command: string): { ref: string; prefix: string } {
  const match = command.match(/ls-tree -r --name-only '([^']+)' -- '([^']+)'$/);
  if (!match) {
    throw new Error(`Unexpected git ls-tree command: ${command}`);
  }

  return {
    ref: match[1]!,
    prefix: match[2]!,
  };
}

function createContext(root: string, history: Record<string, GitHistoryState>) {
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

  const execSync = vi.fn((command: string) => {
    if (command.includes('rev-parse --show-prefix')) {
      return '\n';
    }

    if (command.includes('rev-parse --show-toplevel')) {
      return `${root}\n`;
    }

    if (command.includes('ls-tree -r --name-only')) {
      const { ref, prefix } = parseGitLsTree(command);
      const state = history[ref];
      if (!state) {
        throw new Error(`Unknown git ref: ${ref}`);
      }

      const files = Object.keys(state.files)
        .map((filePath) => `${prefix}/${filePath}.encrypted`)
        .sort();

      return files.join('\n');
    }

    if (command.includes(' show ')) {
      const { ref, path } = parseGitShow(command);
      const state = history[ref];
      if (!state) {
        throw new Error(`Unknown git ref: ${ref}`);
      }

      if (path === '.hush/manifest.encrypted') {
        return state.manifest;
      }

      const relativeFile = path.replace(/^\.hush\/files\//, '').replace(/\.encrypted$/, '');
      const content = state.files[relativeFile];
      if (!content) {
        throw new Error(`Missing git file ${relativeFile} at ${ref}`);
      }

      return content;
    }

    throw new Error(`Unexpected execSync command: ${command}`);
  });

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
      execSync,
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

  return { ctx, logger, store: createStore(root), execSync };
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

function createEncryptedGitHistoryState(root: string, state: { manifest: string; files: Record<string, string> }, ref: string): GitHistoryState {
  const historyRoot = join(TEST_DIR, '.git-history', ref.replace(/[^a-zA-Z0-9._-]/g, '_'));
  nodeFs.mkdirSync(join(historyRoot, '.hush', 'files'), { recursive: true });

  const manifestPath = join(historyRoot, '.hush', 'manifest.encrypted');
  const parsedFiles = Object.values(state.files).map((content) => createFileDocument(parseYaml(normalizeYaml(content))));
  const manifestDocument = createManifestDocument({
    ...(parseYaml(normalizeYaml(state.manifest)) as Record<string, unknown>),
    fileIndex: Object.fromEntries(parsedFiles.map((file) => [file.path, createFileIndexEntry(file)])),
  } as HushManifestDocument);
  writeEncryptedYamlFile(root, manifestPath, stringifyYaml(manifestDocument, { indent: 2 }));

  const files: Record<string, string> = {};
  for (const [relativePath, content] of Object.entries(state.files)) {
    const encryptedPath = join(historyRoot, '.hush', 'files', `${relativePath}.encrypted`);
    writeEncryptedYamlFile(root, encryptedPath, normalizeYaml(content));
    files[relativePath] = nodeFs.readFileSync(encryptedPath, 'utf-8');
  }

  return {
    manifest: nodeFs.readFileSync(manifestPath, 'utf-8'),
    files,
  };
}

function setIdentity(ctx: HushContext, store: StoreContext, repository: ReturnType<typeof loadV3Repository>, identity: string): void {
  setActiveIdentity(ctx, {
    store,
    identity,
    identities: repository.manifest.identities,
    command: { name: 'config', args: ['active-identity', identity] },
  });
}

function getLogOutput(logger: { log: ReturnType<typeof vi.fn> }): string {
  return stripAnsi(logger.log.mock.calls.map(([message]) => String(message)).join('\n'));
}

describe('task 9 diff and export-example commands', () => {
  beforeEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('diff defaults to HEAD and reports no changes for matching resolved state', async () => {
    const root = join(TEST_DIR, 'diff-clean');
    const manifest = `
      version: 3
      identities:
        owner-local:
          roles: [owner]
      bundles:
        project:
          files:
            - path: env/project/shared
      targets:
        runtime:
          bundle: project
          format: dotenv
    `;
    const files = {
      'env/project/shared': `
        path: env/project/shared
        readers:
          roles: [owner]
          identities: [owner-local]
        sensitive: false
        entries:
          env/project/shared/API_URL:
            value: https://example.com
            sensitive: false
      `,
    };
    const repository = writeRepo(root, manifest, files);
    const { ctx, logger, store, execSync } = createContext(root, {
      HEAD: createEncryptedGitHistoryState(root, { manifest, files }, 'HEAD'),
    });
    setIdentity(ctx, store, repository, 'owner-local');

    await diffCommand(ctx, { store, env: 'development' });

    const output = getLogOutput(logger);
    expect(output).toContain('Reference: HEAD');
    expect(output).toContain('Selection: target runtime');
    expect(output).toContain('No redacted changes between current state and HEAD for target runtime.');
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining("show 'HEAD:.hush/manifest.encrypted'"), expect.any(Object));
  });

  it('diff supports --ref and shows reader, provenance, and redacted sensitive changes', async () => {
    const root = join(TEST_DIR, 'diff-changed');
    const currentManifest = `
      version: 3
      identities:
        owner-local:
          roles: [owner]
      bundles:
        project:
          files:
            - path: env/project/runtime
      targets:
        runtime:
          bundle: project
          format: dotenv
    `;
    const currentFiles = {
      'env/project/runtime': `
        path: env/project/runtime
        readers:
          roles: [owner]
          identities: [owner-local]
        sensitive: true
        entries:
          env/project/runtime/API_URL:
            value: https://runtime.example.com
            sensitive: false
          env/project/runtime/DB_URL:
            value: postgres://current-secret
            sensitive: true
      `,
    };
    const historicalManifest = `
      version: 3
      identities:
        owner-local:
          roles: [owner]
      bundles:
        project:
          files:
            - path: env/project/shared
      targets:
        runtime:
          bundle: project
          format: dotenv
    `;
    const historicalFiles = {
      'env/project/shared': `
        path: env/project/shared
        readers:
          roles: [owner, member]
          identities: [owner-local]
        sensitive: true
        entries:
          env/project/shared/API_URL:
            value: https://shared.example.com
            sensitive: false
          env/project/shared/DB_URL:
            value: postgres://previous-secret
            sensitive: true
      `,
    };
    const repository = writeRepo(root, currentManifest, currentFiles);
    const { ctx, logger, store } = createContext(root, {
      HEAD: createEncryptedGitHistoryState(root, { manifest: currentManifest, files: currentFiles }, 'HEAD'),
      'HEAD~1': createEncryptedGitHistoryState(root, { manifest: historicalManifest, files: historicalFiles }, 'HEAD~1'),
    });
    setIdentity(ctx, store, repository, 'owner-local');

    await diffCommand(ctx, { store, env: 'development', ref: 'HEAD~1' });

    const output = getLogOutput(logger);
    expect(output).toContain('Reference: HEAD~1');
    expect(output).toContain('File changes:');
    expect(output).toContain('env/project/runtime');
    expect(output).toContain('env/project/shared');
    expect(output).toContain('roles=owner,member identities=owner-local');
    expect(output).toContain('current https://runtime.example.com');
    expect(output).toContain('ref https://shared.example.com');
    expect(output).toContain('file=env/project/shared namespace=env');
    expect(output).toContain('file=env/project/runtime namespace=env');
    expect(output).toContain('ref [redacted]');
    expect(output).toContain('current [redacted]');
    expect(output).not.toContain('postgres://previous-secret');
    expect(output).not.toContain('postgres://current-secret');
  }, 60000);

  it('export-example omits protected target values and keeps sensitive artifacts redacted', async () => {
    const root = join(TEST_DIR, 'export-target');
    const manifest = `
      version: 3
      identities:
        owner-local:
          roles: [owner]
      bundles:
        project:
          files:
            - path: env/project/shared
            - path: artifacts/project/runtime
      targets:
        runtime:
          bundle: project
          format: dotenv
    `;
    const files = {
      'env/project/shared': `
        path: env/project/shared
        readers:
          roles: [owner]
          identities: [owner-local]
        sensitive: true
        entries:
          env/project/shared/PUBLIC_URL:
            value: https://example.com
            sensitive: false
          env/project/shared/SECRET_KEY:
            value: super-secret-value
            sensitive: true
      `,
      'artifacts/project/runtime': `
        path: artifacts/project/runtime
        readers:
          roles: [owner]
          identities: [owner-local]
        sensitive: true
        entries:
          artifacts/project/runtime/config:
            type: file
            format: json
            sensitive: false
            value: '{"mode":"example"}'
          artifacts/project/runtime/cert:
            type: file
            format: dotenv
            sensitive: true
            value: SECRET_KEY=super-secret-value
      `,
    };
    const repository = writeRepo(root, manifest, files);
    const { ctx, logger, store } = createContext(root, {
      HEAD: { manifest, files },
    });
    setIdentity(ctx, store, repository, 'owner-local');

    await exportExampleCommand(ctx, { store, env: 'development' });

    const output = getLogOutput(logger);
    expect(output).toContain('Selection: target runtime');
    expect(output).toContain('Protected values omitted: 1');
    expect(output).toContain('PUBLIC_URL=https://example.com');
    expect(output).not.toContain('SECRET_KEY=');
    expect(output).not.toContain('super-secret-value');
    expect(output).toContain('artifacts/project/runtime/config (file:json)');
    expect(output).toContain('{"mode":"example"}');
    expect(output).toContain('artifacts/project/runtime/cert (file:dotenv)');
    expect(output).toContain('# [redacted sensitive artifact]');
  });

  it('export-example supports bundle output and keeps protected values out of bundle env examples', async () => {
    const root = join(TEST_DIR, 'export-bundle');
    const manifest = `
      version: 3
      identities:
        owner-local:
          roles: [owner]
      bundles:
        project:
          files:
            - path: env/project/shared
      targets:
        runtime:
          bundle: project
          format: dotenv
        example:
          bundle: project
          format: dotenv
          mode: example
    `;
    const files = {
      'env/project/shared': `
        path: env/project/shared
        readers:
          roles: [owner]
          identities: [owner-local]
        sensitive: true
        entries:
          env/project/shared/API_URL:
            value: https://example.com
            sensitive: false
          env/project/shared/API_TOKEN:
            value: token-secret
            sensitive: true
      `,
    };
    const repository = writeRepo(root, manifest, files);
    const { ctx, logger, store } = createContext(root, {
      HEAD: { manifest, files },
    });
    setIdentity(ctx, store, repository, 'owner-local');

    await exportExampleCommand(ctx, { store, env: 'development', bundle: 'project' });

    const output = getLogOutput(logger);
    expect(output).toContain('Selection: bundle project');
    expect(output).toContain('Protected values omitted: 1');
    expect(output).toContain('API_URL=https://example.com');
    expect(output).not.toContain('API_TOKEN');
    expect(output).not.toContain('token-secret');
  });
});
