import * as nodeFs from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { doctorCommand } from "../src/commands/doctor.js";
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
  loadV3Repository,
} from "../src/index.js";
import type { HushContext, HushManifestDocument, LegacyHushConfig } from "../src/types.js";
import { ensureTestSopsEnv, writeEncryptedYamlFile } from "./helpers/sops-test.js";

const TEST_DIR = join("/tmp", "hush-test-doctor-json");

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

  return { ctx, logger };
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

describe("doctor --json", () => {
  beforeEach(() => {
    ensureTestSopsEnv();
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("emits valid JSON with a checks array", async () => {
    const root = join(TEST_DIR, "doctor-json-basic");
    writeRepo(
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
    const { ctx, logger } = createContext(root);

    await doctorCommand(ctx, { startDir: root, json: true });

    const raw = logger.log.mock.calls.map(([message]) => String(message)).join("");
    const envelope = JSON.parse(raw) as {
      version: number;
      ok: boolean;
      command: string;
      data: { checks: Array<{ name: string; ok: boolean; detail: string }> };
    };
    expect(envelope).toMatchObject({ version: 1, ok: true, command: "doctor" });
    const payload = envelope.data;

    expect(payload).toHaveProperty("checks");
    expect(Array.isArray(payload.checks)).toBe(true);
    expect(payload.checks.length).toBeGreaterThan(0);
  });

  it("each check has name, ok, detail fields", async () => {
    const root = join(TEST_DIR, "doctor-json-fields");
    writeRepo(
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
    const { ctx, logger } = createContext(root);

    await doctorCommand(ctx, { startDir: root, json: true });

    const raw = logger.log.mock.calls.map(([message]) => String(message)).join("");
    const payload = (
      JSON.parse(raw) as { data: { checks: Array<{ name: string; ok: boolean; detail: string }> } }
    ).data;

    for (const check of payload.checks) {
      expect(check).toHaveProperty("name");
      expect(check).toHaveProperty("ok");
      expect(check).toHaveProperty("detail");
      expect(typeof check.name).toBe("string");
      expect(typeof check.ok).toBe("boolean");
      expect(typeof check.detail).toBe("string");
    }
  });

  it("includes repository_found check", async () => {
    const root = join(TEST_DIR, "doctor-json-repo-found");
    writeRepo(
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
    const { ctx, logger } = createContext(root);

    await doctorCommand(ctx, { startDir: root, json: true });

    const raw = logger.log.mock.calls.map(([message]) => String(message)).join("");
    const payload = (
      JSON.parse(raw) as { data: { checks: Array<{ name: string; ok: boolean; detail: string }> } }
    ).data;

    const repoCheck = payload.checks.find((c) => c.name === "repository_found");
    expect(repoCheck).toBeDefined();
  });

  it("includes age_key_found check", async () => {
    const root = join(TEST_DIR, "doctor-json-key-found");
    writeRepo(
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
    const { ctx, logger } = createContext(root);

    await doctorCommand(ctx, { startDir: root, json: true });

    const raw = logger.log.mock.calls.map(([message]) => String(message)).join("");
    const payload = (
      JSON.parse(raw) as { data: { checks: Array<{ name: string; ok: boolean; detail: string }> } }
    ).data;

    const keyCheck = payload.checks.find((c) => c.name === "age_key_found");
    expect(keyCheck).toBeDefined();
  });

  it("does not emit human-readable output when --json is set", async () => {
    const root = join(TEST_DIR, "doctor-json-no-human");
    writeRepo(
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
    const { ctx, logger } = createContext(root);

    await doctorCommand(ctx, { startDir: root, json: true });

    const raw = logger.log.mock.calls.map(([message]) => String(message)).join("");

    // Should be valid JSON, not human-readable output
    expect(() => JSON.parse(raw)).not.toThrow();
    // Should not contain Doctor header
    expect(raw).not.toContain("Hush Doctor");
  });
});
