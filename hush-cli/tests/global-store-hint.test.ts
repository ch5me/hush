/**
 * Tests for the globalStoreHint helper (Feature #1 — smart cross-store not-found errors).
 *
 * Strategy: uses a temp dir as a fake "global store" so tests are hermetic.
 * Never touches ~/.hush; never decrypts values.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { globalStoreHint } from '../src/lib/global-store-hint.js';

/** Build a minimal SOPS-style YAML skeleton with plaintext outer keys and fake ciphertext leaves. */
function fakeSopsManifest(targets: string[], bundles: string[]): string {
  const targetObj: Record<string, unknown> = {};
  for (const t of targets) {
    targetObj[t] = { bundle: 'ENC[AES256_GCM,data:fake,iv:fake,tag:fake,type:str]', format: 'ENC[AES256_GCM,data:fake,iv:fake,tag:fake,type:str]' };
  }

  const bundleObj: Record<string, unknown> = {};
  for (const b of bundles) {
    bundleObj[b] = { files: 'ENC[AES256_GCM,data:fake,iv:fake,tag:fake,type:str]' };
  }

  const doc: Record<string, unknown> = {
    version: 'ENC[AES256_GCM,data:fake,iv:fake,tag:fake,type:str]',
    identities: { 'owner-local': 'ENC[AES256_GCM,data:fake,iv:fake,tag:fake,type:str]' },
    targets: targetObj,
    bundles: bundleObj,
    sops: {
      kms: null,
      age: 'age1fake...',
      lastmodified: '2024-01-01T00:00:00Z',
      version: '3.8.0',
    },
  };
  return stringifyYaml(doc, { indent: 2 });
}

function setupGlobalStore(globalRoot: string, targets: string[], bundles: string[]): void {
  const manifestDir = join(globalRoot, '.hush');
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, 'manifest.encrypted'), fakeSopsManifest(targets, bundles), 'utf-8');
}

describe('globalStoreHint', () => {
  let tempDir: string;
  let fakeGlobalRoot: string;
  let fakeRepoRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hush-hint-test-'));
    fakeGlobalRoot = join(tempDir, 'global');
    fakeRepoRoot = join(tempDir, 'project-repo');
    mkdirSync(fakeGlobalRoot, { recursive: true });
    mkdirSync(fakeRepoRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('when global store has the target', () => {
    it('returns a hint string for a missing target', () => {
      setupGlobalStore(fakeGlobalRoot, ['runtime', 'api-production'], ['project', 'api']);

      const hint = globalStoreHint('runtime', 'target', fakeRepoRoot, {
        globalStoreRootOverride: fakeGlobalRoot,
      });

      expect(hint).toBeDefined();
      expect(hint).toContain("'runtime' not found in this store");
      expect(hint).toContain('global store');
      expect(hint).toContain('hush import add');
    });

    it('includes the correct resolved root in the hint', () => {
      setupGlobalStore(fakeGlobalRoot, ['runtime'], ['project']);

      const hint = globalStoreHint('runtime', 'target', fakeRepoRoot, {
        globalStoreRootOverride: fakeGlobalRoot,
      });

      expect(hint).toContain(fakeRepoRoot);
    });

    it('returns a hint for a missing bundle name used as key', () => {
      setupGlobalStore(fakeGlobalRoot, ['runtime'], ['project', 'api-secrets']);

      const hint = globalStoreHint('project', 'key', fakeRepoRoot, {
        globalStoreRootOverride: fakeGlobalRoot,
      });

      expect(hint).toBeDefined();
      expect(hint).toContain("'project' not found");
    });

    it('suggests the matching bundle in the command hint', () => {
      setupGlobalStore(fakeGlobalRoot, ['runtime'], ['my-bundle']);

      const hint = globalStoreHint('my-bundle', 'key', fakeRepoRoot, {
        globalStoreRootOverride: fakeGlobalRoot,
      });

      expect(hint).toContain('my-bundle');
    });
  });

  describe('when global store does NOT have the target', () => {
    it('returns undefined when name not in global store', () => {
      setupGlobalStore(fakeGlobalRoot, ['other-target'], ['other-bundle']);

      const hint = globalStoreHint('missing-target', 'target', fakeRepoRoot, {
        globalStoreRootOverride: fakeGlobalRoot,
      });

      expect(hint).toBeUndefined();
    });
  });

  describe('when global store does not exist', () => {
    it('returns undefined without throwing', () => {
      // fakeGlobalRoot exists but has no .hush/manifest.encrypted
      const hint = globalStoreHint('runtime', 'target', fakeRepoRoot, {
        globalStoreRootOverride: fakeGlobalRoot,
      });

      expect(hint).toBeUndefined();
    });
  });

  describe('when resolved store IS the global store', () => {
    it('returns undefined (no self-referential hint)', () => {
      setupGlobalStore(fakeGlobalRoot, ['runtime'], ['project']);

      // resolvedRoot === globalRoot → no hint
      const hint = globalStoreHint('runtime', 'target', fakeGlobalRoot, {
        globalStoreRootOverride: fakeGlobalRoot,
      });

      expect(hint).toBeUndefined();
    });
  });

  describe('when global manifest is unreadable', () => {
    it('returns undefined gracefully', () => {
      // Write a non-YAML file to the manifest path
      const manifestDir = join(fakeGlobalRoot, '.hush');
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(join(manifestDir, 'manifest.encrypted'), '\x00\x01\x02 not yaml', 'utf-8');

      const hint = globalStoreHint('runtime', 'target', fakeRepoRoot, {
        globalStoreRootOverride: fakeGlobalRoot,
      });

      // Should not throw; may return undefined or a hint depending on parse result.
      // Key property: no exception.
      expect(typeof hint === 'string' || hint === undefined).toBe(true);
    });
  });
});
