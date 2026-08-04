import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { bundleCommand } from "../../src/commands/bundle.js";
import { fileCommand } from "../../src/commands/file.js";
import { targetCommand } from "../../src/commands/target.js";
import { decryptYaml, encryptYamlContent } from "../../src/core/sops.js";
import type {
  FileCommandOptions,
  HushContext,
  StoreContext,
  TargetAddOptions,
  TargetRemoveOptions,
  TargetListOptions,
  BundleAddOptions,
  BundleAddFileOptions,
  BundleRemoveFileOptions,
  BundleRemoveOptions,
  BundleListOptions,
} from "../../src/types.js";
import type { HushManifestDocument } from "../../src/v3/domain.js";
import { persistV3ManifestDocument, loadV3Repository } from "../../src/v3/repository.js";
import { V3_SCHEMA_VERSION } from "../../src/v3/schema.js";
import { ensureTestSopsConfig, writeEncryptedYamlFile } from "../helpers/sops-test.js";
import {
  TEST_AGE_PRIVATE_KEY,
  TEST_AGE_PUBLIC_KEY,
  ensureTestSopsEnv,
} from "../helpers/sops-test.js";

const TESTS_DIR = fileURLToPath(new URL("..", import.meta.url));
const TMP_DIR = join(TESTS_DIR, "tmp-topology-lifecycle");

function createStore(root: string): StoreContext {
  return {
    mode: "project",
    root,
    configPath: null,
    keyIdentity: root,
    displayLabel: root,
    stateRoot: join(root, ".state"),
    projectStateRoot: join(root, ".state", "projects", "hush-test"),
    activeIdentityPath: join(root, ".state", "projects", "hush-test", "active-identity.json"),
    auditLogPath: join(root, ".state", "projects", "hush-test", "audit.jsonl"),
  };
}

function createMockContext(root: string): HushContext {
  ensureTestSopsEnv();

  return {
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
    logger: {
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    },
    process: {
      cwd: () => root,
      exit: ((code: number) => {
        throw new Error(`Process exit: ${code}`);
      }) as never,
      env: {},
      stdin: {
        isTTY: true,
        setEncoding: vi.fn(),
        on: vi.fn(),
        resume: vi.fn(),
        pause: vi.fn(),
        setRawMode: vi.fn(),
        removeListener: vi.fn(),
      } as unknown as NodeJS.ReadStream,
      stdout: { write: vi.fn() } as unknown as NodeJS.WriteStream,
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    config: {
      loadConfig: vi.fn(),
      findProjectRoot: vi.fn(),
    },
    age: {
      ageAvailable: vi.fn(() => true),
      ageGenerate: vi.fn(() => ({ private: TEST_AGE_PRIVATE_KEY, public: TEST_AGE_PUBLIC_KEY })),
      keyExists: vi.fn(() => false),
      keySave: vi.fn(),
      keyPath: vi.fn(() => join(root, "keys", "test.txt")),
      keyLoad: vi.fn(() => ({ private: TEST_AGE_PRIVATE_KEY, public: TEST_AGE_PUBLIC_KEY })),
      agePublicFromPrivate: vi.fn(() => TEST_AGE_PUBLIC_KEY),
    },
    sops: {
      decrypt: vi.fn(),
      decryptYaml: vi.fn((filePath: string, options?: { root?: string; keyIdentity?: string }) =>
        decryptYaml(filePath, options),
      ),
      encrypt: vi.fn(),
      encryptYaml: vi.fn(),
      encryptYamlContent: vi.fn(
        (
          content: string,
          outputPath: string,
          options?: { root?: string; keyIdentity?: string },
        ) => {
          encryptYamlContent(content, outputPath, options);
        },
      ),
      edit: vi.fn(),
      isSopsInstalled: vi.fn(() => true),
    },
  };
}

function writeEncryptedManifest(
  root: string,
  manifest: HushManifestDocument,
  keyIdentity: string,
): void {
  const manifestPath = join(root, ".hush", "manifest.encrypted");
  nodeFs.mkdirSync(join(root, ".hush"), { recursive: true });
  ensureTestSopsConfig(root);
  const content = stringifyYaml(manifest, { indent: 2 });
  writeEncryptedYamlFile(root, manifestPath, content);

  if (manifest.fileIndex) {
    for (const [filePath, entry] of Object.entries(manifest.fileIndex)) {
      const fileContent = stringifyYaml(
        {
          path: entry.path,
          readers: entry.readers,
          sensitive: entry.sensitive,
          entries: {},
        },
        { indent: 2 },
      );
      const fileEncryptedPath = join(root, ".hush", "files", `${filePath}.encrypted`);
      nodeFs.mkdirSync(join(dirname(fileEncryptedPath)), { recursive: true });
      writeEncryptedYamlFile(root, fileEncryptedPath, fileContent);
    }
  }
}

describe("topology-lifecycle", () => {
  beforeEach(() => {
    nodeFs.rmSync(TMP_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe("persistV3ManifestDocument", () => {
    it("(a) valid manifest change persists and survives reload", () => {
      const ctx = createMockContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const repository = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });

      const nextManifest: HushManifestDocument = {
        ...repository.manifest,
        bundles: {
          app: {
            files: [{ path: "env/project/shared" }],
          },
        },
      };

      persistV3ManifestDocument(ctx, store, repository, nextManifest);

      const reloaded = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });
      expect(reloaded.manifest.bundles?.app).toBeDefined();
      expect(reloaded.manifest.bundles?.app?.files).toHaveLength(1);
      expect(reloaded.manifest.bundles?.app?.files[0]?.path).toBe("env/project/shared");
    });

    it("(b) dangling bundle ref throws BEFORE encryptYamlContent is called", () => {
      const ctx = createMockContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const repository = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });

      const invalidManifest: HushManifestDocument = {
        ...repository.manifest,
        bundles: {
          app: {
            files: [{ path: "nonexistent/file" }],
          },
        },
      };

      let encryptCalled = false;
      const originalEncrypt = ctx.sops.encryptYamlContent;
      ctx.sops.encryptYamlContent = vi.fn((...args: Parameters<typeof originalEncrypt>) => {
        encryptCalled = true;
        return originalEncrypt(...args);
      });

      expect(() => persistV3ManifestDocument(ctx, store, repository, invalidManifest)).toThrow();
      expect(encryptCalled).toBe(false);
    });

    it("(c) dangling target ref throws BEFORE encryptYamlContent is called", () => {
      const ctx = createMockContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const repository = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });

      const invalidManifest: HushManifestDocument = {
        ...repository.manifest,
        bundles: {
          app: {
            files: [],
          },
        },
        targets: {
          dev: {
            bundle: "nonexistent-bundle",
            format: "dotenv",
          },
        },
      };

      let encryptCalled = false;
      const originalEncrypt = ctx.sops.encryptYamlContent;
      ctx.sops.encryptYamlContent = vi.fn((...args: Parameters<typeof originalEncrypt>) => {
        encryptCalled = true;
        return originalEncrypt(...args);
      });

      expect(() => persistV3ManifestDocument(ctx, store, repository, invalidManifest)).toThrow();
      expect(encryptCalled).toBe(false);
    });
  });

  describe("file lifecycle", () => {
    function writeActiveIdentityFile(root: string): void {
      const dir = join(root, ".state", "projects", "hush-test");
      nodeFs.mkdirSync(dir, { recursive: true });
      const content = JSON.stringify({
        version: 1,
        identity: "owner",
        updatedAt: new Date().toISOString(),
      });
      nodeFs.writeFileSync(join(dir, "active-identity.json"), content, "utf-8");
    }

    function createFileContext(root: string): HushContext {
      writeActiveIdentityFile(root);
      return createMockContext(root);
    }

    it("(a) add file succeeds", async () => {
      const ctx = createFileContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: FileCommandOptions = {
        store,
        subcommand: "add",
        path: "env/project/newfile",
        roles: "owner,member",
        identities: undefined,
      };

      await fileCommand(ctx, options);

      const reloaded = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });
      expect(reloaded.filesByPath["env/project/newfile"]).toBeDefined();
      expect(reloaded.filesByPath["env/project/newfile"]?.readers.roles).toContain("owner");
      expect(reloaded.filesByPath["env/project/newfile"]?.readers.roles).toContain("member");
    });

    it("(b) add duplicate file fails", async () => {
      const ctx = createFileContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: FileCommandOptions = {
        store,
        subcommand: "add",
        path: "env/project/shared",
        roles: "owner",
        identities: undefined,
      };

      await expect(fileCommand(ctx, options)).rejects.toThrow("already exists");
    });

    it("(c) non-owner add fails", async () => {
      const ctx = createMockContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "member",
        identities: { member: { roles: ["member"] } },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      // Write active identity file for 'member' identity
      const dir = join(TMP_DIR, ".state", "projects", "hush-test");
      nodeFs.mkdirSync(dir, { recursive: true });
      const content = JSON.stringify({
        version: 1,
        identity: "member",
        updatedAt: new Date().toISOString(),
      });
      nodeFs.writeFileSync(join(dir, "active-identity.json"), content, "utf-8");

      const options: FileCommandOptions = {
        store,
        subcommand: "add",
        path: "env/project/newfile",
        roles: "owner",
        identities: undefined,
      };

      await expect(fileCommand(ctx, options)).rejects.toThrow("owner role");
    });

    it("(d) remove unused file succeeds", async () => {
      const ctx = createFileContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: FileCommandOptions = {
        store,
        subcommand: "remove",
        path: "env/project/shared",
      };

      await fileCommand(ctx, options);

      const reloaded = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });
      expect(reloaded.filesByPath["env/project/shared"]).toBeUndefined();
    }, 60000);

    it("(e) remove referenced file fails", async () => {
      const ctx = createFileContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
        bundles: {
          app: {
            files: [{ path: "env/project/shared" }],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: FileCommandOptions = {
        store,
        subcommand: "remove",
        path: "env/project/shared",
      };

      await expect(fileCommand(ctx, options)).rejects.toThrow("bundle");
    });

    it("(f) file list works", async () => {
      const ctx = createFileContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
          "env/project/other": {
            path: "env/project/other",
            readers: { roles: ["owner", "member"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: FileCommandOptions = {
        store,
        subcommand: "list",
        json: true,
      };

      await fileCommand(ctx, options);

      expect(ctx.logger.log).toHaveBeenCalled();
      const logCall = (ctx.logger.log as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      const parsed = JSON.parse(logCall);
      expect(parsed).toMatchObject({ version: 1, ok: true, command: "file" });
      expect(parsed.data.files).toHaveLength(2);
      expect(parsed.data.files.map((f: { path: string }) => f.path)).toContain(
        "env/project/shared",
      );
      expect(parsed.data.files.map((f: { path: string }) => f.path)).toContain("env/project/other");
    });

    it("(g) file readers updates", async () => {
      const ctx = createFileContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: FileCommandOptions = {
        store,
        subcommand: "readers",
        path: "env/project/shared",
        roles: "owner,member,ci",
        identities: undefined,
      };

      const filePath = join(TMP_DIR, ".hush", "files", "env", "project", "shared.encrypted");
      const manifestPath = join(TMP_DIR, ".hush", "manifest.encrypted");
      const beforeFile = nodeFs.readFileSync(filePath);
      const beforeManifest = nodeFs.readFileSync(manifestPath);

      await expect(fileCommand(ctx, options)).rejects.toMatchObject({
        name: "ReaderRecipientAuthorityError",
        code: "READER_RECIPIENT_AUTHORITY_MISSING",
      });

      const reloaded = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });
      expect(reloaded.filesByPath["env/project/shared"]?.readers).toEqual({
        roles: ["owner"],
        identities: [],
      });
      expect(nodeFs.readFileSync(filePath)).toEqual(beforeFile);
      expect(nodeFs.readFileSync(manifestPath)).toEqual(beforeManifest);
    });
  });

  describe("bundle lifecycle", () => {
    function writeActiveIdentityFile(root: string): void {
      const dir = join(root, ".state", "projects", "hush-test");
      nodeFs.mkdirSync(dir, { recursive: true });
      const content = JSON.stringify({
        version: 1,
        identity: "owner",
        updatedAt: new Date().toISOString(),
      });
      nodeFs.writeFileSync(join(dir, "active-identity.json"), content, "utf-8");
    }

    function createBundleContext(root: string): HushContext {
      writeActiveIdentityFile(root);
      return createMockContext(root);
    }

    it("(a) add bundle with explicit file refs succeeds", async () => {
      const ctx = createBundleContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
          "env/project/production": {
            path: "env/project/production",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: BundleAddOptions = {
        store,
        subcommand: "add",
        name: "app",
        files: "env/project/shared,env/project/production",
      };

      await bundleCommand(ctx, options);

      const reloaded = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });
      expect(reloaded.manifest.bundles?.app).toBeDefined();
      expect(reloaded.manifest.bundles?.app?.files).toHaveLength(2);
      expect(reloaded.manifest.bundles?.app?.files?.[0]?.path).toBe("env/project/shared");
      expect(reloaded.manifest.bundles?.app?.files?.[1]?.path).toBe("env/project/production");
    });

    it("(b) add bundle with missing file fails", async () => {
      const ctx = createBundleContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: BundleAddOptions = {
        store,
        subcommand: "add",
        name: "app",
        files: "env/project/shared,env/project/nonexistent",
      };

      await expect(bundleCommand(ctx, options)).rejects.toThrow("does not exist in file index");
    });

    it("(c) adding an identical bundle reports no change", async () => {
      const ctx = createBundleContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        bundles: {
          app: {
            files: [{ path: "env/project/shared" }],
          },
        },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: BundleAddOptions = {
        store,
        subcommand: "add",
        name: "app",
        files: "env/project/shared",
        json: true,
      };

      await bundleCommand(ctx, options);
      const payload = JSON.parse(String(vi.mocked(ctx.logger.log).mock.calls.at(-1)?.[0]));
      expect(payload).toMatchObject({ version: 1, ok: true, command: "bundle" });
      expect(payload.data).toMatchObject({ action: "add-bundle", changed: false, bundle: "app" });
    });

    it("(d) add bundle with duplicate file refs fails", async () => {
      const ctx = createBundleContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: BundleAddOptions = {
        store,
        subcommand: "add",
        name: "app",
        files: "env/project/shared,env/project/shared",
      };

      await expect(bundleCommand(ctx, options)).rejects.toThrow("Duplicate file reference");
    });

    it("(e) non-owner add bundle fails", async () => {
      const ctx = createMockContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "member",
        identities: { member: { roles: ["member"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      // Write active identity file for 'member' identity
      const dir = join(TMP_DIR, ".state", "projects", "hush-test");
      nodeFs.mkdirSync(dir, { recursive: true });
      const content = JSON.stringify({
        version: 1,
        identity: "member",
        updatedAt: new Date().toISOString(),
      });
      nodeFs.writeFileSync(join(dir, "active-identity.json"), content, "utf-8");

      const options: BundleAddOptions = {
        store,
        subcommand: "add",
        name: "app",
        files: "env/project/shared",
      };

      await expect(bundleCommand(ctx, options)).rejects.toThrow("owner role");
    });
  });

  describe("target lifecycle", () => {
    function writeActiveIdentityFile(root: string): void {
      const dir = join(root, ".state", "projects", "hush-test");
      nodeFs.mkdirSync(dir, { recursive: true });
      const content = JSON.stringify({
        version: 1,
        identity: "owner",
        updatedAt: new Date().toISOString(),
      });
      nodeFs.writeFileSync(join(dir, "active-identity.json"), content, "utf-8");
    }

    function createTargetContext(root: string): HushContext {
      writeActiveIdentityFile(root);
      return createMockContext(root);
    }

    it("(a) add target succeeds", async () => {
      const ctx = createTargetContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        bundles: {
          app: {
            files: [{ path: "env/project/shared" }],
          },
        },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: TargetAddOptions = {
        store,
        subcommand: "add",
        name: "api",
        bundle: "app",
        format: "dotenv",
        mode: "process",
      };

      await targetCommand(ctx, options);

      const reloaded = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });
      expect(reloaded.manifest.targets?.api).toBeDefined();
      expect(reloaded.manifest.targets?.api?.bundle).toBe("app");
      expect(reloaded.manifest.targets?.api?.format).toBe("dotenv");
      expect(reloaded.manifest.targets?.api?.mode).toBe("process");
    });

    it("(b) add target without format fails", async () => {
      const ctx = createTargetContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: TargetAddOptions = {
        store,
        subcommand: "add",
        name: "api",
        bundle: "app",
        format: "",
      };

      await expect(targetCommand(ctx, options)).rejects.toThrow("--format is required");
    });

    it("(c) add target without bundle fails", async () => {
      const ctx = createTargetContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: TargetAddOptions = {
        store,
        subcommand: "add",
        name: "api",
        bundle: undefined,
        format: "dotenv",
      };

      await expect(targetCommand(ctx, options)).rejects.toThrow("--bundle is required");
    });

    it("(d) add target with unknown bundle fails", async () => {
      const ctx = createTargetContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: TargetAddOptions = {
        store,
        subcommand: "add",
        name: "api",
        bundle: "nonexistent",
        format: "dotenv",
      };

      await expect(targetCommand(ctx, options)).rejects.toThrow("not declared in this repository");
    });

    it("(e) remove target succeeds", async () => {
      const ctx = createTargetContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        bundles: {
          app: {
            files: [{ path: "env/project/shared" }],
          },
        },
        targets: {
          api: {
            bundle: "app",
            format: "dotenv",
          },
        },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: TargetRemoveOptions = {
        store,
        subcommand: "remove",
        name: "api",
      };

      await targetCommand(ctx, options);

      const reloaded = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });
      expect(reloaded.manifest.targets?.api).toBeUndefined();
    });

    it("(f) remove nonexistent target fails", async () => {
      const ctx = createTargetContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: TargetRemoveOptions = {
        store,
        subcommand: "remove",
        name: "nonexistent",
      };

      await expect(targetCommand(ctx, options)).rejects.toThrow("not found");
    });

    it("(g) non-owner add target fails", async () => {
      const ctx = createMockContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "member",
        identities: { member: { roles: ["member"] } },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      // Write active identity file for 'member' identity
      const dir = join(TMP_DIR, ".state", "projects", "hush-test");
      nodeFs.mkdirSync(dir, { recursive: true });
      const content = JSON.stringify({
        version: 1,
        identity: "member",
        updatedAt: new Date().toISOString(),
      });
      nodeFs.writeFileSync(join(dir, "active-identity.json"), content, "utf-8");

      const options: TargetAddOptions = {
        store,
        subcommand: "add",
        name: "api",
        bundle: "app",
        format: "dotenv",
      };

      await expect(targetCommand(ctx, options)).rejects.toThrow("owner role");
    });

    it("(h) target list works", async () => {
      const ctx = createTargetContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        bundles: {
          app: {
            files: [{ path: "env/project/shared" }],
          },
        },
        targets: {
          api: {
            bundle: "app",
            format: "dotenv",
          },
          web: {
            bundle: "app",
            format: "json",
            mode: "file",
          },
        },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: TargetListOptions = {
        store,
        subcommand: "list",
        json: true,
      };

      await targetCommand(ctx, options);

      expect(ctx.logger.log).toHaveBeenCalled();
      const logCall = (ctx.logger.log as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      const parsed = JSON.parse(logCall);
      expect(parsed).toMatchObject({ version: 1, ok: true, command: "target" });
      expect(parsed.data.targets.api).toBeDefined();
      expect(parsed.data.targets.web).toBeDefined();
      expect(parsed.data.targets.api.bundle).toBe("app");
      expect(parsed.data.targets.web.format).toBe("json");
    });
  });

  describe("bundle lifecycle", () => {
    function writeActiveIdentityFile(root: string): void {
      const dir = join(root, ".state", "projects", "hush-test");
      nodeFs.mkdirSync(dir, { recursive: true });
      const content = JSON.stringify({
        version: 1,
        identity: "owner",
        updatedAt: new Date().toISOString(),
      });
      nodeFs.writeFileSync(join(dir, "active-identity.json"), content, "utf-8");
    }

    function createBundleContext(root: string): HushContext {
      writeActiveIdentityFile(root);
      return createMockContext(root);
    }

    it("(a) add bundle succeeds", async () => {
      const ctx = createBundleContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
          "env/project/other": {
            path: "env/project/other",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: BundleAddOptions = {
        store,
        subcommand: "add",
        name: "app",
        files: "env/project/shared,env/project/other",
      };

      await bundleCommand(ctx, options);

      const reloaded = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });
      expect(reloaded.manifest.bundles?.app).toBeDefined();
      expect(reloaded.manifest.bundles?.app?.files).toHaveLength(2);
      expect(reloaded.manifest.bundles?.app?.files?.[0]?.path).toBe("env/project/shared");
      expect(reloaded.manifest.bundles?.app?.files?.[1]?.path).toBe("env/project/other");
    });

    it("(b) add bundle with missing file fails", async () => {
      const ctx = createBundleContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: BundleAddOptions = {
        store,
        subcommand: "add",
        name: "app",
        files: "env/project/shared,nonexistent/file",
      };

      await expect(bundleCommand(ctx, options)).rejects.toThrow("does not exist");
    });

    it("(c) add bundle with duplicate name fails", async () => {
      const ctx = createBundleContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        bundles: {
          app: {
            files: [{ path: "env/project/shared" }],
          },
        },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: BundleAddOptions = {
        store,
        subcommand: "add",
        name: "app",
      };

      await expect(bundleCommand(ctx, options)).rejects.toThrow("already exists");
    });

    it("(d) add-file to existing bundle succeeds", async () => {
      const ctx = createBundleContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        bundles: {
          app: {
            files: [{ path: "env/project/shared" }],
          },
        },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
          "env/project/other": {
            path: "env/project/other",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: BundleAddFileOptions = {
        store,
        subcommand: "add-file",
        bundle: "app",
        file: "env/project/other",
      };

      await bundleCommand(ctx, options);

      const reloaded = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });
      expect(reloaded.manifest.bundles?.app?.files).toHaveLength(2);
      expect(
        reloaded.manifest.bundles?.app?.files?.some((f) => f.path === "env/project/shared"),
      ).toBe(true);
      expect(
        reloaded.manifest.bundles?.app?.files?.some((f) => f.path === "env/project/other"),
      ).toBe(true);
    });

    it("(e) add-file with an already-present file reports no change", async () => {
      const ctx = createBundleContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        bundles: {
          app: {
            files: [{ path: "env/project/shared" }],
          },
        },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: BundleAddFileOptions = {
        store,
        subcommand: "add-file",
        bundle: "app",
        file: "env/project/shared",
        json: true,
      };

      await bundleCommand(ctx, options);
      const payload = JSON.parse(String(vi.mocked(ctx.logger.log).mock.calls.at(-1)?.[0]));
      expect(payload).toMatchObject({ version: 1, ok: true, command: "bundle" });
      expect(payload.data).toEqual({
        action: "add-file-to-bundle",
        changed: false,
        bundle: "app",
        file: "env/project/shared",
      });
    });

    it("(f) remove-file from bundle succeeds", async () => {
      const ctx = createBundleContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        bundles: {
          app: {
            files: [{ path: "env/project/shared" }, { path: "env/project/other" }],
          },
        },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
          "env/project/other": {
            path: "env/project/other",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: BundleRemoveFileOptions = {
        store,
        subcommand: "remove-file",
        bundle: "app",
        file: "env/project/other",
      };

      await bundleCommand(ctx, options);

      const reloaded = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });
      expect(reloaded.manifest.bundles?.app?.files).toHaveLength(1);
      expect(reloaded.manifest.bundles?.app?.files?.[0]?.path).toBe("env/project/shared");
    });

    it("(g) remove bundle succeeds", async () => {
      const ctx = createBundleContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        bundles: {
          app: {
            files: [{ path: "env/project/shared" }],
          },
        },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: BundleRemoveOptions = {
        store,
        subcommand: "remove",
        name: "app",
      };

      await bundleCommand(ctx, options);

      const reloaded = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });
      expect(reloaded.manifest.bundles?.app).toBeUndefined();
    });

    it("(h) remove bundle referenced by target fails", async () => {
      const ctx = createBundleContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        bundles: {
          app: {
            files: [{ path: "env/project/shared" }],
          },
        },
        targets: {
          api: {
            bundle: "app",
            format: "dotenv",
          },
        },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: BundleRemoveOptions = {
        store,
        subcommand: "remove",
        name: "app",
      };

      await expect(bundleCommand(ctx, options)).rejects.toThrow();
    });

    it("(i) bundle list works", async () => {
      const ctx = createBundleContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        bundles: {
          app: {
            files: [{ path: "env/project/shared" }],
          },
          web: {
            files: [{ path: "env/project/shared" }],
            imports: [{ bundle: "app" }],
          },
        },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const options: BundleListOptions = {
        store,
        subcommand: "list",
        json: true,
      };

      await bundleCommand(ctx, options);

      expect(ctx.logger.log).toHaveBeenCalled();
      const logCall = (ctx.logger.log as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      const parsed = JSON.parse(logCall);
      expect(parsed).toMatchObject({ version: 1, ok: true, command: "bundle" });
      expect(parsed.data.bundles).toHaveLength(2);
      expect(parsed.data.bundles.map((b: { name: string }) => b.name)).toContain("app");
      expect(parsed.data.bundles.map((b: { name: string }) => b.name)).toContain("web");
    });

    it("(j) non-owner bundle mutation fails", async () => {
      const ctx = createMockContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "member",
        identities: { member: { roles: ["member"] } },
        fileIndex: {
          "env/project/shared": {
            path: "env/project/shared",
            readers: { roles: ["owner"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      const dir = join(TMP_DIR, ".state", "projects", "hush-test");
      nodeFs.mkdirSync(dir, { recursive: true });
      const content = JSON.stringify({
        version: 1,
        identity: "member",
        updatedAt: new Date().toISOString(),
      });
      nodeFs.writeFileSync(join(dir, "active-identity.json"), content, "utf-8");

      const options: BundleAddOptions = {
        store,
        subcommand: "add",
        name: "app",
      };

      await expect(bundleCommand(ctx, options)).rejects.toThrow("owner role");
    });
  });

  describe("full topology lifecycle integration", () => {
    function writeActiveIdentityFile(root: string): void {
      const dir = join(root, ".state", "projects", "hush-test");
      nodeFs.mkdirSync(dir, { recursive: true });
      const content = JSON.stringify({
        version: 1,
        identity: "owner",
        updatedAt: new Date().toISOString(),
      });
      nodeFs.writeFileSync(join(dir, "active-identity.json"), content, "utf-8");
    }

    function createOwnerContext(root: string): HushContext {
      writeActiveIdentityFile(root);
      return createMockContext(root);
    }

    it(
      "(a) file add → bundle add → target add → target remove → bundle remove → file remove",
      { timeout: 30000 },
      async () => {
        const ctx = createOwnerContext(TMP_DIR);
        const store = createStore(TMP_DIR);

        // Bootstrap with a pre-existing file so loadV3Repository can validate the fileIndex
        const initialManifest: HushManifestDocument = {
          version: V3_SCHEMA_VERSION,
          activeIdentity: "owner",
          identities: { owner: { roles: ["owner"] } },
          fileIndex: {
            "env/api/shared": {
              path: "env/api/shared",
              readers: { roles: ["owner", "ci"], identities: [] },
              sensitive: false,
              logicalPaths: [],
            },
          },
        };
        writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

        // Step 1: add a new file
        const fileAddOptions: FileCommandOptions = {
          store,
          subcommand: "add",
          path: "env/api/production",
          roles: "owner,ci",
          identities: undefined,
        };
        await fileCommand(ctx, fileAddOptions);

        // Step 2: add a bundle referencing the new file
        const bundleAddOptions: BundleAddOptions = {
          store,
          subcommand: "add",
          name: "api-production",
          files: "env/api/production",
        };
        await bundleCommand(ctx, bundleAddOptions);

        // Step 3: add a target consuming that bundle
        const targetAddOptions: TargetAddOptions = {
          store,
          subcommand: "add",
          name: "api-production",
          bundle: "api-production",
          format: "dotenv",
          mode: "process",
        };
        await targetCommand(ctx, targetAddOptions);

        // Step 4: verify target is accessible via target list
        const targetListOptions: TargetListOptions = {
          store,
          subcommand: "list",
          json: true,
        };
        await targetCommand(ctx, targetListOptions);

        const allCalls = (ctx.logger.log as ReturnType<typeof vi.fn>).mock.calls;
        const listLogCall = allCalls[allCalls.length - 1]![0] as string;
        const parsedTargets = JSON.parse(listLogCall);
        expect(parsedTargets).toMatchObject({ version: 1, ok: true, command: "target" });
        expect(parsedTargets.data.targets["api-production"]).toBeDefined();
        expect(parsedTargets.data.targets["api-production"].bundle).toBe("api-production");
        expect(parsedTargets.data.targets["api-production"].format).toBe("dotenv");

        // Step 5: teardown — remove target first
        const targetRemoveOptions: TargetRemoveOptions = {
          store,
          subcommand: "remove",
          name: "api-production",
        };
        await targetCommand(ctx, targetRemoveOptions);

        // Step 6: removing bundle while target is gone succeeds
        const bundleRemoveOptions: BundleRemoveOptions = {
          store,
          subcommand: "remove",
          name: "api-production",
        };
        await bundleCommand(ctx, bundleRemoveOptions);

        // Step 7: removing file while bundle is gone succeeds
        const fileRemoveOptions: FileCommandOptions = {
          store,
          subcommand: "remove",
          path: "env/api/production",
        };
        await fileCommand(ctx, fileRemoveOptions);

        // Final verification: reload and confirm clean teardown
        const finalRepo = loadV3Repository(TMP_DIR, { keyIdentity: TMP_DIR });
        expect(finalRepo.manifest.targets?.["api-production"]).toBeUndefined();
        expect(finalRepo.manifest.bundles?.["api-production"]).toBeUndefined();
        expect(finalRepo.filesByPath["env/api/production"]).toBeUndefined();
        // The pre-existing file should still be there
        expect(finalRepo.filesByPath["env/api/shared"]).toBeDefined();
      },
    );

    it("(b) cannot remove bundle while target still references it", async () => {
      const ctx = createOwnerContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/api/production": {
            path: "env/api/production",
            readers: { roles: ["owner", "ci"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
        bundles: {
          "api-production": {
            files: [{ path: "env/api/production" }],
          },
        },
        targets: {
          "api-production": {
            bundle: "api-production",
            format: "dotenv",
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      // Attempting to remove the bundle while the target still references it must fail
      const bundleRemoveOptions: BundleRemoveOptions = {
        store,
        subcommand: "remove",
        name: "api-production",
      };
      await expect(bundleCommand(ctx, bundleRemoveOptions)).rejects.toThrow();
    });

    it("(c) cannot remove file while bundle still references it", async () => {
      const ctx = createOwnerContext(TMP_DIR);
      const store = createStore(TMP_DIR);

      const initialManifest: HushManifestDocument = {
        version: V3_SCHEMA_VERSION,
        activeIdentity: "owner",
        identities: { owner: { roles: ["owner"] } },
        fileIndex: {
          "env/api/production": {
            path: "env/api/production",
            readers: { roles: ["owner", "ci"], identities: [] },
            sensitive: false,
            logicalPaths: [],
          },
        },
        bundles: {
          "api-production": {
            files: [{ path: "env/api/production" }],
          },
        },
      };
      writeEncryptedManifest(TMP_DIR, initialManifest, TMP_DIR);

      // Attempting to remove the file while the bundle still references it must fail
      const fileRemoveOptions: FileCommandOptions = {
        store,
        subcommand: "remove",
        path: "env/api/production",
      };
      await expect(fileCommand(ctx, fileRemoveOptions)).rejects.toThrow("bundle");
    });
  });
});
