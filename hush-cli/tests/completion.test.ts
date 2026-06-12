import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as nodeFs from 'node:fs';
import { completionCommand, HUSH_COMMANDS } from '../src/commands/completion.js';
import type { HushContext, LegacyHushConfig } from '../src/types.js';

function createContext() {
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
    path: { join },
    exec: {
      spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
      execSync: vi.fn(() => ''),
    },
    logger,
    process: {
      cwd: () => '/tmp/test',
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
      decrypt: vi.fn(),
      decryptYaml: vi.fn(),
      encrypt: vi.fn(),
      encryptYaml: vi.fn(),
      encryptYamlContent: vi.fn(),
      edit: vi.fn(),
      isSopsInstalled: vi.fn(() => true),
    },
  };

  return { ctx, logger };
}

function getLogOutput(logger: { log: ReturnType<typeof vi.fn> }): string {
  return logger.log.mock.calls.map(([message]) => String(message)).join('\n');
}

describe('completion command', () => {
  it('bash completion output contains all command names', async () => {
    const { ctx, logger } = createContext();
    await completionCommand(ctx, { shell: 'bash' });
    const output = getLogOutput(logger);

    for (const cmd of HUSH_COMMANDS) {
      expect(output).toContain(cmd);
    }
  });

  it('zsh completion output contains all command names', async () => {
    const { ctx, logger } = createContext();
    await completionCommand(ctx, { shell: 'zsh' });
    const output = getLogOutput(logger);

    for (const cmd of HUSH_COMMANDS) {
      expect(output).toContain(cmd);
    }
  });

  it('fish completion output contains all command names', async () => {
    const { ctx, logger } = createContext();
    await completionCommand(ctx, { shell: 'fish' });
    const output = getLogOutput(logger);

    for (const cmd of HUSH_COMMANDS) {
      expect(output).toContain(cmd);
    }
  });

  it('bash completion output is a valid script', async () => {
    const { ctx, logger } = createContext();
    await completionCommand(ctx, { shell: 'bash' });
    const output = getLogOutput(logger);

    expect(output).toContain('_hush_completion');
    expect(output).toContain('complete -F _hush_completion hush');
  });

  it('zsh completion output is a valid zsh compdef script', async () => {
    const { ctx, logger } = createContext();
    await completionCommand(ctx, { shell: 'zsh' });
    const output = getLogOutput(logger);

    expect(output).toContain('#compdef hush');
    expect(output).toContain('_hush');
  });

  it('fish completion output contains complete commands', async () => {
    const { ctx, logger } = createContext();
    await completionCommand(ctx, { shell: 'fish' });
    const output = getLogOutput(logger);

    expect(output).toContain('complete -c hush');
  });

  it('unknown shell exits with error listing supported shells', async () => {
    const { ctx, logger } = createContext();

    await expect(completionCommand(ctx, { shell: 'powershell' })).rejects.toThrow('Process exit: 1');

    const errorOutput = logger.error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(errorOutput).toContain('powershell');
    expect(errorOutput).toContain('bash');
    expect(errorOutput).toContain('zsh');
    expect(errorOutput).toContain('fish');
  });

  it('empty shell exits with error listing supported shells', async () => {
    const { ctx, logger } = createContext();

    await expect(completionCommand(ctx, { shell: '' })).rejects.toThrow('Process exit: 1');

    const errorOutput = logger.error.mock.calls.map(([message]) => String(message)).join('\n');
    expect(errorOutput).toContain('bash');
    expect(errorOutput).toContain('zsh');
    expect(errorOutput).toContain('fish');
  });
});
