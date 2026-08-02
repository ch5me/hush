import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  decrypt,
  decryptYaml,
  encryptYamlContent,
  SOPS_PREFLIGHT_TIMEOUT_ENV,
} from "../../src/core/sops.js";
import {
  createFileDocument,
  createFileIndexEntry,
  createManifestDocument,
} from "../../src/index.js";
import { ageGenerate } from "../../src/lib/age.js";
import type { HushManifestDocument } from "../../src/types.js";

export const TEST_AGE_PUBLIC_KEY = "age1k6085c7hu6xgwtp2w35kf224peecjjagvswzhgtgmh76gaxcppnq9rlkqx";
export const TEST_AGE_PRIVATE_KEY =
  "AGE-SECRET-KEY-1NRM2VW0WPL94YENWTCUNCSR0QNTFHLNZR0MHARQ2G5FL9PQW9TKQKV32PS";

/**
 * A real recipient whose private key is known to exist on at least one CH5
 * developer machine. Kept as a literal on purpose: a test that encrypts to it
 * and still decrypts proves the machine's age keyring leaked into the run.
 */
export const MACHINE_KEYRING_CANARY_RECIPIENT =
  "age1vacr4w7m3qje0px6gvglx4u6rxt2zrkxr572dth8fjz8666ydcesd3fcpf";

/**
 * A recipient whose private key is generated and immediately discarded, so no
 * machine can hold it. Use instead of a hardcoded "foreign" recipient.
 */
export function generateThrowawayAgeRecipient(): string {
  return ageGenerate().public;
}

const TEST_KEY_FILE = join(tmpdir(), "hush-test-age-key.txt");

export function ensureTestSopsEnv(): string {
  if (!nodeFs.existsSync(TEST_KEY_FILE)) {
    nodeFs.writeFileSync(TEST_KEY_FILE, `${TEST_AGE_PRIVATE_KEY}\n`, "utf-8");
  }

  process.env.SOPS_AGE_KEY_FILE = TEST_KEY_FILE;
  return TEST_KEY_FILE;
}

export function ensureTestSopsConfig(root: string): void {
  ensureTestSopsEnv();
  nodeFs.mkdirSync(root, { recursive: true });

  const configPath = join(root, ".sops.yaml");
  if (!nodeFs.existsSync(configPath)) {
    nodeFs.writeFileSync(
      configPath,
      stringifyYaml({
        creation_rules: [{ encrypted_regex: ".*", age: TEST_AGE_PUBLIC_KEY }],
      }),
      "utf-8",
    );
  }
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export function writeEncryptedYamlFile(root: string, filePath: string, content: string): void {
  ensureTestSopsConfig(root);
  nodeFs.mkdirSync(dirname(filePath), { recursive: true });
  encryptYamlContent(ensureTrailingNewline(content), filePath, { root });
}

export function writeEncryptedDotenvFile(root: string, filePath: string, content: string): void {
  ensureTestSopsConfig(root);
  nodeFs.mkdirSync(dirname(filePath), { recursive: true });
  const tempPlainPath = `${filePath}.plain`;

  try {
    nodeFs.writeFileSync(tempPlainPath, ensureTrailingNewline(content), "utf-8");
    const result = spawnSync(
      "sops",
      [
        "--input-type",
        "dotenv",
        "--output-type",
        "dotenv",
        "--encrypt",
        "--filename-override",
        filePath,
        "--config",
        join(root, ".sops.yaml"),
        tempPlainPath,
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, SOPS_AGE_KEY_FILE: TEST_KEY_FILE },
      },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `sops exited ${result.status}`);
    }
    nodeFs.writeFileSync(filePath, result.stdout, "utf-8");
  } finally {
    nodeFs.rmSync(tempPlainPath, { force: true });
  }
}

export function readDecryptedYamlFile(root: string, filePath: string): string {
  ensureTestSopsConfig(root);
  return decryptYaml(filePath, { root });
}

export function readDecryptedDotenvFile(root: string, filePath: string): string {
  ensureTestSopsConfig(root);
  return decrypt(filePath, { root });
}

/**
 * Thrown instead of writing content that is still SOPS ciphertext back over a
 * tracked fixture. Silently persisting it corrupts the checked-in fixture and
 * surfaces later as unrelated failures across the suite (e.g. `Invalid Hush
 * namespace "ENC[AES256_GCM,...]"`), whose only recovery — `git checkout --
 * hush-cli/tests/fixtures` — is undiscoverable from the error.
 */
export class FixtureNotDecryptedError extends Error {
  readonly code = "FIXTURE_NOT_DECRYPTED";

  constructor(
    readonly fixturePath: string,
    readonly decryptFailure?: string,
  ) {
    super(
      [
        `Refusing to write undecrypted content back to fixture: ${fixturePath}`,
        "The content still looks like SOPS ciphertext, so decryption did not actually happen.",
        "The usual cause is sops failing on this machine — e.g. SopsPreflightTimeoutError when the",
        '"sops --version" preflight blows its budget under heavy load; raise it with',
        `${SOPS_PREFLIGHT_TIMEOUT_ENV} — not a bad fixture.`,
        "If an earlier run already corrupted a fixture, restore it with:",
        "  git checkout -- hush-cli/tests/fixtures",
        ...(decryptFailure ? ["", `Decryption failure: ${decryptFailure}`] : []),
      ].join("\n"),
    );
    this.name = "FixtureNotDecryptedError";
  }
}

/** SOPS-encrypted YAML keeps a top-level `sops:` envelope and ENC[...] values. */
function looksLikeSopsCiphertext(content: string): boolean {
  return content.includes("ENC[AES256_GCM") || /^sops:\s*$/m.test(content);
}

function describeFailure(failure: unknown): string | undefined {
  if (failure === undefined) {
    return undefined;
  }

  return failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);
}

function assertDecryptedFixtureContent(
  fixturePath: string,
  content: string,
  failure?: unknown,
): string {
  if (looksLikeSopsCiphertext(content)) {
    throw new FixtureNotDecryptedError(fixturePath, describeFailure(failure));
  }

  return content;
}

export function ensureEncryptedFixtureRepo(root: string): void {
  ensureTestSopsConfig(root);

  const readYaml = (filePath: string): string => {
    let decryptFailure: unknown;

    try {
      const decrypted = decryptYaml(filePath, { root });
      if (!looksLikeSopsCiphertext(decrypted)) {
        return decrypted;
      }
      decryptFailure = new Error("sops exited 0 but returned ciphertext");
    } catch (error) {
      decryptFailure = error;
    }

    // A fixture may legitimately be checked in as plaintext awaiting first
    // encryption; anything that still reads as ciphertext is a failed decrypt.
    const raw = nodeFs.readFileSync(filePath, "utf-8");
    return assertDecryptedFixtureContent(filePath, raw, decryptFailure);
  };

  const manifestPath = join(root, ".hush", "manifest.encrypted");
  if (nodeFs.existsSync(manifestPath)) {
    try {
      const existingManifest = parseYaml(decryptYaml(manifestPath, { root })) as {
        fileIndex?: unknown;
      };
      if (existingManifest?.fileIndex && typeof existingManifest.fileIndex === "object") {
        return;
      }
    } catch {}

    const fileIndex: Record<string, ReturnType<typeof createFileIndexEntry>> = {};
    const queueForIndex = [join(root, ".hush", "files")];

    while (queueForIndex.length > 0) {
      const current = queueForIndex.shift()!;
      if (!nodeFs.existsSync(current)) {
        continue;
      }

      for (const entry of nodeFs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = join(current, entry.name);
        if (entry.isDirectory()) {
          queueForIndex.push(entryPath);
          continue;
        }

        if (!entry.name.endsWith(".encrypted")) {
          continue;
        }

        const content = readYaml(entryPath);
        const parsed = createFileDocument(parseYaml(content));
        fileIndex[parsed.path] = createFileIndexEntry(parsed);
      }
    }

    const manifestContent = readYaml(manifestPath);
    const manifest = createManifestDocument({
      ...(parseYaml(manifestContent) as Record<string, unknown>),
      fileIndex,
    } as HushManifestDocument);
    const serializedManifest = stringifyYaml(manifest, { indent: 2 });
    nodeFs.writeFileSync(
      manifestPath,
      assertDecryptedFixtureContent(manifestPath, serializedManifest),
      "utf-8",
    );
  }

  const queue = [join(root, ".hush")];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!nodeFs.existsSync(current)) {
      continue;
    }

    for (const entry of nodeFs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }

      if (!entry.name.endsWith(".encrypted")) {
        continue;
      }

      const raw = nodeFs.readFileSync(entryPath, "utf-8");
      if (raw.includes("\nsops:\n") || raw.includes("\nsops:")) {
        continue;
      }

      // No `sops:` envelope but ENC[...] values means a half-corrupted fixture:
      // re-encrypting it would entrench the ciphertext as plaintext.
      writeEncryptedYamlFile(root, entryPath, assertDecryptedFixtureContent(entryPath, raw));
    }
  }
}
