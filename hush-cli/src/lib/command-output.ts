import type { HushContext } from "../types.js";

export const JSON_OUTPUT_VERSION = 1 as const;

export interface JsonErrorDetail {
  code: string;
  message: string;
  rejectedInput?: string;
  suggestion?: string;
  details?: unknown;
}

export function jsonSuccess(command: string, data: unknown): string {
  return JSON.stringify({ version: JSON_OUTPUT_VERSION, ok: true, command, data }, null, 2);
}

export function jsonError(command: string, error: JsonErrorDetail): string {
  return JSON.stringify({ version: JSON_OUTPUT_VERSION, ok: false, command, error }, null, 2);
}

export function writeJsonSuccess(ctx: HushContext, command: string, data: unknown): void {
  ctx.logger.log(jsonSuccess(command, data));
}

export function writeJsonError(ctx: HushContext, command: string, error: JsonErrorDetail): void {
  ctx.logger.error(jsonError(command, error));
}
