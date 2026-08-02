import * as nodeFs from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { parseArgs } from "../src/cli.js";
import { bootstrapCommand } from "../src/commands/bootstrap.js";
import { configCommand } from "../src/commands/config.js";
import { editCommand } from "../src/commands/edit.js";
import * as helpers from "../src/commands/v3-command-helpers.js";
import {
  decrypt,
  decryptYaml,
  encrypt,
  encryptYaml,
  encryptYamlContent,
  isSopsInstalled,
} from "../src/core/sops.js";
import { createFileDocument, createFileIndexEntry, createManifestDocument } from "../src/index.js";
import type { HushContext, HushManifestDocument, StoreContext } from "../src/types.js";
import {
  TEST_AGE_PRIVATE_KEY,
  TEST_AGE_PUBLIC_KEY,
  ensureTestSopsEnv,
  writeEncryptedYamlFile,
} from "./helpers/sops-test.js";

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

function writeRepo(root: string, manifest: string, files: Record<string, string>): void {
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
    writeEncryptedYamlFile(
      root,
      join(root, ".hush", "files", `${relativePath}.encrypted`),
      normalizeYaml(content),
    );
  }
}

const TEST_DIR = join("/tmp", "hush-test-edit-command");

function createStore(root: string): StoreContext {
  return {
    mode: "project",
    root,
    configPath: null,
    keyIdentity: root,
    displayLabel: root,
    stateRoot: join(root, ".state-root"),
    projectStateRoot: join(root, ".state-root", "projects", "hush-test-edit-command"),
    activeIdentityPath: join(
      root,
      ".state-root",
      "projects",
      "hush-test-edit-command",
      "active-identity.json",
    ),
    auditLogPath: join(root, ".state-root", "projects", "hush-test-edit-command", "audit.jsonl"),
  };
}

function createContext(root: string): HushContext {
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
    path: {
      join,
    },
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
      stdin: process.stdin,
      stdout: process.stdout,
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    config: {
      loadConfig: vi.fn(),
      findProjectRoot: vi.fn(() => null),
    },
    age: {
      ageAvailable: vi.fn(() => true),
      ageGenerate: vi.fn(() => ({ private: TEST_AGE_PRIVATE_KEY, public: TEST_AGE_PUBLIC_KEY })),
      keyExists: vi.fn(() => false),
      keySave: vi.fn(),
      keyPath: vi.fn(() => join(TEST_DIR, "keys", "edit.txt")),
      keyLoad: vi.fn(() => ({ private: TEST_AGE_PRIVATE_KEY, public: TEST_AGE_PUBLIC_KEY })),
      agePublicFromPrivate: vi.fn(() => TEST_AGE_PUBLIC_KEY),
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
}

describe("editCommand", () => {
  beforeEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function bootstrapEditableRepo(
    rootName: string,
  ): Promise<{ ctx: HushContext; store: StoreContext }> {
    const root = join(TEST_DIR, rootName);
    nodeFs.mkdirSync(root, { recursive: true });
    nodeFs.writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ repository: "https://github.com/hassoncs/hush" }),
      "utf-8",
    );

    const ctx = createContext(root);
    const store = createStore(root);

    await bootstrapCommand(ctx, { store, yes: true });

    return { ctx, store };
  }

  it("denies edits when the active identity is not an owner", async () => {
    const { ctx, store } = await bootstrapEditableRepo("member-edit-denied");

    await configCommand(ctx, { store, subcommand: "active-identity", args: ["member-local"] });

    await expect(
      editCommand(ctx, {
        store,
        file: "shared",
      }),
    ).rejects.toThrow(/must have the owner role/i);
  });

  it("honors EDITOR env var when no override is provided", async () => {
    const { ctx, store } = await bootstrapEditableRepo("editor-env-var");
    const openEncryptedDocumentEditorSpy = vi
      .spyOn(helpers, "openEncryptedDocumentEditor")
      .mockImplementation(() => {
        return {} as never;
      });

    ctx.process.env.EDITOR = "cat";

    await editCommand(ctx, {
      store,
      file: "shared",
    });

    expect(openEncryptedDocumentEditorSpy).toHaveBeenCalledWith(
      ctx,
      store,
      expect.any(String),
      expect.anything(),
      undefined,
    );
  });

  it("prefers explicit editor override over EDITOR env var", async () => {
    const { ctx, store } = await bootstrapEditableRepo("editor-flag-override");
    const openEncryptedDocumentEditorSpy = vi
      .spyOn(helpers, "openEncryptedDocumentEditor")
      .mockImplementation(() => {
        return {} as never;
      });

    ctx.process.env.EDITOR = "cat";

    await editCommand(ctx, {
      store,
      file: "shared",
      editor: "sed -n 1p",
    });

    expect(openEncryptedDocumentEditorSpy).toHaveBeenCalledWith(
      ctx,
      store,
      expect.any(String),
      expect.anything(),
      "sed -n 1p",
    );
    expect(ctx.logger.info).not.toHaveBeenCalled();
  });

  it("parseArgs passes a declared v3 file path through to edit instead of rejecting it", () => {
    const result = parseArgs(["edit", "env/targets/media/runtime"]);
    expect(result.command).toBe("edit");
    expect(result.file).toBe("env/targets/media/runtime");
  });

  it("edits a declared (non-alias) v3 file path", async () => {
    const root = join(TEST_DIR, "declared-path-edit");
    writeRepo(
      root,
      `
      version: 3
      activeIdentity: owner-local
      identities:
        owner-local:
          roles: [owner]
      bundles:
        media:
          files:
            - path: env/project/shared
            - path: env/targets/media/runtime
      targets:
        media:
          bundle: media
          format: dotenv
      `,
      {
        "env/project/shared": `
          path: env/project/shared
          readers:
            roles: [owner]
            identities: [owner-local]
          sensitive: true
          entries: {}
        `,
        "env/targets/media/runtime": `
          path: env/targets/media/runtime
          readers:
            roles: [owner]
            identities: [owner-local]
          sensitive: true
          entries: {}
        `,
      },
    );

    const ctx = createContext(root);
    const store = createStore(root);
    await configCommand(ctx, { store, subcommand: "active-identity", args: ["owner-local"] });

    const openEncryptedDocumentEditorSpy = vi
      .spyOn(helpers, "openEncryptedDocumentEditor")
      .mockImplementation(() => ({}) as never);

    await editCommand(ctx, { store, file: "env/targets/media/runtime" });

    expect(openEncryptedDocumentEditorSpy).toHaveBeenCalledWith(
      ctx,
      store,
      expect.stringContaining(join("env", "targets", "media", "runtime")),
      expect.anything(),
      undefined,
    );
  }, 90000);

  it("hard-errors on an unknown (undeclared) file path instead of silently routing elsewhere", async () => {
    const { ctx, store } = await bootstrapEditableRepo("edit-unknown-path");

    await expect(
      editCommand(ctx, {
        store,
        file: "env/targets/does-not-exist/runtime",
      }),
    ).rejects.toThrow(/Unknown file/i);
  });
});
