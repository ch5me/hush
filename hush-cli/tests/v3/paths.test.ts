import { describe, expect, it } from "vitest";

import {
  getV3EncryptedFilePath,
  getV3FilesRoot,
  getV3ManifestPath,
  getV3RepoRoot,
  isV3EncryptedFilePath,
  isV3ManifestPath,
  stripEncryptedFileExtension,
} from "../../src/types.js";
import { assertNamespacedPath } from "../../src/v3/schema.js";

describe("v3 path helpers", () => {
  it("rejects traversal and platform-separator segments", () => {
    expect(() => assertNamespacedPath("env/../../tmp/escape")).toThrow(/cannot contain/);
    expect(() => assertNamespacedPath("env/./shared")).toThrow(/cannot contain/);
    expect(() => assertNamespacedPath("env\\..\\escape")).toThrow(/forward slashes/);
    expect(() => getV3EncryptedFilePath("/repo", "env/../../tmp/escape")).toThrow();
  });
  it("builds the canonical .hush layout paths", () => {
    expect(getV3RepoRoot("/repo")).toBe("/repo/.hush");
    expect(getV3ManifestPath("/repo")).toBe("/repo/.hush/manifest.encrypted");
    expect(getV3FilesRoot("/repo")).toBe("/repo/.hush/files");
    expect(getV3EncryptedFilePath("/repo", "env/apps/shared")).toBe(
      "/repo/.hush/files/env/apps/shared.encrypted",
    );
  });

  it("detects v3 manifest and file paths", () => {
    expect(isV3ManifestPath("/repo/.hush/manifest.encrypted")).toBe(true);
    expect(isV3EncryptedFilePath("/repo/.hush/files/env/apps/shared.encrypted")).toBe(true);
    expect(stripEncryptedFileExtension("env/apps/shared.encrypted")).toBe("env/apps/shared");
  });
});
