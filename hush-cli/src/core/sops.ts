import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { missingBinaryError } from '../lib/install-hints.js';
import { fs } from '../lib/fs.js';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { findKeysByPublicKey, keyExists, keyPath, type AgeKeyReference } from '../lib/age.js';
import { findProjectRoot } from '../config/loader.js';
import { getProjectIdentifier } from '../project.js';

interface SopsOptions {
  root?: string;
  keyIdentity?: string;
}

type SopsFileFormat = 'dotenv' | 'yaml';

export interface ResolvedAgeKeySource {
  projectRoot?: string;
  detectedProjectIdentifier?: string;
  resolvedKeyIdentity?: string;
  selectedKeySource?: string;
  selectedKeyPath?: string;
  attemptedKeyPaths: string[];
}

function getSopsConfigRecipients(options?: SopsOptions): string[] {
  const configPath = getSopsConfigFile(options);
  if (!configPath) {
    return [];
  }

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8') as string;
    return [...configContent.matchAll(/age:\s*([^\n]+)/g)]
      .flatMap((match) => (match[1] ?? '').match(/age1[a-z0-9]+/g) ?? []);
  } catch {
    return [];
  }
}

function resolveMatchingProjectKey(options?: SopsOptions): { match?: AgeKeyReference; ambiguous?: AgeKeyReference[] } {
  const candidates = uniquePaths(getSopsConfigRecipients(options)).flatMap((recipient) => findKeysByPublicKey(recipient));
  const uniqueMatches = new Map(candidates.map((candidate) => [`${candidate.project}:${candidate.path}`, candidate]));
  const matches = [...uniqueMatches.values()];

  if (matches.length <= 1) {
    return { match: matches[0] };
  }

  return { ambiguous: matches };
}

function getStandardSopsAgeKeyFile(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'sops', 'age', 'keys.txt');
  }

  const configRoot = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configRoot, 'sops', 'age', 'keys.txt');
}

function getCompatConfigSopsAgeKeyFile(): string {
  return join(homedir(), '.config', 'sops', 'age', 'keys.txt');
}

function getLegacySopsAgeKeyFile(): string {
  return join(homedir(), '.config', 'sops', 'age', 'key.txt');
}

function getSopsConfigFile(options?: SopsOptions): string | undefined {
  if (!options?.root) {
    return undefined;
  }

  const configPath = join(options.root, '.sops.yaml');
  return fs.existsSync(configPath) ? configPath : undefined;
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}

function formatKeyPathForDisplay(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? path.replace(home, '~') : path;
}

export function resolveAgeKeySource(options?: SopsOptions): ResolvedAgeKeySource {
  const explicitKeyFile = process.env.SOPS_AGE_KEY_FILE;
  if (explicitKeyFile) {
    return {
      selectedKeySource: 'env:SOPS_AGE_KEY_FILE',
      selectedKeyPath: explicitKeyFile,
      attemptedKeyPaths: [explicitKeyFile],
    };
  }

  if (process.env.SOPS_AGE_KEY_CMD) {
    return {
      selectedKeySource: 'env:SOPS_AGE_KEY_CMD',
      attemptedKeyPaths: [],
    };
  }

  if (process.env.SOPS_AGE_KEY) {
    return {
      selectedKeySource: 'env:SOPS_AGE_KEY',
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
      selectedKeySource: 'project-key',
      selectedKeyPath: projectKeyPath,
      attemptedKeyPaths,
    };
  }

  if (ambiguousLocalKeys && ambiguousLocalKeys.length > 0) {
    return {
      projectRoot,
      detectedProjectIdentifier,
      resolvedKeyIdentity,
      selectedKeySource: 'project-key-ambiguous',
      attemptedKeyPaths,
    };
  }

  if (matchedLocalKey) {
    return {
      projectRoot,
      detectedProjectIdentifier,
      resolvedKeyIdentity: matchedLocalKey.project,
      selectedKeySource: 'project-key-match',
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
        selectedKeySource: defaultPath === standardKeyPath
          ? 'default-keyring'
          : defaultPath === compatConfigKeyPath
            ? 'compat-keyring'
            : 'legacy-default-keyring',
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
    SOPS_DISABLE_VERSION_CHECK: process.env.SOPS_DISABLE_VERSION_CHECK ?? '1',
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

function buildDecryptionFailureMessage(errorOutput: string, resolution: ResolvedAgeKeySource): string {
  const lines = ['SOPS decryption failed: No matching age key found.'];

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
    lines.push('Attempted key paths:');
    for (const path of resolution.attemptedKeyPaths) {
      lines.push(`  - ${formatKeyPathForDisplay(path)}`);
    }
  }

  lines.push('You can also provide a key explicitly with SOPS_AGE_KEY_FILE, SOPS_AGE_KEY_CMD, or SOPS_AGE_KEY.');

  const trimmedErrorOutput = errorOutput.trim();
  if (trimmedErrorOutput.length > 0) {
    lines.push('', 'SOPS output:', trimmedErrorOutput);
  }

  return lines.join('\n');
}

// The `sops --version` preflight must never block a hush caller indefinitely.
// baseSopsEnv() already disables sops' network version check, but bound the call
// anyway as defense-in-depth against any other external stall.
export const DEFAULT_SOPS_PREFLIGHT_TIMEOUT_MS = 2000;

export const SOPS_PREFLIGHT_TIMEOUT_ENV = 'HUSH_SOPS_PREFLIGHT_TIMEOUT_MS';

/**
 * The default budget stays deliberately tight: it exists to catch a real
 * captive-portal hang fast. A heavily loaded machine can still blow past it for
 * mundane reasons (a cold `sops --version` measured at 17.8s wall under load
 * average ~490 while running the test suite), so the budget is an explicit
 * opt-in env override rather than a raised default.
 */
export function getSopsPreflightTimeoutMs(): number {
  const raw = process.env[SOPS_PREFLIGHT_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_SOPS_PREFLIGHT_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${SOPS_PREFLIGHT_TIMEOUT_ENV}=${raw}: expected a positive integer number of milliseconds.`
    );
  }

  return parsed;
}

/**
 * Thrown when the `sops --version` preflight does not return within its budget.
 * The usual cause is sops blocking on a network call (its GitHub release check)
 * behind a captive portal or filtered TLS to github.com, where TCP connects but
 * the handshake never completes. Fail loud naming the cause instead of hanging
 * forever or masquerading as "not installed".
 */
export class SopsPreflightTimeoutError extends Error {
  readonly code = 'SOPS_PREFLIGHT_TIMEOUT';

  constructor(readonly timeoutMs: number) {
    super(
      `sops preflight ("sops --version") did not return within ${timeoutMs}ms. ` +
        'This usually means sops is blocked on a network call (its GitHub update ' +
        'check) behind a captive portal or filtered TLS to github.com. hush sets ' +
        'SOPS_DISABLE_VERSION_CHECK=1 to prevent this; if it persists, check network ' +
        'egress or reinstall/upgrade sops. On a heavily loaded machine sops can also ' +
        `simply be slow to start: raise the budget with ${SOPS_PREFLIGHT_TIMEOUT_ENV}.`
    );
    this.name = 'SopsPreflightTimeoutError';
  }
}

export function isSopsInstalled(): boolean {
  const timeoutMs = getSopsPreflightTimeoutMs();
  const result = spawnSync('sops', ['--version'], {
    stdio: 'ignore',
    timeout: timeoutMs,
    env: baseSopsEnv(),
  });

  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new SopsPreflightTimeoutError(timeoutMs);
  }

  // Any other spawn error (ENOENT, EACCES, ...) means sops is genuinely not runnable.
  if (result.error) {
    return false;
  }

  return result.status === 0;
}

export function isAgeKeyConfigured(): boolean {
  const resolution = resolveAgeKeySource();
  return Boolean(resolution.selectedKeySource || resolution.selectedKeyPath);
}

function decryptWithFormat(filePath: string, format: SopsFileFormat, options?: SopsOptions): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Encrypted file not found: ${filePath}`);
  }

  if (!isSopsInstalled()) {
    throw missingBinaryError('sops');
  }

  const result = spawnSync(
    'sops',
    ['--input-type', format, '--output-type', format, '--decrypt', filePath],
    {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: getSopsEnv(options),
    }
  );

  if (result.status !== 0) {
    const errorOutput = (result.stderr || result.stdout || '').toString();
    if (/no identity matched|failed to load age identities/i.test(errorOutput)) {
      throw new Error(buildDecryptionFailureMessage(errorOutput, resolveAgeKeySource(options)));
    }
    throw new Error(`SOPS decryption failed: ${errorOutput}`);
  }

  return result.stdout;
}

export function decrypt(filePath: string, options?: SopsOptions): string {
  return decryptWithFormat(filePath, 'dotenv', options);
}

export function decryptYaml(filePath: string, options?: SopsOptions): string {
  return decryptWithFormat(filePath, 'yaml', options);
}

function encryptWithFormat(inputPath: string, outputPath: string, format: SopsFileFormat, options?: SopsOptions): void {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  if (!isSopsInstalled()) {
    throw missingBinaryError('sops');
  }

  try {
    const configPath = getSopsConfigFile(options);
    const args = [
      '--input-type', format,
      '--output-type', format,
      '--encrypt',
      '--filename-override', outputPath,
      ...(configPath ? ['--config', configPath] : []),
      inputPath,
    ];
    const result = spawnSync('sops', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: getSopsEnv(options),
    });
    if (result.status !== 0) {
      throw { stderr: result.stderr || result.stdout || `exit code ${result.status}` };
    }
    const encrypted = result.stdout;
    writeFileSync(outputPath, encrypted, 'utf-8');
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(`SOPS encryption failed: ${err.stderr || err.message}`);
  }
}

export function encrypt(inputPath: string, outputPath: string, options?: SopsOptions): void {
  encryptWithFormat(inputPath, outputPath, 'dotenv', options);
}

export function encryptYaml(inputPath: string, outputPath: string, options?: SopsOptions): void {
  encryptWithFormat(inputPath, outputPath, 'yaml', options);
}

export function withPrivatePlaintextTempFile<T>(format: SopsFileFormat, content: string, action: (tempFilePath: string) => T): T {
  const extension = format === 'yaml' ? 'yaml' : 'env';
  const tempDir = mkdtempSync(join(tmpdir(), 'hush-sops-'));
  const tempFile = join(tempDir, `staged.${extension}`);

  try {
    chmodSync(tempDir, 0o700);
    writeFileSync(tempFile, content, { encoding: 'utf-8', mode: 0o600 });
    return action(tempFile);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeEncryptedContent(content: string, outputPath: string, format: SopsFileFormat, options?: SopsOptions): void {
  withPrivatePlaintextTempFile(format, content, (tempFile) => {
    encryptWithFormat(tempFile, outputPath, format, options);
  });
}

export function encryptYamlContent(content: string, outputPath: string, options?: SopsOptions): void {
  writeEncryptedContent(content, outputPath, 'yaml', options);
}

export function edit(filePath: string, options?: SopsOptions): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Encrypted file not found: ${filePath}`);
  }

  if (!isSopsInstalled()) {
    throw missingBinaryError('sops');
  }

  const configPath = getSopsConfigFile(options);
  const configArgs = configPath ? ['--config', configPath] : [];

  const result = spawnSync(
    'sops',
    [...configArgs, '--input-type', 'dotenv', '--output-type', 'dotenv', filePath],
    {
      stdio: 'inherit',
      env: getSopsEnv(options),
    }
  );

  if (result.status !== 0) {
    throw new Error(`SOPS edit failed with exit code ${result.status}`);
  }
}

export function setKey(filePath: string, key: string, value: string, options?: SopsOptions): void {
  if (!isSopsInstalled()) {
    throw missingBinaryError('sops');
  }

  let content = '';
  
  if (fs.existsSync(filePath)) {
    content = decrypt(filePath, options);
  }

  const lines = content.split('\n').filter(line => line.trim() !== '');
  
  let found = false;
  const updatedLines = lines.map(line => {
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

  const newContent = updatedLines.join('\n') + '\n';

  withPrivatePlaintextTempFile('dotenv', newContent, (tempFile) => {
    const configPath = getSopsConfigFile(options);
    const args = [
      '--input-type', 'dotenv',
      '--output-type', 'dotenv',
      '--encrypt',
      '--filename-override', filePath,
      ...(configPath ? ['--config', configPath] : []),
      tempFile,
    ];
    const result = spawnSync('sops', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: getSopsEnv(options),
    });
    if (result.status !== 0) {
      throw new Error(`SOPS encryption failed: ${result.stderr || result.stdout || `exit code ${result.status}`}`);
    }
    writeFileSync(filePath, result.stdout, 'utf-8');
  });
}
