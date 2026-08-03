import type { EnvVar } from "../types.js";

const VAR_PATTERN = /\$\{([^}]+)\}/g;
const ENV_PREFIX = "env:";

export interface InterpolateOptions {
  processEnv?: Record<string, string | undefined>;
  baseContext?: Record<string, string>;
}

export function interpolateValue(
  value: string,
  context: Record<string, string>,
  options: InterpolateOptions = {},
): string {
  return value.replace(VAR_PATTERN, (match, expression: string) => {
    if (expression.startsWith(ENV_PREFIX)) {
      const envVarName = expression.slice(ENV_PREFIX.length);
      const envValue = options.processEnv?.[envVarName];
      return envValue ?? "";
    }

    const defaultMatch = expression.match(/^([^:]+):-(.*)$/);
    if (defaultMatch) {
      const [, varName, defaultValue] = defaultMatch;
      if (varName in context && context[varName] !== "") {
        const val = context[varName];
        if (val === match) {
          if (
            options.baseContext &&
            varName in options.baseContext &&
            options.baseContext[varName] !== ""
          ) {
            return options.baseContext[varName];
          }
          return defaultValue;
        }
        return val;
      }
      return defaultValue;
    }

    if (expression in context) {
      const val = context[expression];
      if (val === match) {
        if (options.baseContext && expression in options.baseContext) {
          return options.baseContext[expression];
        }
        return match;
      }
      return val;
    }
    return match;
  });
}

export function interpolateVars(vars: EnvVar[], options: InterpolateOptions = {}): EnvVar[] {
  const context: Record<string, string> = { ...options.baseContext };

  for (const { key, value } of vars) {
    context[key] = value;
  }

  const maxIterations = 10;
  let changed = true;
  let iteration = 0;

  while (changed && iteration < maxIterations) {
    changed = false;
    iteration++;

    for (const key of Object.keys(context)) {
      const original = context[key];
      const interpolated = interpolateValue(original, context, options);

      if (interpolated !== original) {
        context[key] = interpolated;
        changed = true;
      }
    }
  }

  return Object.entries(context).map(([key, value]) => ({ key, value }));
}

export function hasUnresolvedVars(value: string): boolean {
  return VAR_PATTERN.test(value);
}

export function getUnresolvedVars(vars: EnvVar[]): string[] {
  const unresolved: string[] = [];

  for (const { key, value } of vars) {
    if (hasUnresolvedVars(value)) {
      unresolved.push(key);
    }
  }

  return unresolved;
}
