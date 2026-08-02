import type { EnvVar } from "../types.js";

export function mergeVars(...varArrays: EnvVar[][]): EnvVar[] {
  const merged = new Map<string, string>();

  for (const vars of varArrays) {
    for (const { key, value } of vars) {
      merged.set(key, value);
    }
  }

  return Array.from(merged.entries()).map(([key, value]) => ({ key, value }));
}
