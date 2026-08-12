import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname } from "node:path";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decrypt,
  decryptYaml,
  DEFAULT_SOPS_PREFLIGHT_TIMEOUT_MS,
  encrypt,
  encryptYamlContent,
  getSopsPreflightRetryTimeoutMs,
  getSopsPreflightTimeoutMs,
  isSopsInstalled,
  resetSopsPreflightCache,
  resolveAgeKeySource,
  setKey,
  SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV,
  SOPS_PREFLIGHT_RETRY_TIMEOUT_MS,
  SOPS_PREFLIGHT_TIMEOUT_ENV,
  SopsPreflightTimeoutError,
  withPrivatePlaintextTempFile,
} from "../../src/core/sops.js";
import { ageGenerate } from "../../src/lib/age.js";
import {
  MACHINE_KEYRING_CANARY_RECIPIENT,
  TEST_AGE_PRIVATE_KEY,
  TEST_AGE_PUBLIC_KEY,
  ensureTestSopsConfig,
  ensureTestSopsEnv,
  generateThrowawayAgeRecipient,
} from "../helpers/sops-test.js";

describe("sops helpers", () => {
  let storeDir: string;
  let originalHome: string | undefined;
  let originalAgeKeyFile: string | undefined;
  let originalAgeKeyCmd: string | undefined;
  let originalAgeKey: string | undefined;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "hush-sops-test-"));
    originalHome = process.env.HOME;
    originalAgeKeyFile = process.env.SOPS_AGE_KEY_FILE;
    originalAgeKeyCmd = process.env.SOPS_AGE_KEY_CMD;
    originalAgeKey = process.env.SOPS_AGE_KEY;
    ensureTestSopsEnv();
    ensureTestSopsConfig(storeDir);
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalAgeKeyFile === undefined) {
      delete process.env.SOPS_AGE_KEY_FILE;
    } else {
      process.env.SOPS_AGE_KEY_FILE = originalAgeKeyFile;
    }

    if (originalAgeKeyCmd === undefined) {
      delete process.env.SOPS_AGE_KEY_CMD;
    } else {
      process.env.SOPS_AGE_KEY_CMD = originalAgeKeyCmd;
    }

    if (originalAgeKey === undefined) {
      delete process.env.SOPS_AGE_KEY;
    } else {
      process.env.SOPS_AGE_KEY = originalAgeKey;
    }

    rmSync(storeDir, { recursive: true, force: true });
  });

  function clearExplicitSopsAgeEnv(): void {
    delete process.env.SOPS_AGE_KEY_FILE;
    delete process.env.SOPS_AGE_KEY_CMD;
    delete process.env.SOPS_AGE_KEY;
  }

  function getStandardKeysPath(home: string): string {
    if (process.platform === "darwin") {
      return join(home, "Library", "Application Support", "sops", "age", "keys.txt");
    }

    return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "sops", "age", "keys.txt");
  }

  function getCompatKeysPath(home: string): string {
    return join(home, ".config", "sops", "age", "keys.txt");
  }

  function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  it("encrypts and decrypts dotenv content with the repo-local .sops.yaml", () => {
    const inputPath = join(storeDir, ".hush");
    const outputPath = join(storeDir, ".hush.encrypted");

    writeFileSync(inputPath, "API_KEY=value\n", "utf-8");

    encrypt(inputPath, outputPath, {
      root: storeDir,
      keyIdentity: "hush-global",
    });

    const encryptedContent = readFileSync(outputPath, "utf-8");
    expect(encryptedContent).toContain("sops_version=");
    expect(encryptedContent).not.toContain("API_KEY=value");
    expect(decrypt(outputPath, { root: storeDir, keyIdentity: "hush-global" })).toContain(
      "API_KEY=value",
    );
  });

  it("re-encrypts updates through setKey", () => {
    const encryptedPath = join(storeDir, ".hush.encrypted");

    writeFileSync(join(storeDir, ".plain.env"), "EXISTING=1\n", "utf-8");
    encrypt(join(storeDir, ".plain.env"), encryptedPath, {
      root: storeDir,
      keyIdentity: "hush-global",
    });

    setKey(encryptedPath, "API_KEY", "secret-value", {
      root: storeDir,
      keyIdentity: "hush-global",
    });

    const encryptedContent = readFileSync(encryptedPath, "utf-8");
    expect(encryptedContent).not.toContain("secret-value");
    const decrypted = decrypt(encryptedPath, { root: storeDir, keyIdentity: "hush-global" });
    expect(decrypted).toContain("EXISTING=1");
    expect(decrypted).toContain("API_KEY=secret-value");
  });

  it("encrypts and decrypts yaml authority documents", () => {
    const manifestPath = join(storeDir, ".hush", "manifest.encrypted");
    mkdirSync(dirname(manifestPath), { recursive: true });

    encryptYamlContent("version: 3\nidentities:\n  dev:\n    roles: [owner]\n", manifestPath, {
      root: storeDir,
      keyIdentity: "hush-global",
    });

    const encryptedYaml = readFileSync(manifestPath, "utf-8");
    expect(encryptedYaml).toContain("sops:");
    // encrypted values must appear as ENC[...] ciphertext, not plaintext
    expect(encryptedYaml).toContain("ENC[AES256_GCM");
    expect(decryptYaml(manifestPath, { root: storeDir, keyIdentity: "hush-global" })).toContain(
      "version: 3",
    );
  });

  it("falls back to the standard SOPS age keyring", () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "hush-sops-home-"));
    const manifestPath = join(storeDir, ".hush", "manifest.encrypted");
    const standardKeyPath = getStandardKeysPath(isolatedHome);

    mkdirSync(dirname(manifestPath), { recursive: true });
    mkdirSync(dirname(standardKeyPath), { recursive: true });
    writeFileSync(standardKeyPath, `${TEST_AGE_PRIVATE_KEY}\n`, "utf-8");

    encryptYamlContent("version: 3\nidentities:\n  dev:\n    roles: [owner]\n", manifestPath, {
      root: storeDir,
      keyIdentity: "hush-global",
    });

    process.env.HOME = isolatedHome;
    clearExplicitSopsAgeEnv();

    expect(decryptYaml(manifestPath, { root: storeDir })).toContain("version: 3");
  });

  it("keeps compatibility with the legacy ~/.config/sops/age/key.txt fallback", () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "hush-sops-home-legacy-"));
    const manifestPath = join(storeDir, ".hush", "manifest.encrypted");
    const legacyKeyPath = join(isolatedHome, ".config", "sops", "age", "key.txt");

    mkdirSync(dirname(manifestPath), { recursive: true });
    mkdirSync(dirname(legacyKeyPath), { recursive: true });
    writeFileSync(legacyKeyPath, `${TEST_AGE_PRIVATE_KEY}\n`, "utf-8");

    encryptYamlContent("version: 3\nidentities:\n  dev:\n    roles: [owner]\n", manifestPath, {
      root: storeDir,
      keyIdentity: "hush-global",
    });

    process.env.HOME = isolatedHome;
    clearExplicitSopsAgeEnv();

    expect(decryptYaml(manifestPath, { root: storeDir })).toContain("version: 3");
  });

  it("reports the resolved identity and attempted key paths on decryption failure", () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "hush-sops-home-missing-"));
    const manifestPath = join(storeDir, ".hush", "manifest.encrypted");
    const missingProjectKeyPath = join(
      isolatedHome,
      ".config",
      "sops",
      "age",
      "keys",
      "missing-key-fixture.txt",
    ).replace(isolatedHome, "~");

    mkdirSync(dirname(manifestPath), { recursive: true });
    encryptYamlContent("version: 3\nidentities:\n  dev:\n    roles: [owner]\n", manifestPath, {
      root: storeDir,
      keyIdentity: "missing-key-fixture",
    });

    process.env.HOME = isolatedHome;
    clearExplicitSopsAgeEnv();

    const attemptedKeyPathPatterns = [
      missingProjectKeyPath,
      getStandardKeysPath(isolatedHome).replace(isolatedHome, "~"),
      getCompatKeysPath(isolatedHome).replace(isolatedHome, "~"),
      "~/.config/sops/age/key.txt",
    ]
      .filter((path, index, paths) => paths.indexOf(path) === index)
      .map(escapeRegex);

    expect(() =>
      decryptYaml(manifestPath, { root: storeDir, keyIdentity: "missing-key-fixture" }),
    ).toThrowError(
      new RegExp(
        [
          "Key identity: missing-key-fixture",
          "Attempted key paths:",
          ...attemptedKeyPathPatterns,
        ].join("[\\s\\S]*"),
      ),
    );
  });

  it("prefers a matching project key over an unrelated shared keyring when package metadata is absent", () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "hush-sops-home-project-match-"));
    const manifestPath = join(storeDir, ".hush", "manifest.encrypted");
    const standardKeyPath = getStandardKeysPath(isolatedHome);
    const projectKeyPath = join(isolatedHome, ".config", "sops", "age", "keys", "matrix.txt");

    mkdirSync(dirname(manifestPath), { recursive: true });
    mkdirSync(dirname(standardKeyPath), { recursive: true });
    mkdirSync(dirname(projectKeyPath), { recursive: true });
    writeFileSync(standardKeyPath, "# unrelated default keyring\n", "utf-8");
    writeFileSync(
      projectKeyPath,
      `# project: matrix\n# public key: ${TEST_AGE_PUBLIC_KEY}\n${TEST_AGE_PRIVATE_KEY}\n`,
      "utf-8",
    );

    encryptYamlContent("version: 3\nidentities:\n  dev:\n    roles: [owner]\n", manifestPath, {
      root: storeDir,
      keyIdentity: "matrix",
    });

    process.env.HOME = isolatedHome;
    clearExplicitSopsAgeEnv();

    const resolution = resolveAgeKeySource({ root: storeDir });
    expect(resolution.selectedKeySource).toBe("project-key-match");
    expect(resolution.selectedKeyPath).toBe(projectKeyPath);
    expect(decryptYaml(manifestPath, { root: storeDir })).toContain("version: 3");
  });

  it("matches any recipient listed in .sops.yaml, not just the first one", () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "hush-sops-home-multi-recipient-"));
    const manifestPath = join(storeDir, ".hush", "manifest.encrypted");
    const projectKeyPath = join(isolatedHome, ".config", "sops", "age", "keys", "matrix.txt");
    const firstRecipient = generateThrowawayAgeRecipient();

    mkdirSync(dirname(manifestPath), { recursive: true });
    mkdirSync(dirname(projectKeyPath), { recursive: true });
    writeFileSync(
      projectKeyPath,
      `# project: matrix\n# public key: ${TEST_AGE_PUBLIC_KEY}\n${TEST_AGE_PRIVATE_KEY}\n`,
      "utf-8",
    );
    writeFileSync(
      join(storeDir, ".sops.yaml"),
      `creation_rules:\n  - encrypted_regex: .*\n    age: ${firstRecipient},${TEST_AGE_PUBLIC_KEY}\n`,
      "utf-8",
    );

    encryptYamlContent("version: 3\nidentities:\n  dev:\n    roles: [owner]\n", manifestPath, {
      root: storeDir,
      keyIdentity: "matrix",
    });

    process.env.HOME = isolatedHome;
    clearExplicitSopsAgeEnv();

    const resolution = resolveAgeKeySource({ root: storeDir });
    expect(resolution.selectedKeySource).toBe("project-key-match");
    expect(resolution.selectedKeyPath).toBe(projectKeyPath);
  });

  // Guards the isolation in tests/setup/isolate-machine-keyring.ts: without it,
  // sops adds the developer's default keyring to the identities from
  // SOPS_AGE_KEY_FILE, and this decrypt succeeds on any box holding the canary's
  // private key — turning every "foreign recipient" assertion into a no-op.
  it.each([
    ["a recipient held on a developer machine", () => MACHINE_KEYRING_CANARY_RECIPIENT],
    ["a recipient nobody holds", generateThrowawayAgeRecipient],
  ])("refuses to decrypt a file encrypted only for %s", (_label, resolveRecipient) => {
    const foreignRecipient = resolveRecipient();
    const manifestPath = join(storeDir, ".hush", "manifest.encrypted");

    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(
      join(storeDir, ".sops.yaml"),
      `creation_rules:\n  - encrypted_regex: .*\n    age: ${foreignRecipient}\n`,
      "utf-8",
    );
    encryptYamlContent("version: 3\n", manifestPath, { root: storeDir });

    expect(() => decryptYaml(manifestPath, { root: storeDir })).toThrow(
      /identity did not match any of the recipients/i,
    );
  });

  // Positive control for the guard above, and the part of it that cannot rot:
  // it proves sops really does add the default keyring to SOPS_AGE_KEY_FILE
  // (so a "must fail" assertion is meaningful) and that the keyring the suite
  // reaches is the sandbox one. Fails on every machine if setupFiles is dropped.
  it("adds the sandboxed default keyring to the identity from SOPS_AGE_KEY_FILE", () => {
    const keyringPath = getStandardKeysPath(process.env.HOME ?? "");
    const keyringKey = ageGenerate();
    const manifestPath = join(storeDir, ".hush", "manifest.encrypted");

    expect(keyringPath.startsWith(tmpdir())).toBe(true);

    mkdirSync(dirname(keyringPath), { recursive: true });
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(
      join(storeDir, ".sops.yaml"),
      `creation_rules:\n  - encrypted_regex: .*\n    age: ${keyringKey.public}\n`,
      "utf-8",
    );

    try {
      writeFileSync(keyringPath, `${keyringKey.private}\n`, "utf-8");
      encryptYamlContent("version: 3\n", manifestPath, { root: storeDir });

      expect(decryptYaml(manifestPath, { root: storeDir })).toContain("version: 3");
    } finally {
      rmSync(keyringPath, { force: true });
    }
  });

  it("stages plaintext in a private temp dir with restrictive permissions and cleanup", () => {
    let observedTempFile = "";

    withPrivatePlaintextTempFile("yaml", "version: 3\n", (tempFile) => {
      observedTempFile = tempFile;
      const fileMode = statSync(tempFile).mode & 0o777;
      const dirMode = statSync(dirname(tempFile)).mode & 0o777;

      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    });

    expect(observedTempFile).toContain(`${tmpdir()}/hush-sops-`);
    expect(existsSync(observedTempFile)).toBe(false);
    expect(existsSync(dirname(observedTempFile))).toBe(false);
  });

  it("uses the private temp staging helper for setKey updates", () => {
    const encryptedPath = join(storeDir, ".hush.encrypted");

    writeFileSync(join(storeDir, ".plain.env"), "EXISTING=1\n", "utf-8");
    encrypt(join(storeDir, ".plain.env"), encryptedPath, {
      root: storeDir,
      keyIdentity: "hush-global",
    });

    setKey(encryptedPath, "API_KEY", "secret-value", {
      root: storeDir,
      keyIdentity: "hush-global",
    });

    const encryptedAfterSet = readFileSync(encryptedPath, "utf-8");
    expect(encryptedAfterSet).not.toContain("secret-value");
    const decrypted = decrypt(encryptedPath, { root: storeDir, keyIdentity: "hush-global" });
    expect(decrypted).toContain("EXISTING=1");
    expect(decrypted).toContain("API_KEY=secret-value");
  });
});

describe("isSopsInstalled preflight (no indefinite network hang)", () => {
  let fakeBinDir: string;
  let originalPath: string | undefined;
  let originalDisableCheck: string | undefined;
  let originalPreflightTimeout: string | undefined;
  let originalRetryTimeout: string | undefined;

  beforeEach(() => {
    fakeBinDir = mkdtempSync(join(tmpdir(), "hush-fake-sops-"));
    originalPath = process.env.PATH;
    originalDisableCheck = process.env.SOPS_DISABLE_VERSION_CHECK;
    originalPreflightTimeout = process.env[SOPS_PREFLIGHT_TIMEOUT_ENV];
    originalRetryTimeout = process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV];
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ""}`;
    // A cached "sops is runnable" from an earlier test would skip the fake sops.
    resetSopsPreflightCache();
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalDisableCheck === undefined) delete process.env.SOPS_DISABLE_VERSION_CHECK;
    else process.env.SOPS_DISABLE_VERSION_CHECK = originalDisableCheck;
    if (originalPreflightTimeout === undefined) delete process.env[SOPS_PREFLIGHT_TIMEOUT_ENV];
    else process.env[SOPS_PREFLIGHT_TIMEOUT_ENV] = originalPreflightTimeout;
    if (originalRetryTimeout === undefined) delete process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV];
    else process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV] = originalRetryTimeout;
    rmSync(fakeBinDir, { recursive: true, force: true });
    // Never leak a fake-sops verdict into the suites that use the real binary.
    resetSopsPreflightCache();
  });

  function installFakeSops(body: string): void {
    const path = join(fakeBinDir, "sops");
    writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf-8");
    chmodSync(path, 0o755);
  }

  it("fails loud with a typed, network-naming error instead of hanging forever when the preflight stalls", () => {
    // Emulates stock sops phoning github.com on a filtered network where the
    // TLS handshake never completes: `sops --version` blocks indefinitely.
    installFakeSops("sleep 30");
    // Assert against the shipped default, not the suite-wide loaded-machine budget.
    process.env[SOPS_PREFLIGHT_TIMEOUT_ENV] = String(DEFAULT_SOPS_PREFLIGHT_TIMEOUT_MS);
    // Keep the retry bounded here; the retry budget itself is asserted below.
    process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV] = "2000";

    const start = Date.now();
    let thrown: unknown;
    try {
      isSopsInstalled();
    } catch (error) {
      thrown = error;
    }
    const elapsedMs = Date.now() - start;

    expect(thrown).toBeInstanceOf(SopsPreflightTimeoutError);
    expect((thrown as SopsPreflightTimeoutError).code).toBe("SOPS_PREFLIGHT_TIMEOUT");
    expect((thrown as Error).message).toMatch(/github\.com/);
    // Bounded, not a 30s hang.
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);

  it("injects SOPS_DISABLE_VERSION_CHECK=1 into every sops invocation, even when absent from the ambient env", () => {
    delete process.env.SOPS_DISABLE_VERSION_CHECK;
    const witness = join(fakeBinDir, "seen-disable-check");
    installFakeSops(`printf '%s' "$SOPS_DISABLE_VERSION_CHECK" > '${witness}'\nexit 0`);

    expect(isSopsInstalled()).toBe(true);
    expect(readFileSync(witness, "utf-8")).toBe("1");
  });

  it("reports sops as not installed (without throwing) when the binary is genuinely missing", () => {
    // Empty fake bin dir on PATH + a PATH that cannot resolve `sops` → ENOENT.
    process.env.PATH = fakeBinDir;
    expect(isSopsInstalled()).toBe(false);
  });

  it("keeps the tight 2s default budget when no override is set", () => {
    delete process.env[SOPS_PREFLIGHT_TIMEOUT_ENV];
    expect(DEFAULT_SOPS_PREFLIGHT_TIMEOUT_MS).toBe(2000);
    expect(getSopsPreflightTimeoutMs()).toBe(2000);
  });

  it("honors an explicit budget override so loaded machines can wait out a slow sops", () => {
    // Slower than the override below, faster than the raised one.
    installFakeSops("sleep 1");

    process.env[SOPS_PREFLIGHT_TIMEOUT_ENV] = "200";
    process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV] = "200";
    let thrown: unknown;
    try {
      isSopsInstalled();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SopsPreflightTimeoutError);
    expect((thrown as SopsPreflightTimeoutError).timeoutMs).toBe(200);

    process.env[SOPS_PREFLIGHT_TIMEOUT_ENV] = "10000";
    expect(isSopsInstalled()).toBe(true);
  }, 20_000);

  it("rejects a non-positive or non-numeric budget override instead of silently defaulting", () => {
    for (const invalid of ["0", "-1", "abc", "1.5"]) {
      process.env[SOPS_PREFLIGHT_TIMEOUT_ENV] = invalid;
      expect(() => getSopsPreflightTimeoutMs()).toThrow(
        new RegExp(`Invalid ${SOPS_PREFLIGHT_TIMEOUT_ENV}=${invalid.replace(".", "\\.")}`),
      );
    }
  });

  it("rejects a non-positive or non-numeric retry budget override instead of silently defaulting", () => {
    for (const invalid of ["0", "-1", "abc", "1.5"]) {
      process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV] = invalid;
      expect(() => getSopsPreflightRetryTimeoutMs()).toThrow(
        new RegExp(`Invalid ${SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV}=${invalid.replace(".", "\\.")}`),
      );
    }
  });
});

/**
 * Regression guard for the 2026-07-25 ch5-laptop-m4 delivery failure: on a box at
 * load average 873, a cold `sops --version` with the network version check
 * already disabled took up to 6256ms, so the single 2s preflight budget failed
 * `ch5-managed-runtime ensure ch5-devtools` for hours while blaming github.com
 * egress. The fast budget must stay fast, but a blown fast budget must be
 * retried generously before anything is declared wedged, and a proven-runnable
 * sops must not be re-probed once per encrypt/decrypt entry point.
 */
describe("isSopsInstalled preflight (slow process start is not a network hang)", () => {
  let fakeBinDir: string;
  let originalPath: string | undefined;
  let originalPreflightTimeout: string | undefined;
  let originalRetryTimeout: string | undefined;

  beforeEach(() => {
    fakeBinDir = mkdtempSync(join(tmpdir(), "hush-slow-sops-"));
    originalPath = process.env.PATH;
    originalPreflightTimeout = process.env[SOPS_PREFLIGHT_TIMEOUT_ENV];
    originalRetryTimeout = process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV];
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ""}`;
    resetSopsPreflightCache();
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPreflightTimeout === undefined) delete process.env[SOPS_PREFLIGHT_TIMEOUT_ENV];
    else process.env[SOPS_PREFLIGHT_TIMEOUT_ENV] = originalPreflightTimeout;
    if (originalRetryTimeout === undefined) delete process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV];
    else process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV] = originalRetryTimeout;
    rmSync(fakeBinDir, { recursive: true, force: true });
    resetSopsPreflightCache();
  });

  function installFakeSops(body: string): void {
    const path = join(fakeBinDir, "sops");
    writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf-8");
    chmodSync(path, 0o755);
  }

  /**
   * Spawn counts are asserted only against fakes that exit immediately. A fake
   * that has to be killed for blowing a budget cannot be counted reliably: at
   * load average ~850 the stub shell was SIGKILLed before it reached its own
   * `printf`, so a counter file undercounts. Budget-blowing tests assert the
   * typed outcome and `attempts` instead, which the implementation reports
   * directly.
   */
  function invocations(counterPath: string): number {
    return existsSync(counterPath) ? readFileSync(counterPath, "utf-8").length : 0;
  }

  it("retries once with a generous budget instead of misreporting a slow sops as a network hang", () => {
    // A sops that simply takes 3s to answer: blows the fast budget, well inside
    // the retry budget. Before the retry existed this threw and broke delivery.
    installFakeSops('sleep 3\necho "sops 3.11.0"\nexit 0');
    process.env[SOPS_PREFLIGHT_TIMEOUT_ENV] = "300";
    process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV] = "20000";

    expect(isSopsInstalled()).toBe(true);
  }, 40_000);

  it("still fails loud, naming both attempts, when sops is genuinely wedged", () => {
    installFakeSops("sleep 30");
    process.env[SOPS_PREFLIGHT_TIMEOUT_ENV] = "300";
    process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV] = "600";

    const start = Date.now();
    let thrown: unknown;
    try {
      isSopsInstalled();
    } catch (error) {
      thrown = error;
    }
    const elapsedMs = Date.now() - start;

    expect(thrown).toBeInstanceOf(SopsPreflightTimeoutError);
    expect((thrown as SopsPreflightTimeoutError).attempts).toBe(2);
    expect((thrown as SopsPreflightTimeoutError).timeoutMs).toBe(600);
    expect((thrown as Error).message).toMatch(/2 attempts/);
    // Bounded by fast + retry, not a 30s hang.
    expect(elapsedMs).toBeLessThan(15_000);
  }, 40_000);

  it("spawns one preflight for a runnable sops no matter how many callers ask", () => {
    const counterPath = join(fakeBinDir, "invocations");
    installFakeSops(`printf 'x' >> '${counterPath}'\nexit 0`);

    // The guard is re-entered once per decrypted file; two spawns were measured
    // for a `hush run` that aborted early, and the count scales from there.
    for (let i = 0; i < 4; i += 1) {
      expect(isSopsInstalled()).toBe(true);
    }
    expect(invocations(counterPath)).toBe(1);
  });

  it("never caches a NOT-runnable sops, so a later install is picked up", () => {
    const counterPath = join(fakeBinDir, "invocations");
    installFakeSops(`printf 'x' >> '${counterPath}'\nexit 1`);

    expect(isSopsInstalled()).toBe(false);
    expect(isSopsInstalled()).toBe(false);
    expect(invocations(counterPath)).toBe(2);
  });

  it("keeps a retry budget generous enough for the measured worst-case cold start", () => {
    delete process.env[SOPS_PREFLIGHT_TIMEOUT_ENV];
    delete process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV];
    // Measured 2026-07-25 on ch5-laptop-m4: 6256ms at load average 873, and 17.8s
    // at load ~490 during a full suite run. Do not regress below that.
    expect(SOPS_PREFLIGHT_RETRY_TIMEOUT_MS).toBeGreaterThanOrEqual(18_000);
    expect(getSopsPreflightRetryTimeoutMs()).toBeGreaterThanOrEqual(18_000);
  });

  it("never lets the retry budget fall below an explicitly raised fast budget", () => {
    delete process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV];
    process.env[SOPS_PREFLIGHT_TIMEOUT_ENV] = "60000";
    expect(getSopsPreflightRetryTimeoutMs()).toBe(60_000);
  });
});
