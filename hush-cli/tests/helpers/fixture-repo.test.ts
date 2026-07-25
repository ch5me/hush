import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SOPS_PREFLIGHT_TIMEOUT_ENV, encryptYamlContent } from '../../src/core/sops.js';
import {
  FixtureNotDecryptedError,
  TEST_AGE_PUBLIC_KEY,
  ensureEncryptedFixtureRepo,
  ensureTestSopsEnv,
  readDecryptedYamlFile,
} from './sops-test.js';

const PLAINTEXT_MANIFEST = [
  'version: 3',
  'identities:',
  '  owner-local:',
  '    roles:',
  '      - owner',
  'fileIndex: {}',
  '',
].join('\n');

describe('ensureEncryptedFixtureRepo write guard', () => {
  let fixtureRoot: string;
  let manifestPath: string;
  let fakeBinDir: string;
  let originalPath: string | undefined;
  let originalPreflightTimeout: string | undefined;

  beforeEach(() => {
    ensureTestSopsEnv();
    fixtureRoot = mkdtempSync(join(tmpdir(), 'hush-fixture-guard-'));
    fakeBinDir = mkdtempSync(join(tmpdir(), 'hush-fixture-guard-bin-'));
    manifestPath = join(fixtureRoot, '.hush', 'manifest.encrypted');
    mkdirSync(join(fixtureRoot, '.hush'), { recursive: true });
    originalPath = process.env.PATH;
    originalPreflightTimeout = process.env[SOPS_PREFLIGHT_TIMEOUT_ENV];
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPreflightTimeout === undefined) delete process.env[SOPS_PREFLIGHT_TIMEOUT_ENV];
    else process.env[SOPS_PREFLIGHT_TIMEOUT_ENV] = originalPreflightTimeout;
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  function writeSopsConfig(recipient: string): void {
    writeFileSync(
      join(fixtureRoot, '.sops.yaml'),
      `creation_rules:\n  - encrypted_regex: .*\n    age: ${recipient}\n`,
      'utf-8',
    );
  }

  /** Emulate the reported failure: sops stalls, so its preflight budget blows. */
  function stallSopsOnThisMachine(): void {
    const fakeSops = join(fakeBinDir, 'sops');
    writeFileSync(fakeSops, '#!/bin/sh\nsleep 5\n', 'utf-8');
    chmodSync(fakeSops, 0o755);
    process.env.PATH = fakeBinDir;
    process.env[SOPS_PREFLIGHT_TIMEOUT_ENV] = '200';
  }

  it('throws a typed error naming the fixture instead of persisting undecryptable content', () => {
    writeSopsConfig(TEST_AGE_PUBLIC_KEY);
    encryptYamlContent(PLAINTEXT_MANIFEST, manifestPath, { root: fixtureRoot });
    const before = readFileSync(manifestPath, 'utf-8');

    stallSopsOnThisMachine();

    let thrown: unknown;
    try {
      ensureEncryptedFixtureRepo(fixtureRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(FixtureNotDecryptedError);
    expect((thrown as FixtureNotDecryptedError).code).toBe('FIXTURE_NOT_DECRYPTED');
    expect((thrown as FixtureNotDecryptedError).fixturePath).toBe(manifestPath);
    // Names the actual cause rather than surfacing later as an "Invalid Hush namespace" cascade.
    expect((thrown as FixtureNotDecryptedError).decryptFailure).toContain('SopsPreflightTimeoutError');
    // The message must carry the recovery command, which is otherwise undiscoverable.
    expect((thrown as Error).message).toContain('git checkout -- hush-cli/tests/fixtures');
    expect((thrown as Error).message).toContain(SOPS_PREFLIGHT_TIMEOUT_ENV);
    // Critically: the tracked fixture is untouched.
    expect(readFileSync(manifestPath, 'utf-8')).toBe(before);
  });

  it('refuses to re-encrypt a half-corrupted fixture whose values are literal ciphertext', () => {
    writeSopsConfig(TEST_AGE_PUBLIC_KEY);
    // What an earlier unguarded run persisted: ciphertext values, no sops envelope.
    const corrupted = 'path: ENC[AES256_GCM,data:sBlvScEbQjDL+BfVkLs=,type:str]\n';
    writeFileSync(manifestPath, corrupted, 'utf-8');

    expect(() => ensureEncryptedFixtureRepo(fixtureRoot)).toThrow(FixtureNotDecryptedError);
    expect(readFileSync(manifestPath, 'utf-8')).toBe(corrupted);
  });

  it('still encrypts a fixture that is legitimately checked in as plaintext', () => {
    writeSopsConfig(TEST_AGE_PUBLIC_KEY);
    writeFileSync(manifestPath, PLAINTEXT_MANIFEST, 'utf-8');

    ensureEncryptedFixtureRepo(fixtureRoot);

    expect(readFileSync(manifestPath, 'utf-8')).toContain('ENC[AES256_GCM');
    expect(readDecryptedYamlFile(fixtureRoot, manifestPath)).toContain('version: 3');
  });
});
