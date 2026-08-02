import { describe, expect, it, vi } from "vitest";

import {
  jsonError,
  jsonSuccess,
  writeJsonError,
  writeJsonSuccess,
} from "../src/lib/command-output.js";
import type { HushContext } from "../src/types.js";

function context() {
  const logger = { log: vi.fn(), error: vi.fn() };
  return { logger, ctx: { logger } as unknown as HushContext };
}

describe("structured command output", () => {
  it("uses a versioned stable success envelope", () => {
    expect(JSON.parse(jsonSuccess("status", { repository: "ready" }))).toEqual({
      version: 1,
      ok: true,
      command: "status",
      data: { repository: "ready" },
    });
  });

  it("uses a versioned stable error envelope without flattening details", () => {
    expect(
      JSON.parse(
        jsonError("has", {
          code: "RESOLUTION_FAILED",
          message: "synthetic failure",
          rejectedInput: "SYNTHETIC_KEY",
        }),
      ),
    ).toEqual({
      version: 1,
      ok: false,
      command: "has",
      error: {
        code: "RESOLUTION_FAILED",
        message: "synthetic failure",
        rejectedInput: "SYNTHETIC_KEY",
      },
    });
  });

  it("writes success data only to stdout and errors only to stderr", () => {
    const success = context();
    writeJsonSuccess(success.ctx, "doctor", { checks: [] });
    expect(success.logger.log).toHaveBeenCalledOnce();
    expect(success.logger.error).not.toHaveBeenCalled();

    const failure = context();
    writeJsonError(failure.ctx, "doctor", { code: "FAILED", message: "synthetic" });
    expect(failure.logger.error).toHaveBeenCalledOnce();
    expect(failure.logger.log).not.toHaveBeenCalled();
  });
});
