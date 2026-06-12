import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  ageAvailable,
  ageGenerate,
  agePublicFromPrivate,
  findKeysByPublicKey,
  keyExists,
  keyLoad,
  keySave,
} from '../../src/lib/age.js';
import { TEST_AGE_PRIVATE_KEY, TEST_AGE_PUBLIC_KEY } from '../helpers/sops-test.js';

const binaryAvailable = spawnSync('age-keygen', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!binaryAvailable)('age helpers (requires age-keygen binary)', () => {
  let tempKeysDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempKeysDir = mkdtempSync(join(tmpdir(), 'hush-age-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempKeysDir;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tempKeysDir, { recursive: true, force: true });
  });

  it('ageAvailable returns true when age-keygen is installed', () => {
    expect(ageAvailable()).toBe(true);
  });

  it('ageGenerate returns a valid key pair with correct shape', () => {
    const key = ageGenerate();
    expect(key.public).toMatch(/^age1[a-z0-9]+$/);
    expect(key.private).toMatch(/^AGE-SECRET-KEY-[A-Z0-9]+$/);
  });

  it('agePublicFromPrivate derives the correct public key from a private key', () => {
    // Use the test fixture key to verify the roundtrip
    const derived = agePublicFromPrivate(TEST_AGE_PRIVATE_KEY);
    expect(derived).toBe(TEST_AGE_PUBLIC_KEY);
  });

  it('agePublicFromPrivate roundtrip: generate then derive public matches', () => {
    const key = ageGenerate();
    const derived = agePublicFromPrivate(key.private);
    expect(derived).toBe(key.public);
  });

  it('keySave writes with 0600 permissions and keyLoad reads it back', () => {
    const project = 'test-project';
    const key = ageGenerate();

    keySave(project, key);

    // Find the key file path to check permissions
    const keysDir = join(tempKeysDir, '.config', 'sops', 'age', 'keys');
    const keyFilePath = join(keysDir, 'test-project.txt');

    const stats = statSync(keyFilePath);
    expect(stats.mode & 0o777).toBe(0o600);

    const loaded = keyLoad(project);
    expect(loaded).not.toBeNull();
    expect(loaded!.public).toBe(key.public);
    expect(loaded!.private).toBe(key.private);
  });

  it('keyExists returns false before save and true after', () => {
    const project = 'key-exists-test';
    expect(keyExists(project)).toBe(false);

    const key = ageGenerate();
    keySave(project, key);

    expect(keyExists(project)).toBe(true);
  });

  it('findKeysByPublicKey locates saved keys by their public key', () => {
    const project = 'find-by-public-key-test';
    const key = ageGenerate();
    keySave(project, key);

    const results = findKeysByPublicKey(key.public);
    expect(results.length).toBeGreaterThanOrEqual(1);

    const match = results.find((r) => r.project === project);
    expect(match).toBeDefined();
    expect(match!.public).toBe(key.public);
  });

  it('findKeysByPublicKey returns empty array when no keys match', () => {
    const results = findKeysByPublicKey('age1nonexistent000000000000000000000000000000000000000000000000');
    expect(results).toEqual([]);
  });
});
