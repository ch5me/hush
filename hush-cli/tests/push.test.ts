import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/cli.js';
import type { HushContext, HushV3Repository, StoreContext } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  withMaterializedTarget: vi.fn(),
  requireV3Repository: vi.fn(),
}));

vi.mock('../src/index.js', () => ({
  withMaterializedTarget: mocks.withMaterializedTarget,
}));

vi.mock('../src/commands/v3-command-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/commands/v3-command-helpers.js')>();
  return {
    ...actual,
    requireV3Repository: mocks.requireV3Repository,
  };
});

import { pushCommand, pushVercelSecrets } from '../src/commands/push.js';

function createStore(): StoreContext {
  return {
    mode: 'project',
    root: '/repo',
    configPath: null,
    keyIdentity: 'hush-global',
    displayLabel: '/repo',
  };
}

function createContext(): HushContext {
  return {
    fs: {
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      unlinkSync: vi.fn(),
      rmSync: vi.fn(),
      statSync: vi.fn(),
      renameSync: vi.fn(),
    },
    path: {
      join: (...parts: string[]) => parts.join('/'),
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
      cwd: () => '/repo',
      exit: ((code: number) => { throw new Error(`Process exit: ${code}`); }) as never,
      env: {},
      stdin: process.stdin,
      stdout: process.stdout,
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    config: {
      loadConfig: vi.fn(),
      findProjectRoot: vi.fn(),
    },
    network: {
      fetch: vi.fn<typeof globalThis.fetch>(),
    },
    age: {
      ageAvailable: vi.fn(() => true),
      ageGenerate: vi.fn(),
      keyExists: vi.fn(() => true),
      keySave: vi.fn(),
      keyPath: vi.fn(() => '/tmp/key.txt'),
      keyLoad: vi.fn(),
      agePublicFromPrivate: vi.fn(),
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
}

function createEnvView() {
  return {
    env: {
      API_KEY: 'secret-value',
      PUBLIC_URL: 'https://example.com',
    },
    resolution: {
      values: {
        'env/project/shared/API_KEY': {
          entry: { value: 'secret-value', sensitive: true },
        },
        'env/project/shared/PUBLIC_URL': {
          entry: { value: 'https://example.com', sensitive: false },
        },
      },
    },
  } as const;
}

function createJsonResponse(body: unknown, init: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('pushCommand', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('pushes worker secrets through wrangler args and stdin without shelling values', async () => {
    const ctx = createContext();
    const repository = {
      manifest: {
        targets: {
          worker: {
            format: 'wrangler',
            mode: 'runtime',
          },
        },
        metadata: {
          legacyMigration: {
            targets: [
              { name: 'worker', path: './apps/worker', push_to: { type: 'cloudflare-workers' } },
            ],
          },
        },
      },
    } as unknown as HushV3Repository;

    mocks.requireV3Repository.mockReturnValue(repository);
    mocks.withMaterializedTarget.mockImplementation((_ctx, _options, handler) => handler({
      env: {
        'BAD; touch /tmp/pwned': '$(whoami)\nsecret-value',
      },
    }));

    await pushCommand(ctx, {
      store: createStore(),
      dryRun: false,
      verbose: false,
    });

    expect(ctx.exec.execSync).not.toHaveBeenCalled();
    expect(ctx.exec.spawnSync).toHaveBeenCalledWith(
      'wrangler',
      ['secret', 'put', 'BAD; touch /tmp/pwned'],
      expect.objectContaining({
        cwd: '/repo/apps/worker',
        input: '$(whoami)\nsecret-value',
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  it('uses the pages secret command for migrated cloudflare pages targets', async () => {
    const ctx = createContext();
    const repository = {
      manifest: {
        targets: {
          pages: {
            format: 'wrangler',
            mode: 'runtime',
          },
        },
        metadata: {
          legacyMigration: {
            targets: [
              { name: 'pages', path: './apps/pages', push_to: { type: 'cloudflare-pages', project: 'docs' } },
            ],
          },
        },
      },
    } as unknown as HushV3Repository;

    mocks.requireV3Repository.mockReturnValue(repository);
    mocks.withMaterializedTarget.mockImplementation((_ctx, _options, handler) => handler({
      env: {
        API_KEY: 'secret-value',
      },
    }));

    await pushCommand(ctx, {
      store: createStore(),
      dryRun: false,
      verbose: false,
    });

    expect(ctx.exec.spawnSync).toHaveBeenCalledWith(
      'wrangler',
      ['pages', 'secret', 'put', 'API_KEY', '--project-name', 'docs'],
      expect.objectContaining({
        cwd: '/repo/apps/pages',
        input: 'secret-value',
      }),
    );
  });
});

describe('pushVercelSecrets', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('posts sensitive and plain env vars to Vercel with upsert and team id', async () => {
    const ctx = createContext();
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(createJsonResponse({ ok: true }, { status: 200 }));
    ctx.network = { fetch: fetchMock };

    const result = await pushVercelSecrets(ctx, {
      envView: createEnvView(),
      config: {
        type: 'vercel',
        projectId: 'prj_123',
        teamId: 'team_456',
        environments: ['production', 'preview'],
      },
      token: 'vercel-token',
      dryRun: false,
    });

    expect(result.failed).toEqual([]);
    expect(result.success).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.vercel.com/v10/projects/prj_123/env?upsert=true&teamId=team_456',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer vercel-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          key: 'API_KEY',
          value: 'secret-value',
          type: 'sensitive',
          target: ['production', 'preview'],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.vercel.com/v10/projects/prj_123/env?upsert=true&teamId=team_456',
      expect.objectContaining({
        body: JSON.stringify({
          key: 'PUBLIC_URL',
          value: 'https://example.com',
          type: 'encrypted',
          target: ['production', 'preview'],
        }),
      }),
    );
  });

  it('uses dry-run output and makes zero fetch calls', async () => {
    const ctx = createContext();
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    ctx.network = { fetch: fetchMock };

    const result = await pushVercelSecrets(ctx, {
      envView: createEnvView(),
      config: {
        type: 'vercel',
        projectId: 'prj_123',
        environments: ['development'],
      },
      token: 'vercel-token',
      dryRun: true,
    });

    expect(result.success).toBe(2);
    expect(result.failed).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.logger.log).toHaveBeenCalledWith(expect.stringContaining('[dry-run] API_KEY'));
  });

  it('collects non-2xx failures without leaking secret values', async () => {
    const ctx = createContext();
    const fetchMock = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(createJsonResponse({ error: { message: 'No access to project' } }, { status: 403, statusText: 'Forbidden' }))
      .mockResolvedValueOnce(createJsonResponse({ ok: true }, { status: 200 }));
    ctx.network = { fetch: fetchMock };

    const result = await pushVercelSecrets(ctx, {
      envView: createEnvView(),
      config: {
        type: 'vercel',
        projectId: 'prj_123',
        environments: ['production'],
      },
      token: 'vercel-token',
      dryRun: false,
    });

    expect(result.success).toBe(1);
    expect(result.failed).toEqual([
      {
        key: 'API_KEY',
        type: 'sensitive',
        target: ['production'],
        error: 'HTTP 403 No access to project',
      },
    ]);
    expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('API_KEY'));
    expect(ctx.logger.error).not.toHaveBeenCalledWith(expect.stringContaining('secret-value'));
  });

  it('throws a clear error when token is missing', async () => {
    const ctx = createContext();

    await expect(pushVercelSecrets(ctx, {
      envView: createEnvView(),
      config: {
        type: 'vercel',
        projectId: 'prj_123',
        environments: ['production'],
      },
      dryRun: false,
    })).rejects.toThrow(/VERCEL_TOKEN/i);
  });

  it('throws a clear error when project id is missing', async () => {
    const ctx = createContext();

    await expect(pushVercelSecrets(ctx, {
      envView: createEnvView(),
      config: {
        type: 'vercel',
        projectId: '',
        environments: ['production'],
      },
      token: 'vercel-token',
      dryRun: false,
    })).rejects.toThrow(/projectId/i);
  });
});

describe('parseArgs(push)', () => {
  it('parses explicit Vercel push flags', () => {
    const parsed = parseArgs([
      'push',
      '--vercel',
      '--target',
      'web',
      '--project',
      'prj_123',
      '--team',
      'team_456',
      '--environment',
      'production',
      '--environment',
      'preview',
      '--dry-run',
    ]);

    expect(parsed.command).toBe('push');
    expect(parsed.vercel).toBe(true);
    expect(parsed.target).toBe('web');
    expect(parsed.project).toBe('prj_123');
    expect(parsed.team).toBe('team_456');
    expect(parsed.environments).toEqual(['production', 'preview']);
    expect(parsed.dryRun).toBe(true);
  });

  it('parses --wrangler-env for stage-scoped Cloudflare push', () => {
    const parsed = parseArgs(['push', '--target', 'worker', '--wrangler-env', 'staging', '--dry-run']);

    expect(parsed.command).toBe('push');
    expect(parsed.target).toBe('worker');
    expect(parsed.wranglerEnv).toBe('staging');
    expect(parsed.dryRun).toBe(true);
  });
});

describe('pushCommand wrangler-env', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes --env to wrangler when wranglerEnv is set', async () => {
    const ctx = createContext();
    const repository = {
      manifest: {
        targets: {
          worker: { format: 'wrangler', mode: 'runtime' },
        },
        metadata: {
          legacyMigration: {
            targets: [
              { name: 'worker', path: './apps/worker', push_to: { type: 'cloudflare-workers' } },
            ],
          },
        },
      },
    } as unknown as import('../src/types.js').HushV3Repository;

    mocks.requireV3Repository.mockReturnValue(repository);
    mocks.withMaterializedTarget.mockImplementation((_ctx, _options, handler) =>
      handler({ env: { MY_SECRET: 'val' } }),
    );

    await pushCommand(ctx, {
      store: createStore(),
      dryRun: false,
      verbose: false,
      wranglerEnv: 'staging',
    });

    expect(ctx.exec.spawnSync).toHaveBeenCalledWith(
      'wrangler',
      ['secret', 'put', 'MY_SECRET', '--env', 'staging'],
      expect.objectContaining({ input: 'val' }),
    );
  });

  it('omits --env from wrangler args when wranglerEnv is not set', async () => {
    const ctx = createContext();
    const repository = {
      manifest: {
        targets: {
          worker: { format: 'wrangler', mode: 'runtime' },
        },
        metadata: {
          legacyMigration: {
            targets: [
              { name: 'worker', path: './apps/worker', push_to: { type: 'cloudflare-workers' } },
            ],
          },
        },
      },
    } as unknown as import('../src/types.js').HushV3Repository;

    mocks.requireV3Repository.mockReturnValue(repository);
    mocks.withMaterializedTarget.mockImplementation((_ctx, _options, handler) =>
      handler({ env: { MY_SECRET: 'val' } }),
    );

    await pushCommand(ctx, {
      store: createStore(),
      dryRun: false,
      verbose: false,
    });

    expect(ctx.exec.spawnSync).toHaveBeenCalledWith(
      'wrangler',
      ['secret', 'put', 'MY_SECRET'],
      expect.objectContaining({ input: 'val' }),
    );
  });

  it('shows env label in dry-run output when wranglerEnv is set', async () => {
    const ctx = createContext();
    const repository = {
      manifest: {
        targets: {
          worker: { format: 'wrangler', mode: 'runtime' },
        },
        metadata: {
          legacyMigration: {
            targets: [
              { name: 'worker', path: './apps/worker', push_to: { type: 'cloudflare-workers' } },
            ],
          },
        },
      },
    } as unknown as import('../src/types.js').HushV3Repository;

    mocks.requireV3Repository.mockReturnValue(repository);
    mocks.withMaterializedTarget.mockImplementation((_ctx, _options, handler) =>
      handler({ env: { STAGED_KEY: 'hidden' } }),
    );

    await pushCommand(ctx, {
      store: createStore(),
      dryRun: true,
      verbose: false,
      wranglerEnv: 'production',
    });

    expect(ctx.exec.spawnSync).not.toHaveBeenCalled();
    const logCalls = (ctx.logger.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    const dryRunLine = logCalls.find((line) => line.includes('STAGED_KEY'));
    expect(dryRunLine).toBeTruthy();
    expect(dryRunLine).toContain('production');
  });
});
