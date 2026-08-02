import type { EnvVar } from "../types.js";

export function formatJson(vars: EnvVar[]): string {
  const obj: Record<string, string> = {};
  for (const { key, value } of vars) {
    obj[key] = value;
  }
  return JSON.stringify(obj, null, 2) + "\n";
}
