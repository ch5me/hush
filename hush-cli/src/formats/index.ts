import type { EnvVar, OutputFormat } from "../types.js";
import { formatDotenv } from "./dotenv.js";
import { formatJson } from "./json.js";
import { formatShell } from "./shell.js";
import { formatWrangler } from "./wrangler.js";
import { formatYaml } from "./yaml.js";

export function formatVars(vars: EnvVar[], format: OutputFormat): string {
  switch (format) {
    case "dotenv":
      return formatDotenv(vars);
    case "wrangler":
      return formatWrangler(vars);
    case "vercel":
      return formatDotenv(vars);
    case "json":
      return formatJson(vars);
    case "shell":
      return formatShell(vars);
    case "yaml":
      return formatYaml(vars);
  }
}

export { formatDotenv, formatJson, formatShell, formatWrangler, formatYaml };
