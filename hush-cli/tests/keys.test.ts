import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/cli.js';
import type { HushContext, StoreContext } from '../src/types.js';
import { keysCommand, keysRecoverFromVercel } from '../src/commands/keys.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createStore(): StoreContext {
  return {
    mode: 'project',
    root: '/repo',
    configPath: '/repo/hush.yaml',
    keyIdentity: 'test-project',
    displayLabel: '/repo',
  };
}

function createContext(): HushContext {
  return {
    fs: {
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      unlinkSync: vi.fn(),
      rmSync: vi.fn(),
      statSync: vi.fn(),
      renameSync: vi.fn(),
      chmodSync: vi.fn(),
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
      loadConfig: vi.fn(() => ({
        project: 'test-project',
        sources: { shared: '.hush', development: '.hush.development', production: '.hush.production', local: '.hush.local' },
        targets: [],
      })),
      findProjectRoot: vi.fn(() => ({
        repositoryKind: 'legacy-v2' as const,
        configPath: '/repo/hush.yaml',
        projectRoot: '/repo',
      })),
    },
    network: {
      fetch: vi.fn<typeof globalThis.fetch>(),
    },
    age: {
      ageAvailable: vi.fn(() => true),
      ageGenerate: vi.fn(() => ({ private: 'AGE-SECRET-KEY-FAKE', public: 'age1fakepublickey' })),
      keyExists: vi.fn(() => false),
      keySave: vi.fn(),
      keyPath: vi.fn((project: string) => `/home/.config/sops/age/keys/${project}.txt`),
      keyLoad: vi.fn(() => null),
      agePublicFromPrivate: vi.fn(() => 'age1fakepublickey'),
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

function createJsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// keysRecoverFromVercel unit tests
// ---------------------------------------------------------------------------

describe('keysRecoverFromVercel', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fetches SOPS_AGE_KEY from Vercel, derives public key, and saves locally', async () => {
    const ctx = createContext();
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      createJsonResponse({
        envs: [
          { key: 'SOPS_AGE_KEY', value: 'AGE-SECRET-KEY-1REAL', type: 'sensitive', target: ['production'] },
          { key: 'OTHER_VAR', value: 'hello', type: 'encrypted', target: ['production'] },
        ],
      }, 200),
    );
    ctx.network = { fetch: fetchMock };
    ctx.age.agePublicFromPrivate = vi.fn(() => 'age1derivedpublickey');

    const pub = await keysRecoverFromVercel(ctx, {
      project: 'prj_abc123',
      team: 'team_xyz',
      token: 'vercel-tok',
      project_name: 'firefly-cloud',
    });

    expect(pub).toBe('age1derivedpublickey');
    // Public key derived from private — never from the raw value
    expect(ctx.age.agePublicFromPrivate).toHaveBeenCalledWith('AGE-SECRET-KEY-1REAL');
    // Key saved with correct project name
    expect(ctx.age.keySave).toHaveBeenCalledWith('firefly-cloud', {
      private: 'AGE-SECRET-KEY-1REAL',
      public: 'age1derivedpublickey',
    });
    // URL includes decrypt=true and teamId
    const calledUrl = (fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl).toContain('decrypt=true');
    expect(calledUrl).toContain('teamId=team_xyz');
    expect(calledUrl).toContain('prj_abc123');
    // Auth header present but value not checked (masking layer handles it)
    const calledInit = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((calledInit.headers as Record<string, string>)['Authorization']).toBeTruthy();
  });

  it('accepts envs under the "env" key as well as "envs"', async () => {
    const ctx = createContext();
    ctx.network = {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        createJsonResponse({
          env: [{ key: 'SOPS_AGE_KEY', value: 'AGE-SECRET-KEY-ALT', type: 'sensitive' }],
        }, 200),
      ),
    };

    const pub = await keysRecoverFromVercel(ctx, {
      project: 'prj_alt',
      token: 'tok',
      project_name: 'alt-proj',
    });

    expect(pub).toBeTruthy();
    expect(ctx.age.keySave).toHaveBeenCalledTimes(1);
  });

  it('throws when SOPS_AGE_KEY is absent from the Vercel project', async () => {
    const ctx = createContext();
    ctx.network = {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        createJsonResponse({ envs: [{ key: 'OTHER', value: 'x' }] }, 200),
      ),
    };

    await expect(
      keysRecoverFromVercel(ctx, { project: 'prj_missing', token: 'tok', project_name: 'proj' }),
    ).rejects.toThrow(/SOPS_AGE_KEY not found/);

    expect(ctx.age.keySave).not.toHaveBeenCalled();
  });

  it('throws when the value does not look like an age private key', async () => {
    const ctx = createContext();
    ctx.network = {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        createJsonResponse({ envs: [{ key: 'SOPS_AGE_KEY', value: 'not-an-age-key' }] }, 200),
      ),
    };

    await expect(
      keysRecoverFromVercel(ctx, { project: 'prj_bad', token: 'tok', project_name: 'proj' }),
    ).rejects.toThrow(/AGE-SECRET-KEY/);

    expect(ctx.age.keySave).not.toHaveBeenCalled();
  });

  it('throws a VercelPushError on non-2xx response', async () => {
    const ctx = createContext();
    ctx.network = {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        createJsonResponse({ error: { message: 'Unauthorized' } }, 401),
      ),
    };

    await expect(
      keysRecoverFromVercel(ctx, { project: 'prj_err', token: 'tok', project_name: 'proj' }),
    ).rejects.toThrow(/Vercel API error.*Unauthorized/i);
  });

  it('throws when no token is available', async () => {
    const ctx = createContext();
    ctx.process.env = {};

    await expect(
      keysRecoverFromVercel(ctx, { project: 'prj_123', project_name: 'proj' }),
    ).rejects.toThrow(/VERCEL_TOKEN/);
  });

  it('falls back to VERCEL_TOKEN env var when no explicit token is passed', async () => {
    const ctx = createContext();
    ctx.process.env = { VERCEL_TOKEN: 'from-env-token' };
    ctx.network = {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        createJsonResponse({ envs: [{ key: 'SOPS_AGE_KEY', value: 'AGE-SECRET-KEY-ENV' }] }, 200),
      ),
    };

    await keysRecoverFromVercel(ctx, { project: 'prj_env', project_name: 'proj' });

    const calledInit = (ctx.network!.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    const authHeader = (calledInit.headers as Record<string, string>)['Authorization'];
    expect(authHeader).toContain('from-env-token');
  });

  it('refuses to overwrite an existing key without --force', async () => {
    const ctx = createContext();
    ctx.age.keyExists = vi.fn(() => true);
    ctx.network = {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        createJsonResponse({ envs: [{ key: 'SOPS_AGE_KEY', value: 'AGE-SECRET-KEY-OK' }] }, 200),
      ),
    };

    await expect(
      keysRecoverFromVercel(ctx, { project: 'prj_123', token: 'tok', project_name: 'proj' }),
    ).rejects.toThrow(/already exists/);
    expect(ctx.age.keySave).not.toHaveBeenCalled();
  });

  it('overwrites an existing key when force=true', async () => {
    const ctx = createContext();
    ctx.age.keyExists = vi.fn(() => true);
    ctx.network = {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        createJsonResponse({ envs: [{ key: 'SOPS_AGE_KEY', value: 'AGE-SECRET-KEY-FORCED' }] }, 200),
      ),
    };

    await keysRecoverFromVercel(ctx, {
      project: 'prj_123',
      token: 'tok',
      project_name: 'proj',
      force: true,
    });

    expect(ctx.age.keySave).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// keysCommand pull subcommand routing tests
// ---------------------------------------------------------------------------

describe('keysCommand pull routing', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exits with error when --from is missing', async () => {
    const ctx = createContext();

    await expect(
      keysCommand(ctx, { store: createStore(), subcommand: 'pull' }),
    ).rejects.toThrow('Process exit: 1');

    expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('--from'));
  });

  it('exits with error when --from vercel is given but --project is missing', async () => {
    const ctx = createContext();

    await expect(
      keysCommand(ctx, { store: createStore(), subcommand: 'pull', from: 'vercel' }),
    ).rejects.toThrow('Process exit: 1');

    expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('--project'));
  });

  it('rejects unknown --from values', async () => {
    const ctx = createContext();

    await expect(
      keysCommand(ctx, { store: createStore(), subcommand: 'pull', from: 'someunknownplatform' }),
    ).rejects.toThrow('Process exit: 1');

    expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('Supported: vercel'));
  });

  it('succeeds with --from vercel and valid project, fetching from network', async () => {
    const ctx = createContext();
    ctx.network = {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        createJsonResponse({ envs: [{ key: 'SOPS_AGE_KEY', value: 'AGE-SECRET-KEY-CMD' }] }, 200),
      ),
    };

    await keysCommand(ctx, {
      store: createStore(),
      subcommand: 'pull',
      from: 'vercel',
      project: 'prj_cmd',
      token: 'tok',
    });

    expect(ctx.age.keySave).toHaveBeenCalledTimes(1);
    expect(ctx.logger.log).toHaveBeenCalledWith(expect.stringContaining('installed'));
  });
});

// ---------------------------------------------------------------------------
// parseArgs(keys pull) wiring tests
// ---------------------------------------------------------------------------

describe('parseArgs(keys pull)', () => {
  it('parses keys pull --from vercel flags', () => {
    const parsed = parseArgs([
      'keys',
      'pull',
      '--from',
      'vercel',
      '--project',
      'prj_123',
      '--team',
      'team_abc',
      '--token',
      'tok-xyz',
    ]);

    expect(parsed.command).toBe('keys');
    expect(parsed.subcommand).toBe('pull');
    expect(parsed.from).toBe('vercel');
    expect(parsed.project).toBe('prj_123');
    expect(parsed.team).toBe('team_abc');
    expect(parsed.keysToken).toBe('tok-xyz');
  });
});
