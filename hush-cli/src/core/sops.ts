import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { findProjectRoot } from "../config/loader.js";
import { findKeysByPublicKey, keyExists, keyPath, type AgeKeyReference } from "../lib/age.js";
import { fs } from "../lib/fs.js";
import { missingBinaryError } from "../lib/install-hints.js";
import { getProjectIdentifier } from "../project.js";

interface SopsOptions {
  root?: string;
  keyIdentity?: string;
}

type SopsFileFormat = "dotenv" | "yaml";

export interface ResolvedAgeKeySource {
  projectRoot?: string;
  detectedProjectIdentifier?: string;
  resolvedKeyIdentity?: string;
  selectedKeySource?: string;
  selectedKeyPath?: string;
  attemptedKeyPaths: string[];
}

export class SopsRecipientReadError extends Error {
  readonly code = "SOPS_RECIPIENT_READ_FAILED";

  constructor(
    readonly filePath: string,
    reason: string,
  ) {
    super(`Cannot determine age recipients for "${filePath}": ${reason}`);
    this.name = "SopsRecipientReadError";
  }
}

/**
 * Read the age recipients a sops-encrypted file is actually wrapped to, straight
 * from its own unencrypted `sops:` footer -- no decrypt, no `.sops.yaml` lookup.
 * This is ground truth for "who can decrypt this file right now": `.sops.yaml`
 * only governs FUTURE encrypts, and a file that was never `sops updatekeys`'d
 * after a `.sops.yaml` change still carries whatever recipient list it had at
 * its last encrypt.
 *
 * Throws rather than returning an empty list on any failure to read: a caller
 * comparing this against declared readers must never treat "could not tell" as
 * "zero recipients" and fold that into a silent pass or a misleading fail --
 * an unestablished comparison must throw, never read as agreement.
 */
export function readEncryptedFileRecipients(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    throw new SopsRecipientReadError(filePath, "file does not exist");
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8") as string;
  } catch (error) {
    throw new SopsRecipientReadError(filePath, `could not read file: ${(error as Error).message}`);
  }

  const recipients = [
    ...new Set([...content.matchAll(/recipient:\s*(age1[a-z0-9]+)/g)].map((match) => match[1]!)),
  ].sort();

  if (recipients.length === 0) {
    throw new SopsRecipientReadError(
      filePath,
      "no age recipients found in its sops footer; file may be corrupt or not sops-encrypted",
    );
  }

  return recipients;
}

function getSopsConfigRecipients(options?: SopsOptions): string[] {
  const configPath = getSopsConfigFile(options);
  if (!configPath) {
    return [];
  }

  try {
    const configContent = fs.readFileSync(configPath, "utf-8") as string;
    return [...configContent.matchAll(/age:\s*([^\n]+)/g)].flatMap(
      (match) => (match[1] ?? "").match(/age1[a-z0-9]+/g) ?? [],
    );
  } catch {
    return [];
  }
}

function resolveMatchingProjectKey(options?: SopsOptions): {
  match?: AgeKeyReference;
  ambiguous?: AgeKeyReference[];
} {
  const candidates = uniquePaths(getSopsConfigRecipients(options)).flatMap((recipient) =>
    findKeysByPublicKey(recipient),
  );
  const uniqueMatches = new Map(
    candidates.map((candidate) => [`${candidate.project}:${candidate.path}`, candidate]),
  );
  const matches = [...uniqueMatches.values()];

  if (matches.length <= 1) {
    return { match: matches[0] };
  }

  return { ambiguous: matches };
}

function getStandardSopsAgeKeyFile(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "sops", "age", "keys.txt");
  }

  const configRoot = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configRoot, "sops", "age", "keys.txt");
}

function getCompatConfigSopsAgeKeyFile(): string {
  return join(homedir(), ".config", "sops", "age", "keys.txt");
}

function getLegacySopsAgeKeyFile(): string {
  return join(homedir(), ".config", "sops", "age", "key.txt");
}

function getSopsConfigFile(options?: SopsOptions): string | undefined {
  if (!options?.root) {
    return undefined;
  }

  const configPath = join(options.root, ".sops.yaml");
  return fs.existsSync(configPath) ? configPath : undefined;
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}

function formatKeyPathForDisplay(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? path.replace(home, "~") : path;
}

export function resolveAgeKeySource(options?: SopsOptions): ResolvedAgeKeySource {
  const explicitKeyFile = process.env.SOPS_AGE_KEY_FILE;
  if (explicitKeyFile) {
    return {
      selectedKeySource: "env:SOPS_AGE_KEY_FILE",
      selectedKeyPath: explicitKeyFile,
      attemptedKeyPaths: [explicitKeyFile],
    };
  }

  if (process.env.SOPS_AGE_KEY_CMD) {
    return {
      selectedKeySource: "env:SOPS_AGE_KEY_CMD",
      attemptedKeyPaths: [],
    };
  }

  if (process.env.SOPS_AGE_KEY) {
    return {
      selectedKeySource: "env:SOPS_AGE_KEY",
      attemptedKeyPaths: [],
    };
  }

  const projectRoot = options?.root ?? findProjectRoot(process.cwd())?.projectRoot;
  const detectedProjectIdentifier = projectRoot ? getProjectIdentifier(projectRoot) : undefined;
  const resolvedKeyIdentity = options?.keyIdentity ?? detectedProjectIdentifier;
  const projectKeyPath = resolvedKeyIdentity ? keyPath(resolvedKeyIdentity) : undefined;
  const { match: matchedLocalKey, ambiguous: ambiguousLocalKeys } = resolveMatchingProjectKey({
    ...options,
    root: projectRoot,
  });
  const standardKeyPath = getStandardSopsAgeKeyFile();
  const compatConfigKeyPath = getCompatConfigSopsAgeKeyFile();
  const legacyKeyPath = getLegacySopsAgeKeyFile();
  const attemptedKeyPaths = uniquePaths([
    projectKeyPath,
    matchedLocalKey?.path,
    ...(ambiguousLocalKeys?.map((candidate) => candidate.path) ?? []),
    standardKeyPath,
    compatConfigKeyPath,
    legacyKeyPath,
  ]);

  if (projectKeyPath && keyExists(resolvedKeyIdentity!)) {
    return {
      projectRoot,
      detectedProjectIdentifier,
      resolvedKeyIdentity,
      selectedKeySource: "project-key",
      selectedKeyPath: projectKeyPath,
      attemptedKeyPaths,
    };
  }

  if (ambiguousLocalKeys && ambiguousLocalKeys.length > 0) {
    return {
      projectRoot,
      detectedProjectIdentifier,
      resolvedKeyIdentity,
      selectedKeySource: "project-key-ambiguous",
      attemptedKeyPaths,
    };
  }

  if (matchedLocalKey) {
    return {
      projectRoot,
      detectedProjectIdentifier,
      resolvedKeyIdentity: matchedLocalKey.project,
      selectedKeySource: "project-key-match",
      selectedKeyPath: matchedLocalKey.path,
      attemptedKeyPaths,
    };
  }

  for (const defaultPath of [standardKeyPath, compatConfigKeyPath, legacyKeyPath]) {
    if (fs.existsSync(defaultPath)) {
      return {
        projectRoot,
        detectedProjectIdentifier,
        resolvedKeyIdentity,
        selectedKeySource:
          defaultPath === standardKeyPath
            ? "default-keyring"
            : defaultPath === compatConfigKeyPath
              ? "compat-keyring"
              : "legacy-default-keyring",
        selectedKeyPath: defaultPath,
        attemptedKeyPaths,
      };
    }
  }

  return {
    projectRoot,
    detectedProjectIdentifier,
    resolvedKeyIdentity,
    attemptedKeyPaths,
  };
}

function getAgeKeyFile(options?: SopsOptions): string | undefined {
  return resolveAgeKeySource(options).selectedKeyPath;
}

// sops runs its own "am I the latest release?" check that phones github.com.
// On a filtered/captive network (TCP 443 connects but the TLS handshake never
// completes) that check hangs FOREVER, wedging every hush operation that shells
// out to sops. SOPS_DISABLE_VERSION_CHECK=1 is honored by sops upstream and
// disables it. Inject it on EVERY sops invocation (not just the version
// preflight); respect a caller-provided value if present.
function baseSopsEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SOPS_DISABLE_VERSION_CHECK: process.env.SOPS_DISABLE_VERSION_CHECK ?? "1",
  };
}

function getSopsEnv(options?: SopsOptions): NodeJS.ProcessEnv {
  const env = baseSopsEnv();
  if (env.SOPS_AGE_KEY_FILE || env.SOPS_AGE_KEY_CMD || env.SOPS_AGE_KEY) {
    return env;
  }

  const ageKeyFile = getAgeKeyFile(options);
  if (ageKeyFile) {
    return { ...env, SOPS_AGE_KEY_FILE: ageKeyFile };
  }
  return env;
}

function buildDecryptionFailureMessage(
  errorOutput: string,
  resolution: ResolvedAgeKeySource,
): string {
  const lines = ["SOPS decryption failed: No matching age key found."];

  if (resolution.projectRoot) {
    lines.push(`Project root: ${resolution.projectRoot}`);
  }

  if (resolution.detectedProjectIdentifier) {
    lines.push(`Detected project identifier: ${resolution.detectedProjectIdentifier}`);
  }

  if (resolution.resolvedKeyIdentity) {
    lines.push(`Key identity: ${resolution.resolvedKeyIdentity}`);
  }

  if (resolution.selectedKeySource) {
    lines.push(`Selected key source: ${resolution.selectedKeySource}`);
  }

  if (resolution.selectedKeyPath) {
    lines.push(`Selected key path: ${formatKeyPathForDisplay(resolution.selectedKeyPath)}`);
  }

  if (resolution.attemptedKeyPaths.length > 0) {
    lines.push("Attempted key paths:");
    for (const path of resolution.attemptedKeyPaths) {
      lines.push(`  - ${formatKeyPathForDisplay(path)}`);
    }
  }

  lines.push(
    "You can also provide a key explicitly with SOPS_AGE_KEY_FILE, SOPS_AGE_KEY_CMD, or SOPS_AGE_KEY.",
  );

  const trimmedErrorOutput = errorOutput.trim();
  if (trimmedErrorOutput.length > 0) {
    lines.push("", "SOPS output:", trimmedErrorOutput);
  }

  return lines.join("\n");
}

// The `sops --version` preflight must never block a hush caller indefinitely.
// baseSopsEnv() already disables sops' network version check, but bound the call
// anyway as defense-in-depth against any other external stall.
export const DEFAULT_SOPS_PREFLIGHT_TIMEOUT_MS = 2000;

export const SOPS_PREFLIGHT_TIMEOUT_ENV = "HUSH_SOPS_PREFLIGHT_TIMEOUT_MS";

/**
 * Second-attempt budget, used ONLY after the fast budget above already timed
 * out. The fast budget stays tight so a genuine captive-portal hang is caught in
 * ~2s, but on its own it misreports plain process-start starvation as a network
 * hang: measured 2026-07-25 on ch5-laptop-m4 at load average 873 (several agent
 * lanes running), a cold `sops --version` WITH the network version check already
 * disabled took 1475 / 1908 / 2193 / 2638 / 6256 ms across five samples — so the
 * 2s budget failed roughly half the time for a reason that has nothing to do
 * with the network. An earlier measurement on the same box recorded 17.8s at
 * load ~490 during a full test-suite run. 20s covers both with headroom.
 *
 * This is a retry, not a widened window: the fast path is unchanged, a hung sops
 * still fails loud (bounded at fast + retry), and the load-induced false failure
 * — the actual cause — is removed rather than papered over.
 */
export const SOPS_PREFLIGHT_RETRY_TIMEOUT_MS = 20_000;

/**
 * The default budget stays deliberately tight: it exists to catch a real
 * captive-portal hang fast. A heavily loaded machine can still blow past it for
 * mundane reasons, which is what `SOPS_PREFLIGHT_RETRY_TIMEOUT_MS` absorbs; this
 * env override remains for callers that want a different fast budget outright.
 */
export function getSopsPreflightTimeoutMs(): number {
  const raw = process.env[SOPS_PREFLIGHT_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SOPS_PREFLIGHT_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${SOPS_PREFLIGHT_TIMEOUT_ENV}=${raw}: expected a positive integer number of milliseconds.`,
    );
  }

  return parsed;
}

export const SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV = "HUSH_SOPS_PREFLIGHT_RETRY_TIMEOUT_MS";

export function getSopsPreflightRetryTimeoutMs(): number {
  const raw = process.env[SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid ${SOPS_PREFLIGHT_RETRY_TIMEOUT_ENV}=${raw}: expected a positive integer number of milliseconds.`,
      );
    }
    return parsed;
  }

  // Never let the retry be tighter than the fast budget a caller asked for.
  return Math.max(SOPS_PREFLIGHT_RETRY_TIMEOUT_MS, getSopsPreflightTimeoutMs());
}

/**
 * Thrown when the `sops --version` preflight does not return within its budget,
 * on BOTH the fast attempt and the generous retry. Surviving both budgets means
 * sops is genuinely wedged rather than merely slow to start, so the usual cause
 * is sops blocking on a network call (its GitHub release check) behind a captive
 * portal or filtered TLS to github.com, where TCP connects but the handshake
 * never completes. Fail loud naming the cause instead of hanging forever or
 * masquerading as "not installed".
 */
export class SopsPreflightTimeoutError extends Error {
  readonly code = "SOPS_PREFLIGHT_TIMEOUT";

  constructor(
    readonly timeoutMs: number,
    readonly attempts: number = 1,
  ) {
    super(
      `sops preflight ("sops --version") did not return within ${timeoutMs}ms` +
        `${attempts > 1 ? ` on any of ${attempts} attempts` : ""}. ` +
        "This usually means sops is blocked on a network call (its GitHub update " +
        "check) behind a captive portal or filtered TLS to github.com. hush sets " +
        "SOPS_DISABLE_VERSION_CHECK=1 to prevent this; if it persists, check network " +
        "egress or reinstall/upgrade sops. On a heavily loaded machine sops can also " +
        `simply be slow to start: raise the budget with ${SOPS_PREFLIGHT_TIMEOUT_ENV}.`,
    );
    this.name = "SopsPreflightTimeoutError";
  }
}

/**
 * Cached only for a RUNNABLE sops. `isSopsInstalled()` guards every encrypt and
 * decrypt entry point, so the preflight is re-spawned once per decrypted file:
 * measured 2026-07-25 via a `--version`-vs-other witness stub, a `hush run` that
 * aborted early at target selection still spawned `sops --version` twice, and the
 * count scales with the number of files a command touches. Each one is a cold
 * process start competing for CPU on an already-loaded box, and each one can blow
 * the preflight budget on its own. sops cannot become un-runnable mid-process in
 * any way that matters (the real decrypt call would fail loud anyway), so a
 * proven-runnable sops is remembered; a failure is never cached.
 */
let sopsKnownRunnable = false;

/** Forget a cached preflight result. For tests and long-lived hosts. */
export function resetSopsPreflightCache(): void {
  sopsKnownRunnable = false;
}

function runSopsPreflight(timeoutMs: number): ReturnType<typeof spawnSync> {
  return spawnSync("sops", ["--version"], {
    stdio: "ignore",
    timeout: timeoutMs,
    env: baseSopsEnv(),
  });
}

function timedOut(result: ReturnType<typeof spawnSync>): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

export function isSopsInstalled(): boolean {
  if (sopsKnownRunnable) {
    return true;
  }

  const fastTimeoutMs = getSopsPreflightTimeoutMs();
  let result = runSopsPreflight(fastTimeoutMs);
  let attempts = 1;

  // A blown fast budget is ambiguous: wedged sops, or just a starved process
  // start. Retry once with a generous budget so only a genuinely wedged sops
  // fails — the fast path stays fast for everyone else.
  if (timedOut(result)) {
    const retryTimeoutMs = getSopsPreflightRetryTimeoutMs();
    result = runSopsPreflight(retryTimeoutMs);
    attempts = 2;

    if (timedOut(result)) {
      throw new SopsPreflightTimeoutError(retryTimeoutMs, attempts);
    }
  }

  // Any other spawn error (ENOENT, EACCES, ...) means sops is genuinely not runnable.
  if (result.error) {
    return false;
  }

  if (result.status === 0) {
    sopsKnownRunnable = true;
    return true;
  }

  return false;
}

export function isAgeKeyConfigured(): boolean {
  const resolution = resolveAgeKeySource();
  return Boolean(resolution.selectedKeySource || resolution.selectedKeyPath);
}

function decryptWithFormat(
  filePath: string,
  format: SopsFileFormat,
  options?: SopsOptions,
): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Encrypted file not found: ${filePath}`);
  }

  if (!isSopsInstalled()) {
    throw missingBinaryError("sops");
  }

  const result = spawnSync(
    "sops",
    ["--input-type", format, "--output-type", format, "--decrypt", filePath],
    {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: getSopsEnv(options),
    },
  );

  if (result.status !== 0) {
    const errorOutput = (result.stderr || result.stdout || "").toString();
    if (/no identity matched|failed to load age identities/i.test(errorOutput)) {
      throw new Error(buildDecryptionFailureMessage(errorOutput, resolveAgeKeySource(options)));
    }
    throw new Error(`SOPS decryption failed: ${errorOutput}`);
  }

  return result.stdout;
}

export function decrypt(filePath: string, options?: SopsOptions): string {
  return decryptWithFormat(filePath, "dotenv", options);
}

export function decryptYaml(filePath: string, options?: SopsOptions): string {
  return decryptWithFormat(filePath, "yaml", options);
}

function encryptWithFormat(
  inputPath: string,
  outputPath: string,
  format: SopsFileFormat,
  options?: SopsOptions,
): void {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  if (!isSopsInstalled()) {
    throw missingBinaryError("sops");
  }

  try {
    const configPath = getSopsConfigFile(options);
    const args = [
      "--input-type",
      format,
      "--output-type",
      format,
      "--encrypt",
      "--filename-override",
      outputPath,
      ...(configPath ? ["--config", configPath] : []),
      inputPath,
    ];
    const result = spawnSync("sops", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: getSopsEnv(options),
    });
    if (result.status !== 0) {
      throw { stderr: result.stderr || result.stdout || `exit code ${result.status}` };
    }
    const encrypted = result.stdout;
    writeFileSync(outputPath, encrypted, "utf-8");
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(`SOPS encryption failed: ${err.stderr || err.message}`, { cause: error });
  }
}

export function encrypt(inputPath: string, outputPath: string, options?: SopsOptions): void {
  encryptWithFormat(inputPath, outputPath, "dotenv", options);
}

export function encryptYaml(inputPath: string, outputPath: string, options?: SopsOptions): void {
  encryptWithFormat(inputPath, outputPath, "yaml", options);
}

export function withPrivatePlaintextTempFile<T>(
  format: SopsFileFormat,
  content: string,
  action: (tempFilePath: string) => T,
): T {
  const extension = format === "yaml" ? "yaml" : "env";
  const tempDir = mkdtempSync(join(tmpdir(), "hush-sops-"));
  const tempFile = join(tempDir, `staged.${extension}`);

  try {
    chmodSync(tempDir, 0o700);
    writeFileSync(tempFile, content, { encoding: "utf-8", mode: 0o600 });
    return action(tempFile);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeEncryptedContent(
  content: string,
  outputPath: string,
  format: SopsFileFormat,
  options?: SopsOptions,
): void {
  withPrivatePlaintextTempFile(format, content, (tempFile) => {
    encryptWithFormat(tempFile, outputPath, format, options);
  });
}

export function encryptYamlContent(
  content: string,
  outputPath: string,
  options?: SopsOptions,
): void {
  writeEncryptedContent(content, outputPath, "yaml", options);
}

export function edit(filePath: string, options?: SopsOptions): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Encrypted file not found: ${filePath}`);
  }

  if (!isSopsInstalled()) {
    throw missingBinaryError("sops");
  }

  const configPath = getSopsConfigFile(options);
  const configArgs = configPath ? ["--config", configPath] : [];

  const result = spawnSync(
    "sops",
    [...configArgs, "--input-type", "dotenv", "--output-type", "dotenv", filePath],
    {
      stdio: "inherit",
      env: getSopsEnv(options),
    },
  );

  if (result.status !== 0) {
    throw new Error(`SOPS edit failed with exit code ${result.status}`);
  }
}

export function setKey(filePath: string, key: string, value: string, options?: SopsOptions): void {
  if (!isSopsInstalled()) {
    throw missingBinaryError("sops");
  }

  let content = "";

  if (fs.existsSync(filePath)) {
    content = decrypt(filePath, options);
  }

  const lines = content.split("\n").filter((line) => line.trim() !== "");

  let found = false;
  const updatedLines = lines.map((line) => {
    const match = line.match(/^([^=]+)=/);
    if (match && match[1] === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    updatedLines.push(`${key}=${value}`);
  }

  const newContent = updatedLines.join("\n") + "\n";

  withPrivatePlaintextTempFile("dotenv", newContent, (tempFile) => {
    const configPath = getSopsConfigFile(options);
    const args = [
      "--input-type",
      "dotenv",
      "--output-type",
      "dotenv",
      "--encrypt",
      "--filename-override",
      filePath,
      ...(configPath ? ["--config", configPath] : []),
      tempFile,
    ];
    const result = spawnSync("sops", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: getSopsEnv(options),
    });
    if (result.status !== 0) {
      throw new Error(
        `SOPS encryption failed: ${result.stderr || result.stdout || `exit code ${result.status}`}`,
      );
    }
    writeFileSync(filePath, result.stdout, "utf-8");
  });
}
