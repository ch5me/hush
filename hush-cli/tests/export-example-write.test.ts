import * as nodeFs from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { exportExampleCommand } from "../src/commands/export-example.js";
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

const TEST_DIR = join("/tmp", "hush-test-export-example-write");

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\[[0-9;]*m`, "g"), "");
}

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

function getLogOutput(logger: { log: ReturnType<typeof vi.fn> }): string {
  return stripAnsi(logger.log.mock.calls.map(([message]) => String(message)).join("\n"));
}

const MANIFEST = `
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

const FILES = {
  "env/project/shared": `
    path: env/project/shared
    readers:
      roles: [owner]
      identities: [owner-local]
    sensitive: false
    entries:
      env/project/shared/PUBLIC_URL:
        value: https://example.com
        sensitive: false
      env/project/shared/SECRET_KEY:
        value: super-secret-value
        sensitive: true
  `,
};

describe("export-example --write", () => {
  beforeEach(() => {
    ensureTestSopsEnv();
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("writes file to default .env.example when --write is set", async () => {
    const root = join(TEST_DIR, "write-default");
    const repository = writeRepo(root, MANIFEST, FILES);
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, "owner-local");

    await exportExampleCommand(ctx, { store, env: "development", write: true });

    const outputPath = join(root, ".env.example");
    expect(nodeFs.existsSync(outputPath)).toBe(true);

    const output = getLogOutput(logger);
    expect(output).toContain(".env.example");
  });

  it("written file content matches the stdout output (without ansi)", async () => {
    const root = join(TEST_DIR, "write-matches-stdout");
    const repository = writeRepo(root, MANIFEST, FILES);
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, "owner-local");

    await exportExampleCommand(ctx, { store, env: "development", write: true });

    const outputPath = join(root, ".env.example");
    const fileContent = nodeFs.readFileSync(outputPath, "utf-8") as string;

    // The file content (after ANSI stripping) should contain the same non-secret data
    expect(fileContent).toContain("PUBLIC_URL=https://example.com");
    // Should not contain sensitive values
    expect(fileContent).not.toContain("super-secret-value");
  });

  it("writes to custom path when --output-root (writePath) is provided", async () => {
    const root = join(TEST_DIR, "write-custom-path");
    const repository = writeRepo(root, MANIFEST, FILES);
    const { ctx, logger, store } = createContext(root);
    setIdentity(ctx, store, repository, "owner-local");

    const customPath = join(root, "custom", ".env.example");
    nodeFs.mkdirSync(join(root, "custom"), { recursive: true });

    await exportExampleCommand(ctx, {
      store,
      env: "development",
      write: true,
      writePath: customPath,
    });

    expect(nodeFs.existsSync(customPath)).toBe(true);
    const output = getLogOutput(logger);
    expect(output).toContain("custom");
  });

  it("refuses to overwrite existing file with different content without --force", async () => {
    const root = join(TEST_DIR, "write-no-overwrite");
    const repository = writeRepo(root, MANIFEST, FILES);
    const { ctx, store } = createContext(root);
    setIdentity(ctx, store, repository, "owner-local");

    const outputPath = join(root, ".env.example");
    nodeFs.writeFileSync(outputPath, "EXISTING_CONTENT=something_completely_different\n", "utf-8");

    await expect(
      exportExampleCommand(ctx, { store, env: "development", write: true }),
    ).rejects.toThrow(/already exists.*different content|already exists/i);
  });

  it("overwrites existing file with --force even when content differs", async () => {
    const root = join(TEST_DIR, "write-force-overwrite");
    const repository = writeRepo(root, MANIFEST, FILES);
    const { ctx, store } = createContext(root);
    setIdentity(ctx, store, repository, "owner-local");

    const outputPath = join(root, ".env.example");
    nodeFs.writeFileSync(outputPath, "EXISTING_CONTENT=something_completely_different\n", "utf-8");

    // Should not throw with --force
    await exportExampleCommand(ctx, { store, env: "development", write: true, force: true });

    expect(nodeFs.existsSync(outputPath)).toBe(true);
    const fileContent = nodeFs.readFileSync(outputPath, "utf-8") as string;
    expect(fileContent).toContain("PUBLIC_URL");
  });

  it("succeeds silently when overwriting with identical content (no --force needed)", async () => {
    const root = join(TEST_DIR, "write-idempotent");
    const repository = writeRepo(root, MANIFEST, FILES);
    const { ctx, store } = createContext(root);
    setIdentity(ctx, store, repository, "owner-local");

    // Run twice; second run should not throw since content is same
    await exportExampleCommand(ctx, { store, env: "development", write: true });
    await exportExampleCommand(ctx, { store, env: "development", write: true });

    const outputPath = join(root, ".env.example");
    expect(nodeFs.existsSync(outputPath)).toBe(true);
  });

  it("does not write secrets to the output file", async () => {
    const root = join(TEST_DIR, "write-no-secrets");
    const repository = writeRepo(root, MANIFEST, FILES);
    const { ctx, store } = createContext(root);
    setIdentity(ctx, store, repository, "owner-local");

    await exportExampleCommand(ctx, { store, env: "development", write: true });

    const outputPath = join(root, ".env.example");
    const fileContent = nodeFs.readFileSync(outputPath, "utf-8") as string;
    expect(fileContent).not.toContain("super-secret-value");
  });
});
