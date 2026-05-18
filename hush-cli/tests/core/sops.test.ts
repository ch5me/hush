import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decrypt, decryptYaml, encrypt, encryptYamlContent, resolveAgeKeySource, setKey, withPrivatePlaintextTempFile } from '../../src/core/sops.js';
import { TEST_AGE_PRIVATE_KEY, TEST_AGE_PUBLIC_KEY, ensureTestSopsConfig, ensureTestSopsEnv } from '../helpers/sops-test.js';

describe('sops helpers', () => {
  let storeDir: string;
  let originalHome: string | undefined;
  let originalAgeKeyFile: string | undefined;
  let originalAgeKeyCmd: string | undefined;
  let originalAgeKey: string | undefined;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'hush-sops-test-'));
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
    if (process.platform === 'darwin') {
      return join(home, 'Library', 'Application Support', 'sops', 'age', 'keys.txt');
    }

    return join(home, '.config', 'sops', 'age', 'keys.txt');
  }

  function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  it('encrypts and decrypts dotenv content with the repo-local .sops.yaml', () => {
    const inputPath = join(storeDir, '.hush');
    const outputPath = join(storeDir, '.hush.encrypted');

    writeFileSync(inputPath, 'API_KEY=value\n', 'utf-8');

    encrypt(inputPath, outputPath, {
      root: storeDir,
      keyIdentity: 'hush-global',
    });

    expect(readFileSync(outputPath, 'utf-8')).toContain('sops_version=');
    expect(decrypt(outputPath, { root: storeDir, keyIdentity: 'hush-global' })).toContain('API_KEY=value');
  });

  it('re-encrypts updates through setKey', () => {
    const encryptedPath = join(storeDir, '.hush.encrypted');

    writeFileSync(join(storeDir, '.plain.env'), 'EXISTING=1\n', 'utf-8');
    encrypt(join(storeDir, '.plain.env'), encryptedPath, {
      root: storeDir,
      keyIdentity: 'hush-global',
    });

    setKey(encryptedPath, 'API_KEY', 'secret-value', {
      root: storeDir,
      keyIdentity: 'hush-global',
    });

    const decrypted = decrypt(encryptedPath, { root: storeDir, keyIdentity: 'hush-global' });
    expect(decrypted).toContain('EXISTING=1');
    expect(decrypted).toContain('API_KEY=secret-value');
  });

  it('encrypts and decrypts yaml authority documents', () => {
    const manifestPath = join(storeDir, '.hush', 'manifest.encrypted');
    mkdirSync(dirname(manifestPath), { recursive: true });

    encryptYamlContent('version: 3\nidentities:\n  dev:\n    roles: [owner]\n', manifestPath, {
      root: storeDir,
      keyIdentity: 'hush-global',
    });

    expect(readFileSync(manifestPath, 'utf-8')).toContain('sops:');
    expect(decryptYaml(manifestPath, { root: storeDir, keyIdentity: 'hush-global' })).toContain('version: 3');
  });

  it('falls back to the standard SOPS age keyring', () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'hush-sops-home-'));
    const manifestPath = join(storeDir, '.hush', 'manifest.encrypted');
    const standardKeyPath = getStandardKeysPath(isolatedHome);

    mkdirSync(dirname(manifestPath), { recursive: true });
    mkdirSync(dirname(standardKeyPath), { recursive: true });
    writeFileSync(standardKeyPath, `${TEST_AGE_PRIVATE_KEY}\n`, 'utf-8');

    encryptYamlContent('version: 3\nidentities:\n  dev:\n    roles: [owner]\n', manifestPath, {
      root: storeDir,
      keyIdentity: 'hush-global',
    });

    process.env.HOME = isolatedHome;
    clearExplicitSopsAgeEnv();

    expect(decryptYaml(manifestPath, { root: storeDir })).toContain('version: 3');
  });

  it('keeps compatibility with the legacy ~/.config/sops/age/key.txt fallback', () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'hush-sops-home-legacy-'));
    const manifestPath = join(storeDir, '.hush', 'manifest.encrypted');
    const legacyKeyPath = join(isolatedHome, '.config', 'sops', 'age', 'key.txt');

    mkdirSync(dirname(manifestPath), { recursive: true });
    mkdirSync(dirname(legacyKeyPath), { recursive: true });
    writeFileSync(legacyKeyPath, `${TEST_AGE_PRIVATE_KEY}\n`, 'utf-8');

    encryptYamlContent('version: 3\nidentities:\n  dev:\n    roles: [owner]\n', manifestPath, {
      root: storeDir,
      keyIdentity: 'hush-global',
    });

    process.env.HOME = isolatedHome;
    clearExplicitSopsAgeEnv();

    expect(decryptYaml(manifestPath, { root: storeDir })).toContain('version: 3');
  });

  it('reports the resolved identity and attempted key paths on decryption failure', () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'hush-sops-home-missing-'));
    const manifestPath = join(storeDir, '.hush', 'manifest.encrypted');
    const standardKeyPathPattern = process.platform === 'darwin'
      ? escapeRegex(getStandardKeysPath(isolatedHome).replace(isolatedHome, '~'))
      : '(?:~|/.+)/\\.config/sops/age/keys\\.txt';
    const missingProjectKeyPath = join(isolatedHome, '.config', 'sops', 'age', 'keys', 'missing-key-fixture.txt').replace(isolatedHome, '~');

    mkdirSync(dirname(manifestPath), { recursive: true });
    encryptYamlContent('version: 3\nidentities:\n  dev:\n    roles: [owner]\n', manifestPath, {
      root: storeDir,
      keyIdentity: 'missing-key-fixture',
    });

    process.env.HOME = isolatedHome;
    clearExplicitSopsAgeEnv();

    expect(() => decryptYaml(manifestPath, { root: storeDir, keyIdentity: 'missing-key-fixture' })).toThrowError(
      new RegExp([
        'Key identity: missing-key-fixture',
        'Attempted key paths:',
        escapeRegex(missingProjectKeyPath),
        standardKeyPathPattern,
        '~/.config/sops/age/keys.txt',
        '~/.config/sops/age/key.txt',
      ].join('[\\s\\S]*')),
    );
  });

  it('prefers a matching project key over an unrelated shared keyring when package metadata is absent', () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'hush-sops-home-project-match-'));
    const manifestPath = join(storeDir, '.hush', 'manifest.encrypted');
    const standardKeyPath = getStandardKeysPath(isolatedHome);
    const projectKeyPath = join(isolatedHome, '.config', 'sops', 'age', 'keys', 'matrix.txt');

    mkdirSync(dirname(manifestPath), { recursive: true });
    mkdirSync(dirname(standardKeyPath), { recursive: true });
    mkdirSync(dirname(projectKeyPath), { recursive: true });
    writeFileSync(standardKeyPath, '# unrelated default keyring\n', 'utf-8');
    writeFileSync(projectKeyPath, `# project: matrix\n# public key: ${TEST_AGE_PUBLIC_KEY}\n${TEST_AGE_PRIVATE_KEY}\n`, 'utf-8');

    encryptYamlContent('version: 3\nidentities:\n  dev:\n    roles: [owner]\n', manifestPath, {
      root: storeDir,
      keyIdentity: 'matrix',
    });

    process.env.HOME = isolatedHome;
    clearExplicitSopsAgeEnv();

    const resolution = resolveAgeKeySource({ root: storeDir });
    expect(resolution.selectedKeySource).toBe('project-key-match');
    expect(resolution.selectedKeyPath).toBe(projectKeyPath);
    expect(decryptYaml(manifestPath, { root: storeDir })).toContain('version: 3');
  });

  it('matches any recipient listed in .sops.yaml, not just the first one', () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'hush-sops-home-multi-recipient-'));
    const manifestPath = join(storeDir, '.hush', 'manifest.encrypted');
    const projectKeyPath = join(isolatedHome, '.config', 'sops', 'age', 'keys', 'matrix.txt');
    const firstRecipient = 'age1vacr4w7m3qje0px6gvglx4u6rxt2zrkxr572dth8fjz8666ydcesd3fcpf';

    mkdirSync(dirname(manifestPath), { recursive: true });
    mkdirSync(dirname(projectKeyPath), { recursive: true });
    writeFileSync(projectKeyPath, `# project: matrix\n# public key: ${TEST_AGE_PUBLIC_KEY}\n${TEST_AGE_PRIVATE_KEY}\n`, 'utf-8');
    writeFileSync(join(storeDir, '.sops.yaml'), `creation_rules:\n  - encrypted_regex: .*\n    age: ${firstRecipient},${TEST_AGE_PUBLIC_KEY}\n`, 'utf-8');

    encryptYamlContent('version: 3\nidentities:\n  dev:\n    roles: [owner]\n', manifestPath, {
      root: storeDir,
      keyIdentity: 'matrix',
    });

    process.env.HOME = isolatedHome;
    clearExplicitSopsAgeEnv();

    const resolution = resolveAgeKeySource({ root: storeDir });
    expect(resolution.selectedKeySource).toBe('project-key-match');
    expect(resolution.selectedKeyPath).toBe(projectKeyPath);
  });

  it('stages plaintext in a private temp dir with restrictive permissions and cleanup', () => {
    let observedTempFile = '';

    withPrivatePlaintextTempFile('yaml', 'version: 3\n', (tempFile) => {
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

  it('uses the private temp staging helper for setKey updates', () => {
    const encryptedPath = join(storeDir, '.hush.encrypted');

    writeFileSync(join(storeDir, '.plain.env'), 'EXISTING=1\n', 'utf-8');
    encrypt(join(storeDir, '.plain.env'), encryptedPath, {
      root: storeDir,
      keyIdentity: 'hush-global',
    });

    setKey(encryptedPath, 'API_KEY', 'secret-value', {
      root: storeDir,
      keyIdentity: 'hush-global',
    });

    const decrypted = decrypt(encryptedPath, { root: storeDir, keyIdentity: 'hush-global' });
    expect(decrypted).toContain('EXISTING=1');
    expect(decrypted).toContain('API_KEY=secret-value');
  });
});
