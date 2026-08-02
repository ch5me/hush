import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { resolveStoreContext, GLOBAL_STORE_KEY_IDENTITY } from "../src/store.js";
import { createProjectSlug, getProjectStatePaths } from "../src/v3/state.js";
import { TEST_AGE_PUBLIC_KEY, TEST_AGE_PRIVATE_KEY } from "./helpers/sops-test.js";

const TEST_DIR = join("/tmp", "hush-test-store-context");

describe("resolveStoreContext", () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(join(TEST_DIR, "apps/web/src"), { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("resolves project mode to the nearest hush project root", () => {
    nodeFs.writeFileSync(join(TEST_DIR, "hush.yaml"), "project: acme/hush\n");
    nodeFs.writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ repository: "https://github.com/acme/hush" }),
      "utf-8",
    );

    const store = resolveStoreContext(join(TEST_DIR, "apps/web/src"), "project");
    const statePaths = getProjectStatePaths(store);

    expect(store.mode).toBe("project");
    expect(store.root).toBe(TEST_DIR);
    expect(store.configPath).toBe(join(TEST_DIR, "hush.yaml"));
    expect(store.keyIdentity).toBe("acme/hush");
    expect(statePaths.projectSlug).toBe(createProjectSlug("acme/hush"));
    expect(
      statePaths.activeIdentityPath.endsWith(
        `/projects/${statePaths.projectSlug}/active-identity.json`,
      ),
    ).toBe(true);
    expect(
      statePaths.auditLogPath.endsWith(`/projects/${statePaths.projectSlug}/audit.jsonl`),
    ).toBe(true);
  });

  it("resolves global mode to the dedicated ~/.hush root", () => {
    const store = resolveStoreContext(TEST_DIR, "global");
    const statePaths = getProjectStatePaths(store);

    expect(store.mode).toBe("global");
    expect(store.root.endsWith("/.hush")).toBe(true);
    expect(store.displayLabel).toBe("~/.hush");
    expect(store.keyIdentity).toBe(GLOBAL_STORE_KEY_IDENTITY);
    expect(statePaths.projectSlug).toBe(createProjectSlug(GLOBAL_STORE_KEY_IDENTITY));
    expect(
      statePaths.activeIdentityPath.endsWith(
        `/projects/${statePaths.projectSlug}/active-identity.json`,
      ),
    ).toBe(true);
    expect(
      statePaths.auditLogPath.endsWith(`/projects/${statePaths.projectSlug}/audit.jsonl`),
    ).toBe(true);
  });

  it("recovers the project key identity from .sops.yaml when the v3 repo is not yet decryptable", () => {
    const isolatedHome = join(TEST_DIR, "home");
    const projectRoot = join(TEST_DIR, "matrix");
    const projectKeyPath = join(isolatedHome, ".config", "sops", "age", "keys", "matrix.txt");

    process.env.HOME = isolatedHome;
    nodeFs.mkdirSync(join(projectRoot, ".hush"), { recursive: true });
    nodeFs.mkdirSync(dirname(projectKeyPath), { recursive: true });
    nodeFs.writeFileSync(
      join(projectRoot, ".hush", "manifest.encrypted"),
      "not decryptable without key\n",
      "utf-8",
    );
    nodeFs.writeFileSync(
      join(projectRoot, ".sops.yaml"),
      `creation_rules:\n  - encrypted_regex: .*\n    age: ${TEST_AGE_PUBLIC_KEY}\n`,
      "utf-8",
    );
    nodeFs.writeFileSync(
      projectKeyPath,
      `# project: matrix\n# public key: ${TEST_AGE_PUBLIC_KEY}\n${TEST_AGE_PRIVATE_KEY}\n`,
      "utf-8",
    );

    const store = resolveStoreContext(projectRoot, "project");

    expect(store.root).toBe(projectRoot);
    expect(store.keyIdentity).toBe("matrix");
  });

  it("does not guess a project identity when multiple local keys match .sops.yaml recipients", () => {
    const isolatedHome = join(TEST_DIR, "home-ambiguous");
    const projectRoot = join(TEST_DIR, "matrix-ambiguous");
    const firstKeyPath = join(isolatedHome, ".config", "sops", "age", "keys", "matrix.txt");
    const secondKeyPath = join(isolatedHome, ".config", "sops", "age", "keys", "matrix-copy.txt");

    process.env.HOME = isolatedHome;
    nodeFs.mkdirSync(join(projectRoot, ".hush"), { recursive: true });
    nodeFs.mkdirSync(dirname(firstKeyPath), { recursive: true });
    nodeFs.writeFileSync(
      join(projectRoot, ".hush", "manifest.encrypted"),
      "not decryptable without key\n",
      "utf-8",
    );
    nodeFs.writeFileSync(
      join(projectRoot, ".sops.yaml"),
      `creation_rules:\n  - encrypted_regex: .*\n    age: ${TEST_AGE_PUBLIC_KEY}\n`,
      "utf-8",
    );
    nodeFs.writeFileSync(
      firstKeyPath,
      `# project: matrix\n# public key: ${TEST_AGE_PUBLIC_KEY}\n${TEST_AGE_PRIVATE_KEY}\n`,
      "utf-8",
    );
    nodeFs.writeFileSync(
      secondKeyPath,
      `# project: matrix-copy\n# public key: ${TEST_AGE_PUBLIC_KEY}\n${TEST_AGE_PRIVATE_KEY}\n`,
      "utf-8",
    );

    const store = resolveStoreContext(projectRoot, "project");

    expect(store.keyIdentity).toBeUndefined();
  });
});
