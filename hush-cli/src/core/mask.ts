import type { EnvVar } from '../types.js';

export interface MaskedVar {
  key: string;
  masked: string;
  isSet: boolean;
}

const REDACTION = '********';

/**
 * Fixed-width redaction. Deliberately reveals neither a prefix nor the exact
 * length of the value: masked output may be read by AI agents, and prefix or
 * length disclosure materially narrows guessing for structured tokens.
 */
export function maskValue(value: string): string {
  if (!value) return '(not set)';
  return REDACTION;
}

export function maskVars(vars: EnvVar[]): MaskedVar[] {
  return vars.map(({ key, value }) => ({
    key,
    masked: maskValue(value),
    isSet: value.length > 0,
  }));
}

export function formatMaskedVar(v: MaskedVar, maxKeyLen: number): string {
  const paddedKey = v.key.padEnd(maxKeyLen);
  if (!v.isSet) {
    return `${paddedKey} = (not set)`;
  }
  return `${paddedKey} = ${v.masked}`;
}
