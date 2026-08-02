import type { EnvVar } from "../types.js";

function escapeShellValue(value: string): string {
  if (/^[a-zA-Z0-9_\-./]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function formatShell(vars: EnvVar[]): string {
  return vars.map(({ key, value }) => `export ${key}=${escapeShellValue(value)}`).join("\n") + "\n";
}
