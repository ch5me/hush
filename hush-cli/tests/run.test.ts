import * as nodeFs from "node:fs";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findPinnedNodeBin,
  nodeVersionMatchesSpec,
  parseNodeVersionSpec,
  runCommand,
} from "../src/commands/run.js";
import type { HushContext, StoreContext } from "../src/types.js";

const TEST_DIR = join("/tmp", "hush-test-run-command");

function createStore(root: string): StoreContext {
  return {
    mode: "project",
    root,
    configPath: join(root, "hush.yaml"),
    keyIdentity: root,
    displayLabel: root,
  };
}

function createContext(root: string): HushContext {
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
      stdin: {} as NodeJS.ReadStream,
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
      ageGenerate: vi.fn(),
      keyExists: vi.fn(() => false),
      keySave: vi.fn(),
      keyPath: vi.fn(() => ""),
      keyLoad: vi.fn(() => null),
      agePublicFromPrivate: vi.fn(() => ""),
    },
    sops: {
      decrypt: vi.fn(() => ""),
      decryptYaml: vi.fn(() => ""),
      encrypt: vi.fn(),
      encryptYaml: vi.fn(),
      encryptYamlContent: vi.fn(),
      edit: vi.fn(),
      isSopsInstalled: vi.fn(() => true),
    },
  };
}

describe("runCommand legacy repo rejection", () => {
  beforeEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("fails with migration guidance when no v3 repository exists yet", async () => {
    const root = join(TEST_DIR, "legacy-repo");
    nodeFs.mkdirSync(root, { recursive: true });
    nodeFs.writeFileSync(
      join(root, "hush.yaml"),
      "version: 2\nsources:\n  shared: .env\ntargets:\n  - name: root\n    path: .\n    format: dotenv\n",
      "utf-8",
    );
    nodeFs.writeFileSync(join(root, ".env.encrypted"), "HELLO=world\n", "utf-8");

    const ctx = createContext(root);
    await expect(
      runCommand(ctx, {
        store: createStore(root),
        cwd: root,
        env: "development",
        command: ["echo", "hello"],
      }),
    ).rejects.toThrow("Process exit: 1");

    expect(ctx.exec.spawnSync).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /requires a v3 repository|Bootstrap or migrate before using this command/i,
      ),
    );
  });

  it("rejects json mode with one structured stderr document before starting a child", async () => {
    const root = join(TEST_DIR, "json-mode");
    const ctx = createContext(root);

    await expect(
      runCommand(ctx, {
        store: createStore(root),
        cwd: root,
        command: ["echo", "synthetic"],
        json: true,
      }),
    ).rejects.toThrow("Process exit: 2");

    expect(ctx.logger.log).not.toHaveBeenCalled();
    expect(ctx.exec.spawnSync).not.toHaveBeenCalled();
    const errorLogger = ctx.logger.error as ReturnType<typeof vi.fn>;
    const payload = JSON.parse(String(errorLogger.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      version: 1,
      ok: false,
      command: "run",
      error: { code: "UNSUPPORTED_MACHINE_MODE" },
    });
  });
});

// Regression coverage for the 2026-08-01 "preserve repository node pin"
// feature (`findPinnedNodeBin`), which shipped with no test coverage and
// broke folio-db's staging deploy for ~5 days: an exact `.nvmrc` patch pin
// (e.g. "24.18.0") stopped matching once the shared floating CI runner image
// picked up a newer upstream Node patch, and `hush run` refused to launch
// with no fallback. Fixed by letting the `.nvmrc` value's own specificity set
// the match granularity (nvm/fnm semantics), instead of always demanding an
// exact major.minor.patch.
describe("Node version pin parsing (.nvmrc)", () => {
  it("parses a bare major as a floating spec", () => {
    expect(parseNodeVersionSpec("24")).toEqual({
      raw: "24",
      major: 24,
      minor: null,
      patch: null,
    });
  });

  it("parses major.minor as a floating-patch spec", () => {
    expect(parseNodeVersionSpec("24.19")).toEqual({
      raw: "24.19",
      major: 24,
      minor: 19,
      patch: null,
    });
  });

  it("parses a full major.minor.patch as an exact spec, with or without a leading v", () => {
    expect(parseNodeVersionSpec("24.19.0")).toEqual({
      raw: "24.19.0",
      major: 24,
      minor: 19,
      patch: 0,
    });
    expect(parseNodeVersionSpec("v24.19.0")).toMatchObject({ major: 24, minor: 19, patch: 0 });
  });

  it("rejects garbage and empty pins the same way as before", () => {
    expect(() => parseNodeVersionSpec("latest")).toThrow(/Invalid \.nvmrc Node version/);
    expect(() => parseNodeVersionSpec("")).toThrow(/Invalid \.nvmrc Node version: \(empty\)/);
  });
});

describe("Node version matching against an installed Node (.nvmrc)", () => {
  const installed = { major: 24, minor: 19, patch: 3 };

  it("a bare-major spec matches any minor/patch of that major (the fleet-wide fix)", () => {
    expect(nodeVersionMatchesSpec(installed, parseNodeVersionSpec("24"))).toBe(true);
    expect(nodeVersionMatchesSpec(installed, parseNodeVersionSpec("25"))).toBe(false);
  });

  it("a major.minor spec matches any patch within that minor", () => {
    expect(nodeVersionMatchesSpec(installed, parseNodeVersionSpec("24.19"))).toBe(true);
    expect(nodeVersionMatchesSpec(installed, parseNodeVersionSpec("24.18"))).toBe(false);
  });

  it("a full triple still demands an exact patch match — reproducible pins are unchanged", () => {
    expect(nodeVersionMatchesSpec(installed, parseNodeVersionSpec("24.19.3"))).toBe(true);
    expect(nodeVersionMatchesSpec(installed, parseNodeVersionSpec("24.19.2"))).toBe(false);
    // This is exactly the folio-db incident: the runner drifted from 24.18.0
    // to 24.19.0+ and the exact pin no longer matched anything on PATH.
    expect(nodeVersionMatchesSpec(installed, parseNodeVersionSpec("24.18.0"))).toBe(false);
  });
});

describe("findPinnedNodeBin", () => {
  const PIN_TEST_DIR = join("/tmp", "hush-test-find-pinned-node-bin");

  function createPinTestContext(root: string, path: string): HushContext {
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
        spawnSync: vi.fn(),
        execSync: vi.fn(() => ""),
      },
      logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      process: {
        cwd: () => root,
        exit: ((code: number) => {
          throw new Error(`Process exit: ${code}`);
        }) as never,
        env: { PATH: path },
        stdin: {} as NodeJS.ReadStream,
        stdout: { write: vi.fn() } as unknown as NodeJS.WriteStream,
        on: vi.fn(),
        removeListener: vi.fn(),
      },
      config: { loadConfig: vi.fn(), findProjectRoot: vi.fn() },
      age: {
        ageAvailable: vi.fn(() => true),
        ageGenerate: vi.fn(),
        keyExists: vi.fn(() => false),
        keySave: vi.fn(),
        keyPath: vi.fn(() => ""),
        keyLoad: vi.fn(() => null),
        agePublicFromPrivate: vi.fn(() => ""),
      },
      sops: {
        decrypt: vi.fn(() => ""),
        decryptYaml: vi.fn(() => ""),
        encrypt: vi.fn(),
        encryptYaml: vi.fn(),
        encryptYamlContent: vi.fn(),
        edit: vi.fn(),
        isSopsInstalled: vi.fn(() => true),
      },
    };
  }

  // Writes a placeholder file standing in for a `node` binary at
  // <binDir>/node. spawnSync is mocked below, so the file is never executed —
  // its only job is to make ctx.fs.existsSync(node) true, matching how
  // findPinnedNodeBin decides a PATH entry is a candidate.
  function fakeNodeBin(binDir: string): string {
    nodeFs.mkdirSync(binDir, { recursive: true });
    nodeFs.writeFileSync(join(binDir, "node"), "#!/bin/sh\n", { mode: 0o755 });
    return binDir;
  }

  beforeEach(() => {
    nodeFs.rmSync(PIN_TEST_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(PIN_TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(PIN_TEST_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns null when the repo has no .nvmrc at all", () => {
    const root = join(PIN_TEST_DIR, "no-nvmrc");
    nodeFs.mkdirSync(root, { recursive: true });
    const ctx = createPinTestContext(root, "");
    expect(findPinnedNodeBin(ctx, root)).toBeNull();
  });

  it("a bare-major .nvmrc resolves against a Node patch that drifted past the old exact pin", () => {
    // This is the folio-db repair: instead of an exact "24.18.0" pin that a
    // floating runner image can drift past, the repo declares "24" — the
    // same floating precision its .mise.toml already used.
    const root = join(PIN_TEST_DIR, "floating-major");
    nodeFs.mkdirSync(root, { recursive: true });
    nodeFs.writeFileSync(join(root, ".nvmrc"), "24\n", "utf-8");

    const binDir = fakeNodeBin(join(PIN_TEST_DIR, "bin-24-19-0"));
    const ctx = createPinTestContext(root, binDir);
    (ctx.exec.spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 0,
      stdout: "v24.19.0\n",
      stderr: "",
    });

    expect(findPinnedNodeBin(ctx, root)).toBe(binDir);
  });

  it("an exact-triple .nvmrc still refuses a drifted patch with no fallback (unchanged behavior)", () => {
    const root = join(PIN_TEST_DIR, "exact-pin-drifted");
    nodeFs.mkdirSync(root, { recursive: true });
    nodeFs.writeFileSync(join(root, ".nvmrc"), "24.18.0\n", "utf-8");

    const binDir = fakeNodeBin(join(PIN_TEST_DIR, "bin-24-19-0-b"));
    const ctx = createPinTestContext(root, binDir);
    (ctx.exec.spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 0,
      stdout: "v24.19.0\n",
      stderr: "",
    });

    expect(() => findPinnedNodeBin(ctx, root)).toThrow(
      /No Node matching \.nvmrc pin "24\.18\.0" was found/,
    );
  });

  it("an exact-triple .nvmrc matches when the exact patch is present on PATH", () => {
    const root = join(PIN_TEST_DIR, "exact-pin-present");
    nodeFs.mkdirSync(root, { recursive: true });
    nodeFs.writeFileSync(join(root, ".nvmrc"), "24.19.0\n", "utf-8");

    const binDir = fakeNodeBin(join(PIN_TEST_DIR, "bin-24-19-0-c"));
    const ctx = createPinTestContext(root, binDir);
    (ctx.exec.spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 0,
      stdout: "v24.19.0\n",
      stderr: "",
    });

    expect(findPinnedNodeBin(ctx, root)).toBe(binDir);
  });

  it("a wrong major never matches, even floating (fails loud on a real mismatch)", () => {
    const root = join(PIN_TEST_DIR, "wrong-major");
    nodeFs.mkdirSync(root, { recursive: true });
    nodeFs.writeFileSync(join(root, ".nvmrc"), "20\n", "utf-8");

    const binDir = fakeNodeBin(join(PIN_TEST_DIR, "bin-24-19-0-d"));
    const ctx = createPinTestContext(root, binDir);
    (ctx.exec.spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 0,
      stdout: "v24.19.0\n",
      stderr: "",
    });

    expect(() => findPinnedNodeBin(ctx, root)).toThrow(/No Node matching \.nvmrc pin "20"/);
  });

  it("picks the matching candidate out of several PATH entries", () => {
    const root = join(PIN_TEST_DIR, "multi-candidate");
    nodeFs.mkdirSync(root, { recursive: true });
    nodeFs.writeFileSync(join(root, ".nvmrc"), "24.19\n", "utf-8");

    const wrongBin = fakeNodeBin(join(PIN_TEST_DIR, "bin-wrong"));
    const rightBin = fakeNodeBin(join(PIN_TEST_DIR, "bin-right"));
    const ctx = createPinTestContext(root, [wrongBin, rightBin].join(delimiter));
    (ctx.exec.spawnSync as ReturnType<typeof vi.fn>).mockImplementation((command: string) => {
      if (command === join(wrongBin, "node")) {
        return { status: 0, stdout: "v20.11.0\n", stderr: "" };
      }
      return { status: 0, stdout: "v24.19.7\n", stderr: "" };
    });

    expect(findPinnedNodeBin(ctx, root)).toBe(rightBin);
  });
});
