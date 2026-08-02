import type { EnvVar } from "../types.js";

export interface KeyDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * SECURITY: Only compares keys - never exposes secret values in output.
 */
export function computeDiff(sourceVars: EnvVar[], encryptedVars: EnvVar[]): KeyDiff {
  const sourceMap = new Map(sourceVars.map((v) => [v.key, v.value]));
  const encryptedMap = new Map(encryptedVars.map((v) => [v.key, v.value]));

  const sourceKeys = new Set(sourceMap.keys());
  const encryptedKeys = new Set(encryptedMap.keys());

  const added = [...sourceKeys].filter((k) => !encryptedKeys.has(k)).sort();
  const removed = [...encryptedKeys].filter((k) => !sourceKeys.has(k)).sort();
  const changed = [...sourceKeys]
    .filter((k) => encryptedKeys.has(k))
    .filter((k) => sourceMap.get(k) !== encryptedMap.get(k))
    .sort();

  return { added, removed, changed };
}

export function isInSync(diff: KeyDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}
