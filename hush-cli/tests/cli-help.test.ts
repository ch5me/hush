import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { parseArgs, renderCommandHelp } from '../src/cli.js';

describe('agent-first command help', () => {
  it('parses help after the command without resolving command options', () => {
    const parsed = parseArgs(['set', '--target', 'production', '--help']);
    expect(parsed.command).toBe('set');
    expect(parsed.helpRequested).toBe(true);
  });

  it('renders only command-specific options and safe set guidance', () => {
    const help = renderCommandHelp('set');
    expect(help).toContain('hush set <KEY> [VALUE]');
    expect(help).toContain('--file');
    expect(help).toContain('--repo-local');
    expect(help).toContain('--target is not accepted');
    expect(help).not.toContain('--wrangler-env');
  });

  it('renders subcommands and value domains', () => {
    expect(renderCommandHelp('file')).toContain('<add|remove|list|readers>');
    expect(renderCommandHelp('push')).toContain('<production|preview|development>');
    expect(renderCommandHelp('completion')).toContain('<bash|zsh|fish>');
  });

  it('supports command help end to end with diagnostics kept off stdout', () => {
    const result = spawnSync('bun', ['src/cli.ts', 'set', '--help'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, HUSH_CLI_ENTRYPOINT: '1' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:\n  hush set');
    expect(result.stdout).toContain('--target is not accepted');
    expect(result.stderr).toBe('');
  });
});

describe('central CLI errors', () => {
  const run = (...args: string[]) => spawnSync('bun', ['src/cli.ts', ...args], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, HUSH_CLI_ENTRYPOINT: '1', HUSH_NO_UPDATE_CHECK: '1' },
  });

  it('emits one versioned JSON error on stderr for unknown commands', () => {
    const result = run('sett', '--json');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const body = JSON.parse(result.stderr);
    expect(body).toMatchObject({ version: 1, ok: false, command: 'sett', error: {
      code: 'UNKNOWN_COMMAND', rejectedInput: 'sett', suggestion: 'hush set',
    } });
  });

  it('suggests a human command without dumping global help', () => {
    const result = run('sett');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unknown command: sett');
    expect(result.stderr).toContain('Did you mean: hush set');
    expect(result.stderr).not.toContain('Commands:');
  });

  it('returns structured unknown-option and subcommand suggestions', () => {
    const option = run('set', 'KEY', '--fiel', 'env/project/shared', '--json');
    expect(option.stdout).toBe('');
    expect(JSON.parse(option.stderr).error).toMatchObject({ code: 'UNKNOWN_OPTION', rejectedInput: '--fiel' });

    const subcommand = run('file', 'lst', '--json');
    expect(subcommand.stdout).toBe('');
    expect(JSON.parse(subcommand.stderr).error).toMatchObject({
      code: 'UNKNOWN_SUBCOMMAND', rejectedInput: 'lst', suggestion: 'hush file list',
    });
  });
});
