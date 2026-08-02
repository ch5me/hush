import type { EnvVar } from "../types.js";

export function formatDotenv(vars: EnvVar[]): string {
  return vars.map(({ key, value }) => `${key}=${value}`).join("\n") + "\n";
}
