import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { parseArgs } from "../src/cli.js";
import { projectCommand } from "../src/commands/project.js";
import {
  decrypt,
  decryptYaml,
  encrypt,
  encryptYaml,
  encryptYamlContent,
  isSopsInstalled,
} from "../src/core/sops.js";
import {
  createFileDocument,
  createFileIndexEntry,
  createManifestDocument,
  createProjectSlug,
  loadV3Repository,
  setActiveIdentity,
} from "../src/index.js";
import type {
  HushContext,
  HushManifestDocument,
  LegacyHushConfig,
  StoreContext,
} from "../src/types.js";
import { ensureTestSopsEnv, writeEncryptedYamlFile } from "./helpers/sops-test.js";

const tempRoots: string[] = [];

function normalizeYaml(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  while (lines[0] !== undefined && lines[0].trim() === "") {
    lines.shift();
  }

  while (lines.at(-1) !== undefined && lines.at(-1)?.trim() === "") {
    lines.pop();
  }

  const indent = lines
    .filter((line) => line.trim().length > 0)
    .reduce<number>((smallest, line) => {
      const match = line.match(/^\s*/);
      return Math.min(smallest, match?.[0].length ?? 0);
    }, Number.POSITIVE_INFINITY);

  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}

function createStore(root: string): StoreContext {
  const projectSlug = createProjectSlug(root);
  const stateRoot = join(root, ".machine-state");
  const projectStateRoot = join(stateRoot, "projects", projectSlug);

  return {
    mode: "project",
    root,
    configPath: null,
    keyIdentity: root,
    displayLabel: root,
    projectSlug,
    stateRoot,
    projectStateRoot,
    activeIdentityPath: join(projectStateRoot, "active-identity.json"),
    auditLogPath: join(projectStateRoot, "audit.jsonl"),
  };
}

function createContext(root: string) {
  ensureTestSopsEnv();

  const logs: string[] = [];
  const errors: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const spawnSync = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>();

  const defaultConfig: LegacyHushConfig = {
    sources: {
      shared: ".hush",
      development: ".hush.development",
      production: ".hush.production",
      local: ".hush.local",
    },
    targets: [{ name: "root", path: ".", format: "dotenv" }],
  };

  const ctx: HushContext = {
    fs: {
      existsSync: nodeFs.existsSync,
      readFileSync: nodeFs.readFileSync,
      writeFileSync: nodeFs.writeFileSync,
      mkdirSync: nodeFs.mkdirSync,
      readdirSync: nodeFs.readdirSync as HushContext["fs"]["readdirSync"],
      unlinkSync: nodeFs.unlinkSync,
      rmSync: nodeFs.rmSync,
      statSync: nodeFs.statSync,
      renameSync: nodeFs.renameSync,
      chmodSync: nodeFs.chmodSync,
    },
    path: {
      join,
    },
    exec: {
      spawnSync,
      execSync: vi.fn(() => ""),
    },
    logger: {
      log: (message) => logs.push(String(message)),
      error: (message) => errors.push(String(message)),
      warn: (message) => warns.push(String(message)),
      info: (message) => infos.push(String(message)),
    },
    process: {
      cwd: () => root,
      exit: ((code: number) => {
        throw new Error(`Process exit: ${code}`);
      }) as never,
      env: {},
      stdin: process.stdin,
      stdout: process.stdout,
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    network: {
      fetch,
    },
    config: {
      loadConfig: vi.fn(() => defaultConfig),
      findProjectRoot: vi.fn(() => null),
    },
    age: {
      ageAvailable: vi.fn(() => true),
      ageGenerate: vi.fn(),
      keyExists: vi.fn(() => true),
      keySave: vi.fn(),
      keyPath: vi.fn(() => "/tmp/key.txt"),
      keyLoad: vi.fn(() => null),
      agePublicFromPrivate: vi.fn(),
    },
    sops: {
      decrypt: vi.fn((filePath: string, options?: { root?: string; keyIdentity?: string }) =>
        decrypt(filePath, options),
      ),
      decryptYaml: vi.fn((filePath: string, options?: { root?: string; keyIdentity?: string }) =>
        decryptYaml(filePath, options),
      ),
      encrypt: vi.fn(
        (
          inputPath: string,
          outputPath: string,
          options?: { root?: string; keyIdentity?: string },
        ) => encrypt(inputPath, outputPath, options),
      ),
      encryptYaml: vi.fn(
        (
          inputPath: string,
          outputPath: string,
          options?: { root?: string; keyIdentity?: string },
        ) => encryptYaml(inputPath, outputPath, options),
      ),
      encryptYamlContent: vi.fn(
        (content: string, outputPath: string, options?: { root?: string; keyIdentity?: string }) =>
          encryptYamlContent(content, outputPath, options),
      ),
      edit: vi.fn(),
      isSopsInstalled: vi.fn(() => isSopsInstalled()),
    },
  };

  return { ctx, logs, errors, warns, infos, spawnSync, fetch };
}

function writeRepo(root: string, manifest: string, files: Record<string, string>) {
  nodeFs.mkdirSync(join(root, ".hush", "files"), { recursive: true });

  const parsedFiles = Object.values(files).map((content) =>
    createFileDocument(parseYaml(normalizeYaml(content))),
  );
  const manifestDocument = createManifestDocument({
    ...(parseYaml(normalizeYaml(manifest)) as Record<string, unknown>),
    fileIndex: Object.fromEntries(
      parsedFiles.map((file) => [file.path, createFileIndexEntry(file)]),
    ),
  } as HushManifestDocument);
  writeEncryptedYamlFile(
    root,
    join(root, ".hush", "manifest.encrypted"),
    stringifyYaml(manifestDocument, { indent: 2 }),
  );

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(root, ".hush", "files", `${relativePath}.encrypted`);
    writeEncryptedYamlFile(root, filePath, normalizeYaml(content));
  }

  return loadV3Repository(root, { keyIdentity: root });
}

function seedProjectFiles(root: string, extraConfig: Record<string, unknown> = {}): void {
  const configDir = join(root, "packages/runtime-config/config");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(root, "apps/api"), { recursive: true });

  writeFileSync(
    join(configDir, "hush-project-env.json"),
    JSON.stringify(
      {
        contract: "packages/runtime-config/config/runtime-requirements.json",
        environmentTargets: "packages/runtime-config/config/environment-targets.json",
        surfaces: {
          "api-worker": {
            runtimeSurface: "api",
            topologyTarget: "cf-worker-api",
            wranglerDir: "apps/api",
            hushTargets: {
              staging: "wrangler-deploy-staging",
              production: "wrangler-deploy-production",
            },
            wranglerEnvs: {
              staging: "staging",
              production: null,
            },
            deploySecrets: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
            variables: {
              AUTH_FROM_EMAIL: {
                staging: "noreply@elf.dance",
                production: "noreply@elf.dance",
              },
            },
            ...extraConfig,
          },
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(configDir, "runtime-requirements.json"),
    JSON.stringify(
      {
        api: [
          {
            name: "RESEND_API_KEY",
            delivery: "secret",
            requiredIn: ["staging", "production"],
            topologyTargets: ["cf-worker-api"],
          },
          {
            name: "AUTH_FROM_EMAIL",
            delivery: "variable",
            requiredIn: ["staging", "production"],
            topologyTargets: ["cf-worker-api"],
          },
        ],
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(configDir, "environment-targets.json"),
    JSON.stringify(
      {
        staging: {
          auth: {
            allowedOrigins: ["https://staging.folio.elf.dance"],
          },
        },
        production: {
          auth: {
            allowedOrigins: ["https://folio.elf.dance"],
          },
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(root, "apps/api/wrangler.toml"),
    [
      "[env.staging.vars]",
      'AUTH_FROM_EMAIL = "noreply@elf.dance"',
      "",
      "[vars]",
      'AUTH_FROM_EMAIL = "noreply@elf.dance"',
      "",
    ].join("\n"),
  );
}

function seedHushRepo(
  ctx: HushContext,
  store: StoreContext,
  root: string,
  env: Record<string, string>,
) {
  const repository = writeRepo(
    root,
    `
    version: 3
    identities:
      ci:
        roles: [ci]
    bundles:
      deploy:
        files:
          - path: env/project/shared
    targets:
      wrangler-deploy-staging:
        bundle: deploy
        format: dotenv
      wrangler-deploy-production:
        bundle: deploy
        format: dotenv
    `,
    {
      "env/project/shared": `
        path: env/project/shared
        readers:
          roles: [ci]
          identities: []
        sensitive: true
        entries:
          env/project/shared/CLOUDFLARE_API_TOKEN:
            value: ${env.CLOUDFLARE_API_TOKEN ?? ""}
          env/project/shared/CLOUDFLARE_ACCOUNT_ID:
            value: ${env.CLOUDFLARE_ACCOUNT_ID ?? ""}
          env/project/shared/RESEND_API_KEY:
            value: ${env.RESEND_API_KEY ?? ""}
      `,
    },
  );

  setActiveIdentity(ctx, {
    store,
    identity: "ci",
    identities: repository.manifest.identities,
    command: { name: "config", args: ["active-identity", "ci"] },
  });
}

afterEach(() => {
  vi.clearAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("parseArgs(project)", () => {
  it("parses project command flags and stage", () => {
    const parsed = parseArgs([
      "project",
      "validate",
      "staging",
      "--config",
      "packages/runtime-config/config/hush-project-env.json",
      "--surface",
      "api-worker",
      "--skip-remote",
      "--skip-provider",
      "--json",
    ]);

    expect(parsed.command).toBe("project");
    expect(parsed.subcommand).toBe("validate");
    expect(parsed.positionalArgs).toEqual(["staging"]);
    expect(parsed.projectConfig).toBe("packages/runtime-config/config/hush-project-env.json");
    expect(parsed.surface).toBe("api-worker");
    expect(parsed.skipRemote).toBe(true);
    expect(parsed.skipProvider).toBe(true);
    expect(parsed.json).toBe(true);
  });
});

describe("projectCommand", () => {
  it("auto-discovers config and reports missing remote secrets in plan mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "hush-project-command-"));
    tempRoots.push(root);
    seedProjectFiles(root, { wranglerCommand: ["wrangler"] });
    const { ctx, logs, spawnSync } = createContext(root);
    const store = createStore(root);
    seedHushRepo(ctx, store, root, {
      RESEND_API_KEY: "re_test_123",
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-id",
    });
    spawnSync.mockReturnValue({
      status: 0,
      stdout: "[]",
      stderr: "",
    });

    await projectCommand(ctx, {
      store,
      subcommand: "plan",
      stage: "staging",
      dryRun: false,
      json: true,
      skipRemote: false,
      skipProvider: true,
    });

    const payload = JSON.parse(logs[0] ?? "{}").data;
    expect(payload.status).toBe("drift");
    expect(payload.configPath).toBe("packages/runtime-config/config/hush-project-env.json");
    expect(payload.checks.workerSecrets.missing).toEqual(["RESEND_API_KEY"]);
    expect(payload.actions).toEqual([
      expect.objectContaining({ key: "RESEND_API_KEY", reason: "missing-remote" }),
    ]);
  });

  it("dry-run sync does not push secrets when remote metadata is already green", async () => {
    const root = mkdtempSync(join(tmpdir(), "hush-project-command-"));
    tempRoots.push(root);
    seedProjectFiles(root, { wranglerCommand: ["wrangler"] });
    const { ctx, logs, spawnSync } = createContext(root);
    const store = createStore(root);
    seedHushRepo(ctx, store, root, {
      RESEND_API_KEY: "re_test_123",
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-id",
    });
    spawnSync.mockReturnValue({
      status: 0,
      stdout: '[{"name":"RESEND_API_KEY"}]',
      stderr: "",
    });

    await projectCommand(ctx, {
      store,
      subcommand: "sync",
      stage: "staging",
      dryRun: true,
      json: true,
      skipRemote: false,
      skipProvider: true,
    });

    const payload = JSON.parse(logs[0] ?? "{}").data;
    expect(payload.status).toBe("ok");
    expect(payload.checks.sync.synced).toEqual([{ key: "RESEND_API_KEY", dryRun: true }]);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      "wrangler",
      ["secret", "list", "--env", "staging", "--format", "json"],
      expect.objectContaining({ cwd: join(root, "apps/api") }),
    );
  });

  it("validates provider keys through injected fetch", async () => {
    const root = mkdtempSync(join(tmpdir(), "hush-project-command-"));
    tempRoots.push(root);
    seedProjectFiles(root, {
      wranglerCommand: ["wrangler"],
      providerValidators: [
        { provider: "resend", key: "RESEND_API_KEY", fromEmail: "AUTH_FROM_EMAIL" },
      ],
    });
    const { ctx, logs, fetch } = createContext(root);
    const store = createStore(root);
    seedHushRepo(ctx, store, root, {
      RESEND_API_KEY: "re_test_123",
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-id",
    });
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ name: "elf.dance", status: "verified" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await projectCommand(ctx, {
      store,
      subcommand: "validate",
      stage: "staging",
      dryRun: false,
      json: true,
      skipRemote: true,
      skipProvider: false,
    });

    const payload = JSON.parse(logs[0] ?? "{}").data;
    expect(payload.status).toBe("ok");
    expect(payload.checks.providers.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails validate when required Hush keys are missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "hush-project-command-"));
    tempRoots.push(root);
    seedProjectFiles(root, { wranglerCommand: ["wrangler"] });
    const { ctx, logs } = createContext(root);
    const store = createStore(root);
    seedHushRepo(ctx, store, root, {
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-id",
    });

    await expect(
      projectCommand(ctx, {
        store,
        subcommand: "validate",
        stage: "staging",
        dryRun: false,
        json: true,
        skipRemote: true,
        skipProvider: true,
      }),
    ).rejects.toThrow("Process exit: 1");

    const payload = JSON.parse(logs[0] ?? "{}").data;
    expect(payload.status).toBe("drift");
    expect(payload.checks.hushTarget.missing).toEqual(["RESEND_API_KEY"]);
  });
});
