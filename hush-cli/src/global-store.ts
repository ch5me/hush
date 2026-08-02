import { dirname } from "node:path";

import { stringify as yamlStringify } from "yaml";

import {
  V3_SCHEMA_VERSION,
  createFileDocument,
  createFileIndexEntry,
  createManifestDocument,
  getActiveIdentity,
  getV3EncryptedFilePath,
  getV3ManifestPath,
  loadV3Repository,
  setActiveIdentity,
} from "./index.js";
import type { HushContext, StoreContext } from "./types.js";

const DEFAULT_ACTIVE_IDENTITY = "owner-local";

function buildSopsConfig(publicKey: string): string {
  return yamlStringify({
    creation_rules: [{ encrypted_regex: ".*", age: publicKey }],
  });
}

function writeYaml(ctx: HushContext, store: StoreContext, filePath: string, value: unknown): void {
  const parentDir = dirname(filePath);
  ctx.fs.mkdirSync(parentDir, { recursive: true });
  ctx.sops.encryptYamlContent(yamlStringify(value, { indent: 2 }), filePath, {
    root: store.root,
    keyIdentity: store.keyIdentity,
  });
}

function ensureGlobalManifest(ctx: HushContext, store: StoreContext): void {
  const manifestPath = getV3ManifestPath(store.root);
  if (ctx.fs.existsSync(manifestPath)) {
    return;
  }

  writeYaml(
    ctx,
    store,
    manifestPath,
    createManifestDocument({
      version: V3_SCHEMA_VERSION,
      identities: {
        "owner-local": {
          roles: ["owner"],
          description: "Default owner identity for the global store",
        },
        "member-local": {
          roles: ["member"],
          description: "Default member identity for the global store",
        },
        ci: { roles: ["ci"], description: "Default automation identity for the global store" },
      },
      fileIndex: {
        "env/project/shared": createFileIndexEntry(
          createFileDocument({
            path: "env/project/shared",
            readers: {
              roles: ["owner", "member", "ci"],
              identities: [],
            },
            sensitive: true,
            entries: {},
          }),
        ),
      },
      bundles: {
        project: {
          files: [{ path: "env/project/shared" }],
        },
      },
      targets: {
        runtime: {
          bundle: "project",
          format: "dotenv",
          mode: "process",
        },
        example: {
          bundle: "project",
          format: "dotenv",
          mode: "example",
        },
      },
      metadata: {
        project: store.keyIdentity ?? "hush-global",
      },
    }),
  );
}

function ensureGlobalSharedFile(ctx: HushContext, store: StoreContext): void {
  const filePath = getV3EncryptedFilePath(store.root, "env/project/shared");
  if (ctx.fs.existsSync(filePath)) {
    return;
  }

  writeYaml(
    ctx,
    store,
    filePath,
    createFileDocument({
      path: "env/project/shared",
      readers: {
        roles: ["owner", "member", "ci"],
        identities: [],
      },
      sensitive: true,
      entries: {},
    }),
  );
}

function ensureGlobalActiveIdentity(ctx: HushContext, store: StoreContext): void {
  const repository = loadV3Repository(store.root, { keyIdentity: store.keyIdentity });
  const current = getActiveIdentity(ctx, store);

  if (current && repository.manifest.identities[current]) {
    return;
  }

  setActiveIdentity(ctx, {
    store,
    identity: DEFAULT_ACTIVE_IDENTITY,
    identities: repository.manifest.identities,
    command: { name: "bootstrap", args: ["--global"] },
  });
}

export function ensureGlobalStoreBootstrap(
  ctx: HushContext,
  store: StoreContext,
  publicKey?: string,
): { hasKey: boolean } {
  if (store.mode !== "global") {
    return { hasKey: false };
  }

  if (!ctx.fs.existsSync(store.root)) {
    ctx.fs.mkdirSync(store.root, { recursive: true });
  }

  const key = publicKey
    ? { public: publicKey }
    : store.keyIdentity
      ? ctx.age.keyLoad(store.keyIdentity)
      : null;

  if (key) {
    const sopsPath = ctx.path.join(store.root, ".sops.yaml");
    if (!ctx.fs.existsSync(sopsPath)) {
      ctx.fs.writeFileSync(sopsPath, buildSopsConfig(key.public), "utf-8");
    }
  }

  ensureGlobalManifest(ctx, store);
  ensureGlobalSharedFile(ctx, store);
  ensureGlobalActiveIdentity(ctx, store);

  return { hasKey: key !== null };
}
