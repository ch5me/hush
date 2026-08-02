import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  createFileDocument,
  createManifestDocument,
  getV3EncryptedFilePath,
  getV3ManifestPath,
} from "../../src/types.js";
import { ensureEncryptedFixtureRepo, readDecryptedYamlFile } from "../helpers/sops-test.js";

const TESTS_DIR = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES_DIR = join(TESTS_DIR, "fixtures", "v3");

const FIXTURE_FAMILIES = [
  "single-user-repo",
  "owner-member-acl-split",
  "ci-only-readable-file",
  "imported-bundle",
  "bundle-conflict",
  "already-migrated-repo",
] as const;

describe("v3 fixture corpus", () => {
  it.each(FIXTURE_FAMILIES)("contains a manifest and validates docs for %s", (fixtureName) => {
    const fixtureRoot = join(FIXTURES_DIR, fixtureName);
    const manifestPath = join(fixtureRoot, getV3ManifestPath(""));
    ensureEncryptedFixtureRepo(fixtureRoot);
    const manifest = createManifestDocument(
      parseYaml(readDecryptedYamlFile(fixtureRoot, manifestPath)),
    );

    expect(manifest.version).toBe(3);
    expect(Object.keys(manifest.identities).length).toBeGreaterThan(0);

    const fileDocsRoot = join(fixtureRoot, ".hush", "files");
    const encryptedFiles = fs
      .readdirSync(fileDocsRoot, { recursive: true })
      .filter(
        (value): value is string => typeof value === "string" && value.endsWith(".encrypted"),
      );

    expect(encryptedFiles.length).toBeGreaterThan(0);

    for (const relativePath of encryptedFiles) {
      const absolutePath = join(fileDocsRoot, relativePath);
      const fileDocument = createFileDocument(
        parseYaml(readDecryptedYamlFile(fixtureRoot, absolutePath)),
      );
      expect(absolutePath).toBe(getV3EncryptedFilePath(fixtureRoot, fileDocument.path));
    }
  });

  it("keeps imported bundle fixtures explicit and pull-only", () => {
    const manifestPath = join(FIXTURES_DIR, "imported-bundle", getV3ManifestPath(""));
    const fixtureRoot = join(FIXTURES_DIR, "imported-bundle");
    ensureEncryptedFixtureRepo(fixtureRoot);
    const manifest = createManifestDocument(
      parseYaml(readDecryptedYamlFile(fixtureRoot, manifestPath)),
    );

    expect(manifest.imports?.platform?.pull.bundles).toEqual(["bundles/platform/runtime"]);
    expect(manifest.bundles?.app?.imports).toEqual([
      { project: "platform", bundle: "bundles/platform/runtime" },
    ]);
  });

  it("represents bundle conflict fixtures as separate ACL files with overlapping logical paths", () => {
    const fixtureRoot = join(FIXTURES_DIR, "bundle-conflict");
    ensureEncryptedFixtureRepo(fixtureRoot);
    const primary = createFileDocument(
      parseYaml(
        readDecryptedYamlFile(
          fixtureRoot,
          join(fixtureRoot, ".hush/files/env/apps/base.encrypted"),
        ),
      ),
    );
    const override = createFileDocument(
      parseYaml(
        readDecryptedYamlFile(
          fixtureRoot,
          join(fixtureRoot, ".hush/files/env/apps/override.encrypted"),
        ),
      ),
    );

    expect(primary.entries["env/apps/api/env/API_URL"]).toBeDefined();
    expect(override.entries["env/apps/api/env/API_URL"]).toBeDefined();
  });
});
