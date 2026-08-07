import * as nodeFs from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { parseArgs, validateCommandOptions } from "../src/cli.js";
import { bootstrapCommand } from "../src/commands/bootstrap.js";
import { configCommand } from "../src/commands/config.js";
import { setCommand } from "../src/commands/set.js";
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
  readDecryptedYamlFile,
  writeEncryptedYamlFile,
} from "./helpers/sops-test.js";

const TEST_DIR = join("/tmp", "hush-test-set-command");

function createStore(root: string, mode: "project" | "global" = "project"): StoreContext {
  const stateRoot = join(root, ".state-root");
  return {
    mode,
    root,
    configPath: mode === "project" ? join(root, "hush.yaml") : null,
    keyIdentity: mode === "global" ? "hush-global" : root,
    displayLabel: root,
    stateRoot: mode === "global" ? stateRoot : undefined,
    projectStateRoot:
      mode === "global" ? join(stateRoot, "projects", "hush-global-test") : undefined,
    activeIdentityPath:
      mode === "global"
        ? join(stateRoot, "projects", "hush-global-test", "active-identity.json")
        : undefined,
    auditLogPath:
      mode === "global"
        ? join(stateRoot, "projects", "hush-global-test", "audit.jsonl")
        : undefined,
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
      keyExists: vi.fn((identity: string) => identity === "hush-global"),
      keySave: vi.fn(),
      keyPath: vi.fn(() => join(TEST_DIR, "keys", "hush-global.txt")),
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

describe("setCommand legacy guard and global bootstrap", () => {
  beforeEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("rejects legacy hush.yaml repos instead of writing legacy encrypted source files", async () => {
    const root = join(TEST_DIR, "legacy-repo");
    nodeFs.mkdirSync(root, { recursive: true });
    nodeFs.writeFileSync(
      join(root, "hush.yaml"),
      "version: 2\nsources:\n  shared: .env\ntargets:\n  - name: root\n    path: .\n    format: dotenv\n",
      "utf-8",
    );

    const ctx = createContext(root);

    await expect(
      setCommand(ctx, {
        store: createStore(root),
        key: "DATABASE_URL",
        value: "postgres://db",
      }),
    ).rejects.toThrow(/Bootstrap or migrate before using this command/i);
  });

  it("bootstraps the global store as a v3 repository before writing secrets", async () => {
    const root = join(TEST_DIR, "global-store");
    const ctx = createContext(root);

    await setCommand(ctx, {
      store: createStore(root, "global"),
      key: "OPENAI_API_KEY",
      value: "secret-value",
    });

    expect(nodeFs.existsSync(join(root, ".hush", "manifest.encrypted"))).toBe(true);
    expect(
      nodeFs.existsSync(join(root, ".hush", "files", "env", "project", "shared.encrypted")),
    ).toBe(true);
    expect(nodeFs.existsSync(join(root, ".sops.yaml"))).toBe(true);

    const sharedFile = readDecryptedYamlFile(
      root,
      join(root, ".hush", "files", "env", "project", "shared.encrypted"),
    );
    expect(sharedFile).toContain("env/project/shared/OPENAI_API_KEY");
    expect(sharedFile).toContain("secret-value");
  });

  it("denies writes when the active identity is not an owner", async () => {
    const root = join(TEST_DIR, "member-write-denied");
    nodeFs.mkdirSync(root, { recursive: true });
    nodeFs.writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ repository: "https://github.com/hassoncs/hush" }),
      "utf-8",
    );

    const ctx = createContext(root);
    const store = createStore(root);

    await bootstrapCommand(ctx, { store, yes: true });
    await configCommand(ctx, { store, subcommand: "active-identity", args: ["member-local"] });

    await expect(
      setCommand(ctx, {
        store,
        key: "DATABASE_URL",
        value: "postgres://db",
      }),
    ).rejects.toThrow(/must have the owner role/i);
  });

  it("writes to declared non-default v3 file paths", async () => {
    const root = join(TEST_DIR, "declared-staging-path");
    writeRepo(
      root,
      `
      version: 3
      activeIdentity: owner-local
      identities:
        owner-local:
          roles: [owner]
      bundles:
        project:
          files:
            - path: env/project/shared
            - path: env/project/staging
      targets:
        runtime:
          bundle: project
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
        "env/project/staging": `
          path: env/project/staging
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
    // Establish the active identity explicitly: machine-local state does not
    // exist on a clean runner, and tests must not depend on leftover ~/.hush state.
    await configCommand(ctx, { store, subcommand: "active-identity", args: ["owner-local"] });

    await setCommand(ctx, {
      store,
      file: "shared",
      key: "SHARED_KEY",
      value: "shared-value",
    });

    await setCommand(ctx, {
      store,
      file: "env/project/staging",
      key: "WORKER_ENV",
      value: "staging",
    });

    const sharedFile = readDecryptedYamlFile(
      root,
      join(root, ".hush", "files", "env", "project", "shared.encrypted"),
    );
    const stagingFile = readDecryptedYamlFile(
      root,
      join(root, ".hush", "files", "env", "project", "staging.encrypted"),
    );
    expect(sharedFile).toContain("env/project/shared/SHARED_KEY");
    expect(sharedFile).toContain("shared-value");
    expect(stagingFile).toContain("path: env/project/staging");
    expect(stagingFile).toContain("env/project/staging/WORKER_ENV");
    expect(stagingFile).toContain("staging");
  }, 90000);

  it("writes stdin values to the declared v3 file path instead of shared", async () => {
    const root = join(TEST_DIR, "stdin-staging-path");
    writeRepo(
      root,
      `
      version: 3
      activeIdentity: owner-local
      identities:
        owner-local:
          roles: [owner]
      bundles:
        project:
          files:
            - path: env/project/shared
            - path: env/project/staging
      targets:
        wrangler-deploy-staging:
          bundle: project
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
        "env/project/staging": `
          path: env/project/staging
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

    const stdinHandlers: Partial<
      Record<"data" | "end" | "error", (chunk?: string | Error) => void>
    > = {};
    ctx.process.stdin = {
      isTTY: false,
      setEncoding: vi.fn(),
      on: vi.fn((event: "data" | "end" | "error", handler: (chunk?: string | Error) => void) => {
        stdinHandlers[event] = handler;
        return ctx.process.stdin;
      }),
      resume: vi.fn(() => {
        queueMicrotask(() => {
          stdinHandlers.data?.("smoke-value\n");
          stdinHandlers.end?.();
        });
        return ctx.process.stdin;
      }),
      pause: vi.fn(),
      setRawMode: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as NodeJS.ReadStream;

    await setCommand(ctx, {
      store,
      file: "env/project/staging",
      key: "FOLIO_CI_HUSH_WRITE_SMOKE",
    });

    const sharedFile = readDecryptedYamlFile(
      root,
      join(root, ".hush", "files", "env", "project", "shared.encrypted"),
    );
    const stagingFile = readDecryptedYamlFile(
      root,
      join(root, ".hush", "files", "env", "project", "staging.encrypted"),
    );

    expect(stagingFile).toContain("env/project/staging/FOLIO_CI_HUSH_WRITE_SMOKE");
    expect(stagingFile).toContain("smoke-value");
    expect(sharedFile).not.toContain("FOLIO_CI_HUSH_WRITE_SMOKE");
  }, 90000);

  // env/project/local is an ordinary repository path. It was once also an alias
  // for the machine-local store, so this asserts the repository file wins — now
  // unconditionally, not by precedence over a competing meaning.
  it("writes a declared env/project/local to the repository file", async () => {
    const root = join(TEST_DIR, "explicit-local-path");
    writeRepo(
      root,
      `
      version: 3
      activeIdentity: owner-local
      identities:
        owner-local:
          roles: [owner]
      bundles:
        local-runtime:
          files:
            - path: env/project/shared
            - path: env/project/local
      targets:
        root-runtime-local:
          bundle: local-runtime
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
        "env/project/local": `
          path: env/project/local
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

    await setCommand(ctx, {
      store,
      file: "env/project/local",
      key: "ELFAUTH_KID",
      value: "local-kid",
    });

    const localFile = readDecryptedYamlFile(
      root,
      join(root, ".hush", "files", "env", "project", "local.encrypted"),
    );
    const machineLocalOverride = join(
      root,
      ".state-root",
      "projects",
      "hush-global-test",
      "user",
      "local-overrides.encrypted",
    );

    expect(localFile).toContain("env/project/local/ELFAUTH_KID");
    expect(localFile).toContain("local-kid");
    expect(nodeFs.existsSync(machineLocalOverride)).toBe(false);
  }, 90000);
});

describe("CLI argument parsing for set command", () => {
  it("rejects --target and recommends an explicit file", () => {
    const parsed = parseArgs(["set", "MY_KEY", "--target", "production"]);
    expect(validateCommandOptions(parsed)).toMatch(/does not accept --target.*--file/);
  });

  it("rejects --target even when --file is also supplied", () => {
    const parsed = parseArgs([
      "set",
      "MY_KEY",
      "value",
      "--target",
      "production",
      "--file",
      "env/project/production",
    ]);
    expect(validateCommandOptions(parsed)).toMatch(/does not accept --target/);
  });

  it("rejects conflicting destination selectors", () => {
    const parsed = parseArgs(["set", "MY_KEY", "--file", "env/project/production", "--repo-local"]);
    expect(validateCommandOptions(parsed)).toMatch(
      /conflicting destination selectors.*--file.*--repo-local/,
    );
  });

  it("rejects recognized options that set does not consume", () => {
    const parsed = parseArgs(["set", "MY_KEY", "--bundle", "runtime"]);
    expect(validateCommandOptions(parsed)).toBe("`hush set` does not accept --bundle.");
  });

  it("enforces the option contract for other mutating commands", () => {
    const parsed = parseArgs(["delete-key", "MY_KEY", "--target", "production"]);
    expect(validateCommandOptions(parsed)).toBe("`hush delete-key` does not accept --target.");
  });

  it("accepts --target on has, so presence can be checked against one named target", () => {
    const parsed = parseArgs(["has", "MY_KEY", "--target", "root"]);
    expect(validateCommandOptions(parsed)).toBeNull();
  });

  it("accepts --target on inspect, so it can scope to one named target", () => {
    const parsed = parseArgs(["inspect", "--target", "root"]);
    expect(validateCommandOptions(parsed)).toBeNull();
  });

  it("parses hush set KEY VALUE correctly", () => {
    const result = parseArgs(["set", "MY_KEY", "my-value"]);

    expect(result.command).toBe("set");
    expect(result.key).toBe("MY_KEY");
    expect(result.value).toBe("my-value");
  });

  it("parses hush set KEY (no value) for prompting", () => {
    const result = parseArgs(["set", "MY_KEY"]);

    expect(result.command).toBe("set");
    expect(result.key).toBe("MY_KEY");
    expect(result.value).toBeUndefined();
  });

  it("parses hush set KEY VALUE -e production correctly", () => {
    const result = parseArgs(["set", "MY_KEY", "my-value", "-e", "production"]);

    expect(result.command).toBe("set");
    expect(result.key).toBe("MY_KEY");
    expect(result.value).toBe("my-value");
    expect(result.env).toBe("production");
    expect(result.envExplicit).toBe(true);
  });

  it("parses hush set KEY --local correctly", () => {
    const result = parseArgs(["set", "MY_KEY", "--local"]);

    expect(result.command).toBe("set");
    expect(result.key).toBe("MY_KEY");
    expect(result.local).toBe(true);
  });

  it("parses hush set KEY VALUE --file env/project/staging correctly", () => {
    const result = parseArgs(["set", "MY_KEY", "my-value", "--file", "env/project/staging"]);

    expect(result.command).toBe("set");
    expect(result.key).toBe("MY_KEY");
    expect(result.value).toBe("my-value");
    expect(result.setFile).toBe("env/project/staging");
  });

  it("parses hush set KEY VALUE --repo-local correctly", () => {
    const result = parseArgs(["set", "MY_KEY", "my-value", "--repo-local"]);

    expect(result.command).toBe("set");
    expect(result.key).toBe("MY_KEY");
    expect(result.value).toBe("my-value");
    expect(result.repoLocal).toBe(true);
  });

  it("parses hush copy-key KEY --from <file> --to <file> correctly", () => {
    const result = parseArgs([
      "copy-key",
      "MY_KEY",
      "--from",
      "env/project/shared",
      "--to",
      "env/project/staging",
    ]);

    expect(result.command).toBe("copy-key");
    expect(result.key).toBe("MY_KEY");
    expect(result.from).toBe("env/project/shared");
    expect(result.outputRoot).toBe("env/project/staging");
  });

  it("parses hush delete-key KEY --from <file> correctly", () => {
    const result = parseArgs(["delete-key", "MY_KEY", "--from", "env/project/shared"]);

    expect(result.command).toBe("delete-key");
    expect(result.key).toBe("MY_KEY");
    expect(result.from).toBe("env/project/shared");
  });
});
