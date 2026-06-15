/**
 * Global-store cross-store hint helper.
 *
 * When a target/key is not found in the resolved (repo-local) store, this
 * helper safely peeks at the GLOBAL store's manifest (names only — never
 * decrypts values) and returns a suggestion string if the requested
 * target/key name is found there.
 *
 * Design constraints:
 * - Never decrypts secret values; reads only structural manifest names.
 * - Never throws; all failures return undefined (best-effort, graceful).
 * - Never fires when the resolved store IS already the global store.
 * - The global store root is overridable via `globalStoreRootOverride` so
 *   tests can point this at a temp directory without touching HOME.
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { GLOBAL_STORE_ROOT } from '../store.js';

export interface GlobalStoreHintOptions {
  /**
   * Override the global store root for tests (defaults to ~/.hush).
   */
  globalStoreRootOverride?: string;
}

/**
 * Read ONLY the structural names (target names, bundle names) from the global
 * store manifest without decrypting any secret values.
 *
 * The manifest at `.hush/manifest.encrypted` is a SOPS-encrypted YAML file.
 * SOPS-encrypted YAML still has a plaintext YAML skeleton — only the *values*
 * in `sops.encrypted_regex`-matching leaves are ciphertext. The outer YAML
 * keys (e.g. `targets:`, `bundles:`) remain readable as plaintext YAML.
 *
 * This means we can safely `readFileSync` + `parseYaml` the manifest to get
 * the key names without invoking `sops --decrypt` and without touching any
 * actual secret material.
 */
function readGlobalManifestNames(
  globalRoot: string,
): { targetNames: string[]; bundleNames: string[] } | undefined {
  const manifestPath = join(globalRoot, '.hush', 'manifest.encrypted');

  if (!existsSync(manifestPath)) {
    return undefined;
  }

  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    // SOPS YAML: outer keys are plaintext; leaf ciphertext values look like
    // "ENC[AES256_GCM,...]". We only care about key names, so plain parseYaml
    // is correct and safe here.
    const parsed = parseYaml(raw) as Record<string, unknown> | null;

    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }

    const targets = parsed.targets;
    const bundles = parsed.bundles;

    const targetNames = targets && typeof targets === 'object' && !Array.isArray(targets)
      ? Object.keys(targets as Record<string, unknown>)
      : [];

    const bundleNames = bundles && typeof bundles === 'object' && !Array.isArray(bundles)
      ? Object.keys(bundles as Record<string, unknown>)
      : [];

    return { targetNames, bundleNames };
  } catch {
    // Any I/O or parse error → silently return undefined (best-effort).
    return undefined;
  }
}

/**
 * Build a cross-store hint string if the missing target or key exists in the
 * global store (~/.hush), and the current resolved store is NOT the global store.
 *
 * Returns `undefined` when:
 * - the resolved store root IS the global store (no hint needed)
 * - the global store does not exist
 * - the global store manifest cannot be read
 * - the target/key is not found in the global store
 *
 * @param missingName  The target name or key name that was not found.
 * @param kind         'target' or 'key' — used in the hint wording.
 * @param resolvedRoot The resolved store root for the current command.
 * @param options      Optional overrides (test hook for globalStoreRootOverride).
 */
export function globalStoreHint(
  missingName: string,
  kind: 'target' | 'key',
  resolvedRoot: string,
  options: GlobalStoreHintOptions = {},
): string | undefined {
  const globalRoot = options.globalStoreRootOverride ?? GLOBAL_STORE_ROOT;

  // Don't hint if the resolved store IS already the global store.
  // Normalize both paths to avoid trailing-slash mismatches.
  const normalizedResolved = resolvedRoot.replace(/\/+$/, '');
  const normalizedGlobal = globalRoot.replace(/\/+$/, '');
  if (normalizedResolved === normalizedGlobal) {
    return undefined;
  }

  const names = readGlobalManifestNames(globalRoot);
  if (!names) {
    return undefined;
  }

  const { targetNames, bundleNames } = names;

  // For a 'target' lookup: check target names directly.
  // For a 'key' lookup: check bundle names (keys live inside bundle-resolved files).
  // In both cases we check both lists — a bundle name often matches the
  // --bundle flag that wires a target.
  const allNames = [...new Set([...targetNames, ...bundleNames])];
  const found = allNames.includes(missingName);

  if (!found) {
    return undefined;
  }

  const homeDir = process.env.HOME ?? '';
  const displayGlobal = homeDir && globalRoot.startsWith(homeDir)
    ? `~/${globalRoot.slice(homeDir.length + 1)}`
    : globalRoot;

  // Choose a relevant bundle example: prefer a bundle that matches the name, or use first.
  const matchingBundle = bundleNames.includes(missingName) ? missingName : (bundleNames[0] ?? 'project');

  return (
    `${kind} '${missingName}' not found in this store (${normalizedResolved}). `
    + `It exists in the global store ${displayGlobal} — compose it explicitly: `
    + `\`hush import add --source-root ${displayGlobal} --bundle ${matchingBundle}\` (persistent), `
    + `or run one-off with \`hush --root ${displayGlobal} <cmd>\`.`
  );
}
