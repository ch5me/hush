import { describe, expect, it } from "vitest";

import {
  resolveTargetDeploymentContext,
  selectRuntimeTargetForCommand,
} from "../src/commands/v3-command-helpers.js";
import type { HushV3Repository, StoreContext } from "../src/types.js";

function createStore(): StoreContext {
  return {
    mode: "project",
    root: "/repo",
    configPath: null,
    keyIdentity: "hush-global",
    displayLabel: "/repo",
  };
}

function createRepository(): HushV3Repository {
  return {
    kind: "v3",
    projectRoot: "/repo",
    manifestPath: "/repo/.hush/manifest.encrypted",
    filesRoot: "/repo/.hush/files",
    manifest: {
      version: 3,
      identities: {
        "owner-local": { roles: ["owner"] },
      },
      targets: {
        web: { bundle: "web-runtime", format: "dotenv", mode: "process" },
        api: { bundle: "api-runtime", format: "wrangler", mode: "process" },
        "api-production": { bundle: "api-production", format: "wrangler", mode: "process" },
      },
      metadata: {
        legacyMigration: {
          targets: [
            { name: "web", path: "./apps/web", push_to: null },
            { name: "api", path: "./apps/api", push_to: { type: "cloudflare-workers" } },
          ],
        },
      },
    },
    files: [],
    filesByPath: {},
    fileSystemPaths: {},
    loadFile: () => {
      throw new Error("not used");
    },
  } as unknown as HushV3Repository;
}

describe("v3 command helpers", () => {
  it("selects the migrated target from cwd when multiple targets exist", () => {
    const selection = selectRuntimeTargetForCommand(
      createRepository(),
      createStore(),
      { name: "list", args: [] },
      undefined,
      "/repo/apps/api/src",
    );

    expect(selection.targetName).toBe("api");
  });

  it("surfaces a clearer error when the repo root remains ambiguous", () => {
    expect(() =>
      selectRuntimeTargetForCommand(
        createRepository(),
        createStore(),
        { name: "has", args: ["DATABASE_URL"] },
        undefined,
        "/repo",
      ),
    ).toThrow(
      /does not accept --target yet, so run it from a migrated target directory or add a runtime target/i,
    );
  });

  it("maps migrated production targets back to the legacy deployment path", () => {
    const deployment = resolveTargetDeploymentContext(
      createStore(),
      createRepository(),
      "api-production",
    );

    expect(deployment.cwd).toBe("/repo/apps/api");
    expect(deployment.pushTo).toEqual({ type: "cloudflare-workers" });
  });
});
