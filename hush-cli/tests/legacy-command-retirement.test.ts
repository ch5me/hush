import * as nodeFs from "node:fs";

import { describe, expect, it } from "vitest";

import { encryptCommand } from "../src/commands/encrypt.js";
import { expansionsCommand } from "../src/commands/expansions.js";
import { templateCommand } from "../src/commands/template.js";
import type { HushContext, StoreContext } from "../src/types.js";

function createStubContext(): HushContext {
  return {
    fs: {
      existsSync: () => false,
      readFileSync: () => "",
      writeFileSync: () => undefined,
      mkdirSync: () => undefined,
      readdirSync: () => [],
      unlinkSync: () => undefined,
      rmSync: () => undefined,
      statSync: (path) => nodeFs.statSync(typeof path === "string" ? path : "/tmp"),
      renameSync: () => undefined,
    },
    path: {
      join: (...parts: string[]) => parts.join("/"),
    },
    exec: {
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      execSync: () => "",
    },
    logger: {
      log: () => undefined,
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
    },
    process: {
      cwd: () => "/tmp/hush-retired",
      exit: ((code: number) => {
        throw new Error(`Process exit: ${code}`);
      }) as never,
      env: {},
      stdin: process.stdin,
      stdout: process.stdout,
      on: () => undefined,
      removeListener: () => undefined,
    },
    config: {
      loadConfig: () => ({
        sources: {
          shared: ".env",
          development: ".env.development",
          production: ".env.production",
          local: ".env.local",
        },
        targets: [],
      }),
      findProjectRoot: () => null,
    },
    age: {
      ageAvailable: () => true,
      ageGenerate: () => ({ private: "private", public: "public" }),
      keyExists: () => false,
      keySave: () => undefined,
      keyPath: () => "",
      keyLoad: () => null,
      agePublicFromPrivate: () => "public",
    },
    sops: {
      decrypt: () => "",
      decryptYaml: () => "",
      encrypt: () => undefined,
      encryptYaml: () => undefined,
      encryptYamlContent: () => undefined,
      edit: () => undefined,
      isSopsInstalled: () => true,
    },
  };
}

const store: StoreContext = {
  mode: "project",
  root: "/tmp/hush-retired",
  configPath: "/tmp/hush-retired/hush.yaml",
  keyIdentity: "test",
  displayLabel: "/tmp/hush-retired",
  projectSlug: "retired-test",
  stateRoot: "/tmp/hush-retired-state",
  projectStateRoot: "/tmp/hush-retired-state/projects/retired-test",
  activeIdentityPath: "/tmp/hush-retired-state/projects/retired-test/active-identity.json",
  auditLogPath: "/tmp/hush-retired-state/projects/retired-test/audit.jsonl",
};

describe("legacy command retirement", () => {
  it("retired legacy commands fail fast and point callers to migration", async () => {
    const ctx = createStubContext();

    await expect(encryptCommand(ctx, { store })).rejects.toThrow(/migrate --from v2/i);
    await expect(templateCommand(ctx, { root: store.root, env: "development" })).rejects.toThrow(
      /migrate --from v2/i,
    );
    await expect(expansionsCommand(ctx, { root: store.root, env: "development" })).rejects.toThrow(
      /migrate --from v2/i,
    );
  });
});
