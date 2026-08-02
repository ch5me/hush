import { describe, expect, it } from "vitest";

import {
  HUSH_V3_NAMESPACES,
  HUSH_V3_ROLES,
  assertHushNamespace,
  assertHushRole,
  createFileDocument,
  createManifestDocument,
} from "../../src/types.js";

describe("v3 schema primitives", () => {
  it("accepts the locked namespace set", () => {
    expect(HUSH_V3_NAMESPACES.map(assertHushNamespace)).toEqual(HUSH_V3_NAMESPACES);
  });

  it("accepts the locked role set", () => {
    expect(HUSH_V3_ROLES.map(assertHushRole)).toEqual(HUSH_V3_ROLES);
  });

  it("rejects invalid namespaces explicitly", () => {
    expect(() => assertHushNamespace("secrets")).toThrowError(
      'Invalid Hush namespace "secrets". Expected one of: env, artifacts, bundles, user, imports',
    );
  });

  it("rejects invalid roles explicitly", () => {
    expect(() => assertHushRole("admin")).toThrowError(
      'Invalid Hush role "admin". Expected one of: owner, member, ci',
    );
  });

  it("validates manifest documents against v3 identity rules", () => {
    const manifest = createManifestDocument({
      version: 3,
      activeIdentity: "developer-local",
      identities: {
        "developer-local": { roles: ["owner"] },
        ci: { roles: ["ci"] },
      },
      bundles: {
        "web-runtime": {
          files: [{ path: "env/apps/shared" }],
        },
      },
      targets: {
        "web-dev": {
          bundle: "web-runtime",
          format: "dotenv",
        },
      },
    });

    expect(manifest.identities["developer-local"].roles).toEqual(["owner"]);
    expect(manifest.targets?.["web-dev"].bundle).toBe("web-runtime");
  });

  it("validates file docs as file-scoped ACL units", () => {
    const file = createFileDocument({
      path: "env/apps/shared",
      readers: {
        roles: ["owner", "member"],
        identities: ["developer-local"],
      },
      sensitive: false,
      entries: {
        "env/apps/web/env/NEXT_PUBLIC_API_URL": {
          value: "https://api.example.com",
          sensitive: false,
        },
      },
    });

    expect(file.path).toBe("env/apps/shared");
    expect(file.readers.roles).toEqual(["owner", "member"]);
  });
});
