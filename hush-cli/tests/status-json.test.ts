import * as nodeFs from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { statusCommand } from "../src/commands/status.js";
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

const TEST_DIR = join("/tmp", "hush-test-status-json");

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
  const stateRoot = join(TEST_DIR, ".machine-state");
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

  const logger = {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };

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
    },
    path: { join },
    exec: {
      spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      execSync: vi.fn(() => ""),
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
      ageGenerate: vi.fn(() => ({ private: "private", public: "public" })),
      keyExists: vi.fn(() => false),
      keySave: vi.fn(),
      keyPath: vi.fn(() => ""),
      keyLoad: vi.fn(() => null),
      agePublicFromPrivate: vi.fn(() => "public"),
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

  return { ctx, logger, store: createStore(root) };
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

function setIdentity(
  ctx: HushContext,
  store: StoreContext,
  repository: ReturnType<typeof loadV3Repository>,
  identity: string,
): void {
  setActiveIdentity(ctx, {
    store,
    identity,
    identities: repository.manifest.identities,
    command: { name: "config", args: ["active-identity", identity] },
  });
}

describe("status --json", () => {
  beforeEach(() => {
    ensureTestSopsEnv();
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("emits valid JSON with expected top-level fields", async () => {
    const root = join(TEST_DIR, "status-json-basic");
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      bundles:
        runtime:
          files:
            - path: env/project/shared
      targets:
        runtime:
          bundle: runtime
          format: dotenv
      `,
      {
        "env/project/shared": `
          path: env/project/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/project/shared/API_URL:
              value: https://example.com
              sensitive: false
        `,
      },
    );
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, "developer-local");

    await statusCommand(ctx, { store, json: true });

    const raw = logger.log.mock.calls.map(([message]) => String(message)).join("");
    const envelope = JSON.parse(raw) as {
      version: number;
      ok: boolean;
      command: string;
      data: Record<string, unknown>;
    };
    expect(envelope).toMatchObject({ version: 1, ok: true, command: "status" });
    const payload = envelope.data;

    expect(payload).toHaveProperty("repository", "ready");
    expect(payload).toHaveProperty("root");
    expect(payload).toHaveProperty("store");
    expect(payload).toHaveProperty("manifestPath");
    expect(payload).toHaveProperty("filesRoot");
    expect(payload).toHaveProperty("activeIdentity");
    expect(payload).toHaveProperty("counts");
    expect(payload).toHaveProperty("machineLocal");
  });

  it("counts object has expected fields", async () => {
    const root = join(TEST_DIR, "status-json-counts");
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
        ci:
          roles: [ci]
      bundles:
        runtime:
          files:
            - path: env/project/shared
      targets:
        runtime:
          bundle: runtime
          format: dotenv
      `,
      {
        "env/project/shared": `
          path: env/project/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/project/shared/API_URL:
              value: https://example.com
              sensitive: false
        `,
      },
    );
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, "developer-local");

    await statusCommand(ctx, { store, json: true });

    const raw = logger.log.mock.calls.map(([message]) => String(message)).join("");
    const envelope = JSON.parse(raw) as {
      data: {
        counts: {
          manifestFiles: number;
          encryptedFiles: number;
          identities: number;
          bundles: number;
          targets: number;
          imports: number;
        };
      };
    };

    const { counts } = envelope.data;
    expect(counts).toHaveProperty("manifestFiles");
    expect(counts).toHaveProperty("encryptedFiles");
    expect(counts).toHaveProperty("identities");
    expect(counts).toHaveProperty("bundles");
    expect(counts).toHaveProperty("targets");
    expect(counts).toHaveProperty("imports");
    expect(counts.encryptedFiles).toBe(1);
    expect(counts.bundles).toBe(1);
    expect(counts.targets).toBe(1);
    expect(counts.identities).toBe(2);
  });

  it("machineLocal object has expected fields", async () => {
    const root = join(TEST_DIR, "status-json-machine-local");
    const repository = writeRepo(
      root,
      `
      version: 3
      identities:
        developer-local:
          roles: [owner]
      `,
      {
        "env/project/shared": `
          path: env/project/shared
          readers:
            roles: [owner]
            identities: [developer-local]
          sensitive: false
          entries:
            env/project/shared/API_URL:
              value: https://example.com
              sensitive: false
        `,
      },
    );
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, "developer-local");

    await statusCommand(ctx, { store, json: true });

    const raw = logger.log.mock.calls.map(([message]) => String(message)).join("");
    const envelope = JSON.parse(raw) as {
      data: {
        machineLocal: {
          projectSlug: string;
          stateRoot: string;
          activeIdentityPath: string;
          activeIdentityPresent: boolean;
          auditLogPath: string;
          auditLogPresent: boolean;
        };
      };
    };

    const { machineLocal } = envelope.data;
    expect(machineLocal).toHaveProperty("projectSlug");
    expect(machineLocal).toHaveProperty("stateRoot");
    expect(machineLocal).toHaveProperty("activeIdentityPath");
    expect(machineLocal).toHaveProperty("activeIdentityPresent");
    expect(machineLocal).toHaveProperty("auditLogPath");
    expect(machineLocal).toHaveProperty("auditLogPresent");
    expect(typeof machineLocal.projectSlug).toBe("string");
    expect(typeof machineLocal.activeIdentityPresent).toBe("boolean");
  });

  it("reports repository: missing when no repo exists", async () => {
    const root = join(TEST_DIR, "status-json-missing");
    nodeFs.mkdirSync(root, { recursive: true });
    const { ctx, logger } = createContext(root);

    // Use a store that points to a non-v3 directory
    const store = {
      mode: "project" as const,
      root,
      configPath: null,
      keyIdentity: root,
      displayLabel: root,
      projectSlug: "test",
      stateRoot: join(TEST_DIR, ".machine-state"),
      projectStateRoot: join(TEST_DIR, ".machine-state", "projects", "test"),
      activeIdentityPath: join(
        TEST_DIR,
        ".machine-state",
        "projects",
        "test",
        "active-identity.json",
      ),
      auditLogPath: join(TEST_DIR, ".machine-state", "projects", "test", "audit.jsonl"),
    };

    await statusCommand(ctx, { store, json: true });

    const raw = logger.log.mock.calls.map(([message]) => String(message)).join("");
    const envelope = JSON.parse(raw) as {
      ok: boolean;
      command: string;
      data: Record<string, unknown>;
    };

    expect(envelope).toMatchObject({ ok: true, command: "status" });
    expect(envelope.data).toHaveProperty("repository");
  });
});
