import { fs } from "../lib/fs.js";
import type { EnvVar } from "../types.js";

export function parseEnvContent(content: string): EnvVar[] {
  const vars: EnvVar[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1);

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    vars.push({ key, value });
  }

  return vars;
}

export function parseEnvFile(filePath: string): EnvVar[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf-8") as string;
  return parseEnvContent(content);
}

export function varsToRecord(vars: EnvVar[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const { key, value } of vars) {
    record[key] = value;
  }
  return record;
}

export function recordToVars(record: Record<string, string>): EnvVar[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}
