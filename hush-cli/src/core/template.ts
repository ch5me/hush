import { join } from "node:path";

import type { EnvVar, Environment, HushContext } from "../types.js";
import { interpolateVars, type InterpolateOptions } from "./interpolate.js";
import { mergeVars } from "./merge.js";
import { parseEnvContent } from "./parse.js";

const TEMPLATE_FILES = {
  base: ".hush",
  development: ".hush.development",
  production: ".hush.production",
  local: ".hush.local",
};

export interface LocalTemplateResult {
  hasTemplate: boolean;
  templateDir: string;
  vars: EnvVar[];
  files: string[];
}

export function loadLocalTemplates(
  contextDir: string,
  env: Environment,
  fs: HushContext["fs"],
): LocalTemplateResult {
  const files: string[] = [];
  const varSources: EnvVar[][] = [];

  const basePath = join(contextDir, TEMPLATE_FILES.base);
  if (fs.existsSync(basePath)) {
    files.push(TEMPLATE_FILES.base);
    varSources.push(parseEnvContent(fs.readFileSync(basePath, "utf-8") as string));
  }

  const envPath = join(contextDir, TEMPLATE_FILES[env]);
  if (fs.existsSync(envPath)) {
    files.push(TEMPLATE_FILES[env]);
    varSources.push(parseEnvContent(fs.readFileSync(envPath, "utf-8") as string));
  }

  const localPath = join(contextDir, TEMPLATE_FILES.local);
  if (fs.existsSync(localPath)) {
    files.push(TEMPLATE_FILES.local);
    varSources.push(parseEnvContent(fs.readFileSync(localPath, "utf-8") as string));
  }

  if (varSources.length === 0) {
    return {
      hasTemplate: false,
      templateDir: contextDir,
      vars: [],
      files: [],
    };
  }

  return {
    hasTemplate: true,
    templateDir: contextDir,
    vars: mergeVars(...varSources),
    files,
  };
}

export function resolveTemplateVars(
  templateVars: EnvVar[],
  rootSecrets: Record<string, string>,
  options: InterpolateOptions = {},
): EnvVar[] {
  const interpolated = interpolateVars(templateVars, {
    ...options,
    baseContext: rootSecrets,
  });

  const templateKeys = new Set(templateVars.map((v) => v.key));
  return interpolated.filter((v) => templateKeys.has(v.key));
}
