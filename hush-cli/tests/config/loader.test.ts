import * as nodeFs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  loadConfig,
  findConfigPath,
  findProjectRoot,
  isV3RepositoryRoot,
  loadProjectRuntimeAuthority,
  validateConfig,
} from "../../src/config/loader.js";
import type { LegacyHushConfig } from "../../src/types.js";
import {
  ensureEncryptedFixtureRepo,
  ensureTestSopsConfig,
  writeEncryptedYamlFile,
} from "../helpers/sops-test.js";

const TESTS_DIR = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES_DIR = join(TESTS_DIR, "fixtures");

describe("findConfigPath", () => {
  it("finds hush.yaml in basic fixture", () => {
    const result = findConfigPath(join(FIXTURES_DIR, "basic"));
    expect(result).toBe(join(FIXTURES_DIR, "basic/hush.yaml"));
  });

  it("returns null when no config exists", () => {
    const result = findConfigPath(join(FIXTURES_DIR, "basic/nonexistent"));
    expect(result).toBeNull();
  });

  it("does not treat v3 repositories as hush.yaml config files", () => {
    const root = join(FIXTURES_DIR, "v3/single-user-repo");
    expect(findConfigPath(root)).toBeNull();
    expect(isV3RepositoryRoot(root)).toBe(true);
  });
});

describe("loadConfig", () => {
  it("loads config from basic fixture", () => {
    const config = loadConfig(join(FIXTURES_DIR, "basic"));
    expect(config.sources.shared).toBe(".env");
    expect(config.sources.development).toBe(".env.development");
    expect(config.sources.production).toBe(".env.production");
    expect(config.targets).toHaveLength(1);
    expect(config.targets[0].name).toBe("root");
  });

  it("loads config from monorepo fixture", () => {
    const config = loadConfig(join(FIXTURES_DIR, "monorepo"));
    expect(config.targets).toHaveLength(3);

    const app = config.targets.find((t) => t.name === "app");
    expect(app?.include).toContain("EXPO_PUBLIC_*");

    const api = config.targets.find((t) => t.name === "api");
    expect(api?.format).toBe("wrangler");
    expect(api?.exclude).toContain("EXPO_PUBLIC_*");
  });

  it("fails with bootstrap guidance when no config exists", () => {
    expect(() => loadConfig("/nonexistent/path")).toThrowError(/hush bootstrap/i);
    expect(() => loadConfig("/nonexistent/path")).toThrowError(/hush init/i);
  });

  it("rejects using legacy loadConfig on v3 repositories", () => {
    ensureEncryptedFixtureRepo(join(FIXTURES_DIR, "v3/single-user-repo"));
    expect(() => loadConfig(join(FIXTURES_DIR, "v3/single-user-repo"))).toThrowError(
      /Legacy hush\.yaml runtime loading is disabled/i,
    );
  });

  it("loads v3 repositories through the runtime authority union", () => {
    const fixtureRoot = join(FIXTURES_DIR, "v3/single-user-repo");
    ensureEncryptedFixtureRepo(fixtureRoot);
    const authority = loadProjectRuntimeAuthority(fixtureRoot);

    expect(authority.kind).toBe("v3");
    if (authority.kind === "v3") {
      const repository = authority;
      expect(authority.manifest.activeIdentity).toBe("developer-local");
      expect(repository.files).toHaveLength(1);
      expect(repository.filesByPath["env/app/shared"]?.logicalPaths).toContain(
        "env/apps/api/env/DATABASE_URL",
      );
      expect(
        repository.loadFile("env/app/shared").entries["env/apps/api/env/DATABASE_URL"],
      ).toBeDefined();
    }
  });
});

describe("findProjectRoot", () => {
  const TEST_DIR = join("/tmp", "hush-test-project-root-fixtures");

  beforeEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(join(TEST_DIR, "apps/web/src"), { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("finds hush.yaml in parent directory", () => {
    nodeFs.writeFileSync(join(TEST_DIR, "hush.yaml"), "sources:\n  shared: .env\n");

    const result = findProjectRoot(join(TEST_DIR, "apps/web/src"));
    expect(result).not.toBeNull();
    expect(result?.projectRoot).toBe(TEST_DIR);
    expect(result?.configPath).toBe(join(TEST_DIR, "hush.yaml"));
    expect(result?.repositoryKind).toBe("legacy-v2");
  });

  it("finds hush.yaml in current directory", () => {
    nodeFs.writeFileSync(join(TEST_DIR, "hush.yaml"), "sources:\n  shared: .env\n");

    const result = findProjectRoot(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result?.projectRoot).toBe(TEST_DIR);
    expect(result?.repositoryKind).toBe("legacy-v2");
  });

  it("returns null when no hush.yaml exists", () => {
    const result = findProjectRoot(join(TEST_DIR, "apps/web/src"));
    expect(result).toBeNull();
  });

  it("stops at first hush.yaml found (does not continue walking up)", () => {
    nodeFs.mkdirSync(join(TEST_DIR, "apps/web"), { recursive: true });
    nodeFs.writeFileSync(join(TEST_DIR, "hush.yaml"), "sources:\n  shared: root.env\n");
    nodeFs.writeFileSync(join(TEST_DIR, "apps/hush.yaml"), "sources:\n  shared: apps.env\n");

    const result = findProjectRoot(join(TEST_DIR, "apps/web"));
    expect(result).not.toBeNull();
    expect(result?.projectRoot).toBe(join(TEST_DIR, "apps"));
  });

  it("discovers v3 repos without requiring hush.yaml", () => {
    nodeFs.mkdirSync(join(TEST_DIR, ".hush"), { recursive: true });
    ensureTestSopsConfig(TEST_DIR);
    writeEncryptedYamlFile(
      TEST_DIR,
      join(TEST_DIR, ".hush/manifest.encrypted"),
      "version: 3\nidentities:\n  dev:\n    roles: [owner]\n",
    );

    const result = findProjectRoot(join(TEST_DIR, "apps/web/src"));
    expect(result).not.toBeNull();
    expect(result?.projectRoot).toBe(TEST_DIR);
    expect(result?.repositoryKind).toBe("v3");
    expect(result?.configPath).toBeNull();
  });

  it("does not inherit a Hush repository across a nested Git boundary by default", () => {
    nodeFs.writeFileSync(join(TEST_DIR, "hush.yaml"), "sources:\n  shared: root.env\n");
    nodeFs.mkdirSync(join(TEST_DIR, "apps/web/.git"), { recursive: true });

    expect(findProjectRoot(join(TEST_DIR, "apps/web/src"))).toBeNull();
    expect(
      findProjectRoot(join(TEST_DIR, "apps/web/src"), { stopAtGitRoot: false })?.projectRoot,
    ).toBe(TEST_DIR);
  });
});

describe("validateConfig", () => {
  it("returns no errors for valid config", () => {
    const config: LegacyHushConfig = {
      sources: {
        shared: ".env",
        development: ".env.dev",
        production: ".env.prod",
        local: ".env.local",
      },
      targets: [{ name: "root", path: ".", format: "dotenv" }],
    };
    expect(validateConfig(config)).toEqual([]);
  });

  it("returns error for missing target name", () => {
    const config: LegacyHushConfig = {
      sources: {
        shared: ".env",
        development: ".env.dev",
        production: ".env.prod",
        local: ".env.local",
      },
      targets: [{ name: "", path: ".", format: "dotenv" }],
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes('missing required field "name"'))).toBe(true);
  });

  it("returns error for missing target path", () => {
    const config: LegacyHushConfig = {
      sources: {
        shared: ".env",
        development: ".env.dev",
        production: ".env.prod",
        local: ".env.local",
      },
      targets: [{ name: "test", path: "", format: "dotenv" }],
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes('missing required field "path"'))).toBe(true);
  });

  it("returns error for invalid format", () => {
    const config = {
      sources: {
        shared: ".env",
        development: ".env.dev",
        production: ".env.prod",
        local: ".env.local",
      },
      targets: [{ name: "test", path: ".", format: "invalid" as any }],
    };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes("invalid format"))).toBe(true);
  });

  it("accepts vercel push_to config with required project metadata", () => {
    const config: LegacyHushConfig = {
      sources: {
        shared: ".env",
        development: ".env.dev",
        production: ".env.prod",
        local: ".env.local",
      },
      targets: [
        {
          name: "web",
          path: ".",
          format: "vercel",
          push_to: {
            type: "vercel",
            projectId: "prj_123",
            environments: ["production", "preview"],
          },
        },
      ],
    };

    expect(validateConfig(config)).toEqual([]);
  });
});
