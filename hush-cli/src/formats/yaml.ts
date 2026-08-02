import type { EnvVar } from "../types.js";

/**
 * Format environment variables as YAML.
 * Useful for Kubernetes ConfigMaps, Docker Compose, and other YAML-based configs.
 *
 * Output format:
 * ```yaml
 * DATABASE_URL: "postgres://localhost/db"
 * API_KEY: "sk_test_xxx"
 * ```
 */
export function formatYaml(vars: EnvVar[]): string {
  if (vars.length === 0) {
    return "{}\n";
  }

  return (
    vars
      .map(({ key, value }) => {
        // YAML string escaping rules:
        // - Simple alphanumeric values don't need quotes
        // - Values with special chars need double quotes
        // - Double quotes inside values need escaping
        const needsQuotes =
          value === "" ||
          value.includes(":") ||
          value.includes("#") ||
          value.includes("'") ||
          value.includes('"') ||
          value.includes("\n") ||
          value.includes("\\") ||
          value.startsWith(" ") ||
          value.endsWith(" ") ||
          value.startsWith("!") ||
          value.startsWith("&") ||
          value.startsWith("*") ||
          value.startsWith("|") ||
          value.startsWith(">") ||
          value.startsWith("%") ||
          value.startsWith("@") ||
          value.startsWith("`") ||
          /^(true|false|yes|no|on|off|null|~)$/i.test(value) ||
          /^-?\d+(\.\d+)?$/.test(value) ||
          /^0x[0-9a-fA-F]+$/.test(value) ||
          /^0o[0-7]+$/.test(value);

        if (needsQuotes) {
          // Escape backslashes and double quotes for YAML double-quoted strings
          const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
          return `${key}: "${escaped}"`;
        }

        return `${key}: ${value}`;
      })
      .join("\n") + "\n"
  );
}
