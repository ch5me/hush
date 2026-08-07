import * as nodeFs from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { check } from "../src/commands/check.js";
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
  createProjectSlug,
  loadV3Repository,
} from "../src/index.js";
import type {
  HushContext,
  HushManifestDocument,
  LegacyHushConfig,
  StoreContext,
} from "../src/types.js";
import { computeReaderRecipientDrift } from "../src/v3/repository.js";
import { ensureTestSopsEnv, writeEncryptedYamlFile } from "./helpers/sops-test.js";

const TEST_DIR = join("/tmp", "hush-test-reader-recipient-drift");

// This is the exact incident this check exists to catch: a lane runs
// `hush config readers <path> --identities ci` (or, before that command's own
// fail-closed guard existed, a file is simply created with `ci` already named).
// Hush's readers metadata now says "ci can read this", but the file was
// encrypted before ci had any key of its own, so it still carries only the
// owner's single age recipient. `hush check` and `hush doctor` must not both
// report clean here -- that silence is the whole bug.
const DRIFTED_MANIFEST = `
  version: 3
  identities:
    developer-local:
      roles: [owner]
    ci:
      roles: [ci]
`;

const DRIFTED_FILES = {
  "env/event-service-folio-accepted-result-signer/staging": `
    path: env/event-service-folio-accepted-result-signer/staging
    readers:
      roles: [owner, member, ci]
      identities: [ci]
    sensitive: true
    entries:
      env/event-service-folio-accepted-result-signer/staging/SIGNING_KEY:
        value: not-a-real-secret
        sensitive: true
  `,
};

const HEALTHY_MANIFEST = `
  version: 3
  identities:
    developer-local:
      roles: [owner]
`;

const HEALTHY_FILES = {
  "env/project/shared": `
    path: env/project/shared
    readers:
      roles: [owner, member, ci]
      identities: []
    sensitive: false
    entries:
      env/project/shared/API_URL:
        value: https://example.com
        sensitive: false
  `,
};

// A file restricted to exactly the owner identity is not drift: the owner is
// definitionally who holds the file's sole recipient key, so this must not
// false-positive just because readers.identities is non-empty.
const SELF_ONLY_FILES = {
  "env/app/secrets": `
    path: env/app/secrets
    readers:
      roles: [owner]
      identities: [developer-local]
    sensitive: true
    entries:
      env/app/secrets/STRIPE_SECRET_KEY:
        value: not-a-real-secret
        sensitive: true
  `,
};

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

describe("reader/recipient drift detection", () => {
  beforeEach(() => {
    ensureTestSopsEnv();
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("computeReaderRecipientDrift", () => {
    it("flags a file whose readers.identities names a non-owner identity with only 1 recipient", () => {
      const root = join(TEST_DIR, "compute-drifted");
      const repo = writeRepo(root, DRIFTED_MANIFEST, DRIFTED_FILES);

      const findings = computeReaderRecipientDrift(repo);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        filePath: "env/event-service-folio-accepted-result-signer/staging",
        unaccountedIdentities: ["ci"],
        requiredRecipients: 2,
      });
      expect(findings[0]!.recipients).toHaveLength(1);
    });

    it("does not flag a file with no explicit reader identities", () => {
      const root = join(TEST_DIR, "compute-healthy");
      const repo = writeRepo(root, HEALTHY_MANIFEST, HEALTHY_FILES);

      expect(computeReaderRecipientDrift(repo)).toHaveLength(0);
    });

    it("does not flag a file restricted to exactly the owner identity", () => {
      const root = join(TEST_DIR, "compute-self-only");
      const repo = writeRepo(root, HEALTHY_MANIFEST, SELF_ONLY_FILES);

      expect(computeReaderRecipientDrift(repo)).toHaveLength(0);
    });
  });

  describe("hush doctor", () => {
    it("fails the reader_recipient_alignment check and exits non-zero on drift", async () => {
      const root = join(TEST_DIR, "doctor-drifted");
      writeRepo(root, DRIFTED_MANIFEST, DRIFTED_FILES);
      const { ctx, logger } = createContext(root);

      await expect(
        doctorCommand(ctx, { startDir: root, explicitRoot: root, json: true }),
      ).rejects.toThrow("Process exit: 5");

      const raw = logger.error.mock.calls.map(([message]) => String(message)).join("");
      const envelope = JSON.parse(raw) as {
        ok: boolean;
        error: {
          code: string;
          message: string;
          details: { checks: Array<{ name: string; ok: boolean; detail: string }> };
        };
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("READER_RECIPIENT_DRIFT");

      const check = envelope.error.details.checks.find(
        (entry) => entry.name === "reader_recipient_alignment",
      );
      expect(check).toBeDefined();
      expect(check!.ok).toBe(false);
      expect(check!.detail).toContain("event-service-folio-accepted-result-signer/staging");
      expect(check!.detail).toContain("ci");
    });

    it("passes the reader_recipient_alignment check and exits cleanly on a healthy repo", async () => {
      const root = join(TEST_DIR, "doctor-healthy");
      writeRepo(root, HEALTHY_MANIFEST, HEALTHY_FILES);
      const { ctx, logger } = createContext(root);

      await doctorCommand(ctx, { startDir: root, explicitRoot: root, json: true });

      const raw = logger.log.mock.calls.map(([message]) => String(message)).join("");
      const envelope = JSON.parse(raw) as {
        ok: boolean;
        data: { checks: Array<{ name: string; ok: boolean; detail: string }> };
      };
      expect(envelope.ok).toBe(true);
      const check = envelope.data.checks.find(
        (entry) => entry.name === "reader_recipient_alignment",
      );
      expect(check).toBeDefined();
      expect(check!.ok).toBe(true);
    });
  });

  describe("hush check", () => {
    it("reports status error with READER_RECIPIENT_DRIFT on a drifted repo", async () => {
      const root = join(TEST_DIR, "check-drifted");
      writeRepo(root, DRIFTED_MANIFEST, DRIFTED_FILES);
      const { ctx } = createContext(root);
      const store = createStore(root);

      const result = await check(ctx, {
        store,
        warn: false,
        json: true,
        quiet: true,
        onlyChanged: false,
        requireSource: false,
      });

      expect(result.status).toBe("error");
      expect(result.files[0]?.error).toBe("READER_RECIPIENT_DRIFT");
      expect(result.files[0]?.encrypted).toContain("ci");
    });

    it("reports status ok on a healthy repo", async () => {
      const root = join(TEST_DIR, "check-healthy");
      writeRepo(root, HEALTHY_MANIFEST, HEALTHY_FILES);
      const { ctx } = createContext(root);
      const store = createStore(root);

      const result = await check(ctx, {
        store,
        warn: false,
        json: true,
        quiet: true,
        onlyChanged: false,
        requireSource: false,
      });

      expect(result.status).toBe("ok");
    });
  });
});
