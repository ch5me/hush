import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import pc from "picocolors";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { findProjectRoot, isV3RepositoryRoot } from "../config/loader.js";
import { SopsPreflightTimeoutError } from "../core/sops.js";
import {
  appendAuditEvent,
  createFileDocument,
  getActiveIdentity,
  getProjectStatePaths,
  getV3EncryptedFilePath,
  requireActiveIdentity,
  resolveV3Target,
  shapeTargetArtifacts,
} from "../index.js";
import type {
  EnvVar,
  PushConfig,
  HushCompactRecord,
  HushContext,
  HushFileDocument,
  HushProvenanceRecord,
  HushResolvedNode,
  HushTargetDefinition,
  HushTargetResolution,
  HushV3Repository,
  StoreContext,
} from "../types.js";
import type { HushShadowedEnvVar } from "../v3/artifacts.js";
import { shadowPolicyFromEnv } from "../v3/artifacts.js";
import { createProvenanceRecord, type HushFileEntry } from "../v3/domain.js";
import type { HushImportRepositoryMap } from "../v3/imports.js";
import type { HushSelectedEntryCandidate } from "../v3/provenance.js";
import { loadV3Repository, persistV3FileDocument } from "../v3/repository.js";
import {
  LEGACY_MACHINE_LOCAL_FILE_PATH,
  MACHINE_LOCAL_FILE_PATH,
  ReservedFilePathError,
  getNamespaceFromPath,
  isMachineLocalPath,
  normalizeHushPath,
} from "../v3/schema.js";

/**
 * Short aliases for the repository files `bootstrap`/`set`/`edit` will create on
 * demand. `local` is deliberately absent: it names the machine-local store,
 * which is not a repository file. See `MACHINE_LOCAL_FILE_PATH`.
 */
export const DEFAULT_V3_FILE_PATHS = {
  shared: "env/project/shared",
  development: "env/project/development",
  production: "env/project/production",
} as const;

export const LOCAL_OVERRIDE_FILENAME = "local-overrides.encrypted";
export const DEFAULT_PERSISTED_OUTPUT_DIRNAME = ".hush-materialized";

export type FileKey = keyof typeof DEFAULT_V3_FILE_PATHS;
export const FILE_KEYS = Object.keys(DEFAULT_V3_FILE_PATHS) as FileKey[];
const FILE_ALIASES: Record<string, FileKey> = {
  shared: "shared",
  development: "development",
  dev: "development",
  production: "production",
  prod: "production",
};

/** Short `--file` alias for the machine-local store, alongside `user/local`. */
export const MACHINE_LOCAL_ALIAS = "local";

/**
 * Selectors that used to be accepted as a leading positional file argument.
 * Kept as a set so the legacy-syntax diagnostic keeps firing for `local` even
 * though `local` is no longer a repository file key.
 */
const LEGACY_POSITIONAL_FILE_ARGS = new Set<string>([...FILE_KEYS, MACHINE_LOCAL_ALIAS]);

export function loadImportedRepositories(repository: HushV3Repository): HushImportRepositoryMap {
  return Object.fromEntries(
    Object.entries(repository.manifest.imports ?? {}).map(([name, definition]) => {
      if (!definition.sourceRoot) {
        throw new Error(
          `Import "${name}" has no sourceRoot binding. Re-add it with hush import add --source-root <path>.`,
        );
      }
      return [
        name,
        loadV3Repository(definition.sourceRoot, { keyIdentity: definition.sourceRoot }),
      ];
    }),
  );
}

export type EditableScope = "repository" | "machine-local";

export interface EditableDestination {
  /** Set only for repository files that `set`/`edit` may create on demand. */
  fileKey?: FileKey;
  filePath: string;
  scope: EditableScope;
}

/** Shared singleton — frozen because every machine-local write resolves to it. */
export const MACHINE_LOCAL_DESTINATION: EditableDestination = Object.freeze({
  filePath: MACHINE_LOCAL_FILE_PATH,
  scope: "machine-local",
});

export function isLegacyPositionalFileArg(value: string): boolean {
  return LEGACY_POSITIONAL_FILE_ARGS.has(value);
}

/**
 * Normalize a user-supplied file selector (registered namespaced path,
 * `.hush/files/...` path, or `*.encrypted` form) to a bare logical file path.
 */
export function normalizeRequestedFilePath(value: string): string {
  return value
    .trim()
    .replace(/\.encrypted$/, "")
    .replace(/^\.hush\/files\//, "")
    .replace(/^\/+/, "");
}

/**
 * Resolve an explicit `--file`/positional file selector to a concrete write
 * destination and its storage class.
 *
 * The selector's meaning never depends on manifest state. `local` and
 * `user/local` are always the machine-local store; every other selector is
 * always repository storage. Short aliases (shared/dev/development/prod/
 * production) resolve to their default repository path; anything else must be a
 * file already declared in the manifest file index.
 *
 * Hard-errors (never silently routes a secret to a fallback file, and never
 * across storage classes) when the selector cannot be honored — this is the
 * load-bearing safety property for `set`/`edit`.
 */
export function resolveEditableDestination(
  file: string,
  repository: HushV3Repository,
): EditableDestination {
  const requested = file.trim();
  const normalized = normalizeRequestedFilePath(file);

  if (requested === MACHINE_LOCAL_ALIAS || normalized === MACHINE_LOCAL_FILE_PATH) {
    return MACHINE_LOCAL_DESTINATION;
  }

  if (isMachineLocalPath(normalized)) {
    throw new ReservedFilePathError(
      normalized,
      `The only machine-local destination is "${MACHINE_LOCAL_FILE_PATH}" (write it with --repo-local).`,
    );
  }

  const alias = FILE_ALIASES[requested];
  if (alias) {
    return { fileKey: alias, filePath: DEFAULT_V3_FILE_PATHS[alias], scope: "repository" };
  }

  if (repository.filesByPath[normalized]) {
    return { filePath: normalized, scope: "repository" };
  }

  const matchedAlias = (Object.entries(DEFAULT_V3_FILE_PATHS) as [FileKey, string][]).find(
    ([, candidatePath]) => candidatePath === normalized,
  );
  if (matchedAlias) {
    const [fileKey, filePath] = matchedAlias;
    return { fileKey, filePath, scope: "repository" };
  }

  // The one selector that used to mean two storage locations. Undeclared, it
  // silently became a machine-local write; declared, a committed repository
  // write. Neither is guessable from the command line, so say so instead.
  if (normalized === LEGACY_MACHINE_LOCAL_FILE_PATH) {
    throw new Error(
      `"${LEGACY_MACHINE_LOCAL_FILE_PATH}" is not declared in this repository, and it is no longer an alias for ` +
        `machine-local storage. Machine-local overrides now live at "${MACHINE_LOCAL_FILE_PATH}": write them with ` +
        "--repo-local (this machine only, never committed). To write a committed repository file that every reader " +
        `of this repo can decrypt, declare it first with "hush file add ${LEGACY_MACHINE_LOCAL_FILE_PATH}".`,
    );
  }

  throw new Error(
    `Unknown file "${file}". Use one of: shared, development, production, local, ` +
      `or a declared v3 file path (run "hush file list" to see registered files).`,
  );
}

/**
 * Load (and, for alias destinations, lazily create) the editable file document
 * for a resolved destination. Declared non-alias paths must already exist.
 */
export function loadEditableDestination(
  ctx: HushContext,
  store: StoreContext,
  repository: HushV3Repository,
  destination: EditableDestination,
): EditableFileDocument {
  if (destination.scope === "machine-local") {
    return ensureMachineLocalDocument(ctx, store);
  }

  if (destination.fileKey) {
    return ensureEditableFileDocument(ctx, store, repository, destination.fileKey);
  }

  const systemPath = repository.fileSystemPaths[destination.filePath];
  if (!systemPath) {
    throw new Error(`File "${destination.filePath}" is not declared in this repository`);
  }

  return {
    document: repository.loadFile(destination.filePath),
    filePath: destination.filePath,
    systemPath,
    scope: "repository",
  };
}

export interface V3TargetRuntimeSelection {
  repository: HushV3Repository;
  targetName: string;
  target: HushTargetDefinition;
  activeIdentity: string;
}

export interface V3ResolvedEnvView extends V3TargetRuntimeSelection {
  resolution: HushTargetResolution;
  envVars: EnvVar[];
  env: Record<string, string>;
  files: string[];
  logicalPaths: string[];
  localOverrideFile?: string;
  shadowed: HushShadowedEnvVar[];
}

interface LegacyMigrationTargetMetadata {
  name: string;
  path: string;
  push_to?: PushConfig | null;
}

interface V3DeploymentContext {
  cwd: string;
  pushTo?: PushConfig | null;
}

function parseYamlObject(filePath: string, content: string): unknown {
  const parsed = parseYaml(content);

  if (parsed === null || parsed === undefined || typeof parsed !== "object") {
    throw new Error(`Expected YAML object in ${filePath}`);
  }

  return parsed;
}

function readPlainYamlObject(ctx: HushContext, filePath: string): unknown {
  const raw = ctx.fs.readFileSync(filePath, "utf-8");
  const content = typeof raw === "string" ? raw : raw.toString("utf-8");
  return parseYamlObject(filePath, content);
}

function createRepositoryFileDocument(
  repository: HushV3Repository,
  filePath: string,
): HushFileDocument {
  const sharedReaders = repository.filesByPath[DEFAULT_V3_FILE_PATHS.shared]?.readers;

  return createFileDocument({
    path: filePath,
    readers: sharedReaders ?? {
      roles: ["owner", "member", "ci"],
      identities: [],
    },
    sensitive: true,
    entries: {},
  });
}

function createLocalOverrideDocument(): HushFileDocument {
  return createFileDocument({
    path: MACHINE_LOCAL_FILE_PATH,
    readers: {
      roles: ["owner", "member", "ci"],
      identities: [],
    },
    sensitive: true,
    entries: {},
  });
}

function envVarKeyToLogicalPath(filePath: string, key: string): string {
  const normalizedKey = key.trim();

  if (!normalizedKey) {
    throw new Error("Secret key cannot be empty");
  }

  return `${filePath}/${normalizedKey}`;
}

/**
 * Precedence of the machine-local layer.
 *
 * Repository files resolve at 200 (local) and 100 (imported), and
 * `importPrecedence` can swap those two. Nothing reachable from configuration
 * reaches this number, so the machine-local layer cannot be tied — and an
 * equal-precedence tie is a hard resolution error the user could not act on.
 *
 * It is a backstop rather than the mechanism: `user/**` is reserved, so a
 * machine-local logical path never contends with a repository one in the first
 * place.
 */
const MACHINE_LOCAL_PRECEDENCE = 1000;

/**
 * Read the machine-local override store as resolver candidates.
 *
 * Value entries only, matching what the machine-local store can express: it is
 * written exclusively by `hush set --repo-local`, which writes scalars. Passing
 * an artifact entry through would let a per-machine file start materializing
 * artifacts onto disk, which is not something any command offers a way to
 * create or remove.
 */
export function collectMachineLocalCandidates(
  ctx: HushContext,
  store: StoreContext,
): HushSelectedEntryCandidate[] {
  const document = loadMachineLocalOverrides(ctx, store);

  if (!document) {
    return [];
  }

  return Object.entries(document.entries)
    .filter(([, entry]) => !("type" in entry))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([logicalPath, entry]) => ({
      path: logicalPath,
      entry: entry as HushFileEntry,
      precedence: MACHINE_LOCAL_PRECEDENCE,
      provenance: [
        createProvenanceRecord({
          logicalPath,
          filePath: MACHINE_LOCAL_FILE_PATH,
          namespace: getNamespaceFromPath(logicalPath),
        }),
      ],
    }));
}

export function requireV3Repository(store: StoreContext, commandName: string): HushV3Repository {
  if (!isV3RepositoryRoot(store.root)) {
    const projectInfo = findProjectRoot(store.root);
    if (projectInfo?.repositoryKind === "legacy-v2") {
      throw new Error(
        `The "${commandName}" command now requires a v3 repository rooted at .hush/. ` +
          `This project still uses legacy runtime authority at ${projectInfo.configPath}. Bootstrap or migrate before using this command.`,
      );
    }

    throw new Error(
      `The "${commandName}" command now requires a v3 repository rooted at .hush/. ` +
        "Bootstrap or migrate before using this command.",
    );
  }

  return loadV3Repository(store.root, { keyIdentity: store.keyIdentity });
}

export function createMigrationOnlyCommandError(commandName: string): Error {
  return new Error(
    `The "${commandName}" command is retired. Legacy plaintext and dual-runtime helpers now run only through "hush migrate --from v2". ` +
      "Use the migration flow to inventory or convert a legacy hush.yaml repository.",
  );
}

export function selectRuntimeTarget(
  repository: HushV3Repository,
  requestedTarget?: string,
): { targetName: string; target: HushTargetDefinition } {
  const targets = repository.manifest.targets ?? {};

  if (requestedTarget) {
    const selected = targets[requestedTarget];
    if (!selected) {
      throw new Error(
        `Target "${requestedTarget}" not found. Available targets: ${Object.keys(targets).sort().join(", ") || "(none)"}`,
      );
    }

    return { targetName: requestedTarget, target: selected };
  }

  if (targets.runtime) {
    return { targetName: "runtime", target: targets.runtime };
  }

  const nonExampleTargets = Object.entries(targets).filter(
    ([, target]) => target.mode !== "example",
  );
  const candidates = nonExampleTargets.length > 0 ? nonExampleTargets : Object.entries(targets);

  if (candidates.length === 1) {
    const [targetName, target] = candidates[0]!;
    return { targetName, target };
  }

  if (candidates.length === 0) {
    throw new Error(
      'No v3 targets are declared in this repository. Add a target with "hush config" or re-bootstrap the repo.',
    );
  }

  throw new Error(
    `Multiple v3 targets are available (${candidates.map(([name]) => name).join(", ")}). Use --target to choose one explicitly.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getLegacyMigrationTargetMetadata(
  repository: HushV3Repository,
): LegacyMigrationTargetMetadata[] {
  const metadata = repository.manifest.metadata;
  if (!isRecord(metadata)) {
    return [];
  }

  const legacyMigration = metadata.legacyMigration;
  if (!isRecord(legacyMigration) || !Array.isArray(legacyMigration.targets)) {
    return [];
  }

  return legacyMigration.targets.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.path !== "string") {
      return [];
    }

    const pushTo = entry.push_to;
    return [
      {
        name: entry.name,
        path: entry.path,
        push_to: isPushConfig(pushTo) ? pushTo : null,
      },
    ];
  });
}

function isPushConfig(value: unknown): value is PushConfig {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "cloudflare-workers") {
    return true;
  }

  if (value.type === "vercel") {
    return (
      typeof value.projectId === "string" &&
      Array.isArray(value.environments) &&
      value.environments.length > 0 &&
      value.environments.every(
        (environment) =>
          environment === "production" ||
          environment === "preview" ||
          environment === "development",
      ) &&
      (value.token === undefined || typeof value.token === "string") &&
      (value.teamId === undefined || typeof value.teamId === "string")
    );
  }

  return value.type === "cloudflare-pages" && typeof value.project === "string";
}

function getLegacyTargetMetadataForName(
  repository: HushV3Repository,
  targetName: string,
): LegacyMigrationTargetMetadata | undefined {
  const legacyTargets = getLegacyMigrationTargetMetadata(repository);
  const exactMatch = legacyTargets.find((target) => target.name === targetName);
  if (exactMatch) {
    return exactMatch;
  }

  return legacyTargets.find((target) => `${target.name}-production` === targetName);
}

function isWithinPath(parentPath: string, candidatePath: string): boolean {
  const pathDelta = relative(parentPath, candidatePath);
  return pathDelta === "" || (!pathDelta.startsWith("..") && pathDelta !== ".");
}

export function selectRuntimeTargetForCommand(
  repository: HushV3Repository,
  store: StoreContext,
  command: { name: string; args: string[]; supportsTargetFlag?: boolean },
  requestedTarget?: string,
  currentWorkingDirectory?: string,
): { targetName: string; target: HushTargetDefinition } {
  if (requestedTarget) {
    return selectRuntimeTarget(repository, requestedTarget);
  }

  try {
    return selectRuntimeTarget(repository, undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("Multiple v3 targets are available")) {
      throw error;
    }
  }

  const cwd = resolve(currentWorkingDirectory ?? store.root);
  const legacyMatches = getLegacyMigrationTargetMetadata(repository)
    .filter((target) => isWithinPath(resolve(store.root, target.path), cwd))
    .sort((left, right) => right.path.length - left.path.length);

  if (legacyMatches.length > 0) {
    const targetName = legacyMatches[0]!.name;
    const target = repository.manifest.targets?.[targetName];
    if (target) {
      return { targetName, target };
    }
  }

  const availableTargets = Object.keys(repository.manifest.targets ?? {}).sort();
  const resolutionHint = command.supportsTargetFlag
    ? `Choose one explicitly with --target <name>, or run it from a migrated target directory, or add a runtime target for the repository root.`
    : `${command.name} does not accept --target yet, so run it from a migrated target directory or add a runtime target for the repository root.`;
  throw new Error(
    `Multiple v3 targets are available (${availableTargets.join(", ")}). ${resolutionHint}`,
  );
}

export function resolveTargetDeploymentContext(
  store: StoreContext,
  repository: HushV3Repository,
  targetName: string,
): V3DeploymentContext {
  const legacyTarget = getLegacyTargetMetadataForName(repository, targetName);

  return {
    cwd: legacyTarget ? resolve(store.root, legacyTarget.path) : store.root,
    pushTo: legacyTarget?.push_to,
  };
}

export function getMachineLocalOverridePath(store: StoreContext): string {
  const statePaths = getProjectStatePaths(store);
  return join(statePaths.projectRoot, "user", LOCAL_OVERRIDE_FILENAME);
}

/**
 * Normalize a machine-local override document onto `user/local`.
 *
 * The document's `path` field is a label, not an address: the address is the
 * fixed state-root filesystem path, the store is per-machine and unshared, and
 * no bundle can reference it. Documents written before the `user/**` split
 * carry `path: env/project/local`, which collided with a committed repository
 * file of the same name. Rewriting the label (and re-keying entries onto it) on
 * load makes that collision impossible without migrating any data.
 */
function normalizeMachineLocalDocument(parsed: HushFileDocument): HushFileDocument {
  const persistedPath =
    typeof parsed.path === "string" ? normalizeHushPath(parsed.path) : MACHINE_LOCAL_FILE_PATH;
  if (persistedPath === MACHINE_LOCAL_FILE_PATH) {
    return parsed;
  }

  const entries = Object.fromEntries(
    Object.entries(parsed.entries ?? {}).map(([logicalPath, entry]) => [
      envVarKeyToLogicalPath(
        MACHINE_LOCAL_FILE_PATH,
        logicalPath.split("/").filter(Boolean).at(-1) ?? logicalPath,
      ),
      entry,
    ]),
  );

  return { ...parsed, path: MACHINE_LOCAL_FILE_PATH, entries };
}

/**
 * Read the machine-local override document for this store.
 *
 * MUST stay symmetric with `writeMachineLocalOverrides`: the writer persists
 * for every store mode, so the reader must look in every store mode too. An
 * earlier `store.mode === 'global'` early-return here made `hush set --global
 * --repo-local` a silent no-op — the write landed on disk and no read path
 * ever looked at it.
 */
export function loadMachineLocalOverrides(
  ctx: HushContext,
  store: StoreContext,
): HushFileDocument | null {
  const overridePath = getMachineLocalOverridePath(store);
  if (!ctx.fs.existsSync(overridePath)) {
    return null;
  }

  try {
    const content = ctx.sops.decryptYaml(overridePath, {
      root: store.root,
      keyIdentity: store.keyIdentity,
    });
    return createFileDocument(
      normalizeMachineLocalDocument(parseYamlObject(overridePath, content) as HushFileDocument),
    );
  } catch (error) {
    // An environment failure is NOT a corrupt file. Relabeling a transient
    // SopsPreflightTimeoutError as "Invalid machine-local override file" sent
    // ch5-managed-runtime setup chasing file corruption for hours on 2026-07-25
    // when the real cause was a starved `sops --version`. Let a typed sops
    // failure propagate with its own diagnosis intact.
    if (error instanceof SopsPreflightTimeoutError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid machine-local override file at ${overridePath}: ${message}`, {
      cause: error,
    });
  }
}

export function writeMachineLocalOverrides(
  ctx: HushContext,
  store: StoreContext,
  document: HushFileDocument,
): string {
  const filePath = getMachineLocalOverridePath(store);
  const parentDir = join(getProjectStatePaths(store).projectRoot, "user");
  ctx.fs.mkdirSync(parentDir, { recursive: true });
  ctx.sops.encryptYamlContent(stringifyYaml(document, { indent: 2 }), filePath, {
    root: store.root,
    keyIdentity: store.keyIdentity,
  });
  return filePath;
}

export interface EditableFileDocument {
  document: HushFileDocument;
  filePath: string;
  systemPath: string;
  scope: EditableScope;
}

/**
 * Load the machine-local override document, creating it on disk when absent so
 * callers (notably `edit`) always get a real `systemPath`.
 */
export function ensureMachineLocalDocument(
  ctx: HushContext,
  store: StoreContext,
): EditableFileDocument {
  const document = loadMachineLocalOverrides(ctx, store) ?? createLocalOverrideDocument();
  const systemPath = writeMachineLocalOverrides(ctx, store, document);
  return {
    document,
    filePath: document.path,
    systemPath,
    scope: "machine-local",
  };
}

export function ensureEditableFileDocument(
  ctx: HushContext,
  store: StoreContext,
  repository: HushV3Repository,
  fileKey: FileKey,
): EditableFileDocument {
  const filePath = DEFAULT_V3_FILE_PATHS[fileKey];
  const existing = repository.filesByPath[filePath];
  if (existing) {
    return {
      document: repository.loadFile(filePath),
      filePath,
      systemPath: repository.fileSystemPaths[filePath]!,
      scope: "repository",
    };
  }

  const document = createRepositoryFileDocument(repository, filePath);
  const systemPath = getV3EncryptedFilePath(store.root, filePath);
  ctx.fs.mkdirSync(join(store.root, ".hush", "files", ...filePath.split("/").slice(0, -1)), {
    recursive: true,
  });
  persistV3FileDocument(ctx, store, repository, systemPath, document);
  return {
    document,
    filePath,
    systemPath,
    scope: "repository",
  };
}

export function setEnvValueInDocument(
  document: HushFileDocument,
  key: string,
  value: string,
): HushFileDocument {
  const logicalPath = envVarKeyToLogicalPath(document.path, key);
  return createFileDocument({
    ...document,
    entries: {
      ...document.entries,
      [logicalPath]: {
        value,
        sensitive: true,
      },
    },
  });
}

export function writeEditableFileDocument(
  ctx: HushContext,
  store: StoreContext,
  repository: HushV3Repository,
  systemPath: string,
  document: HushFileDocument,
): void {
  persistV3FileDocument(ctx, store, repository, systemPath, document);
}

export interface EditableWriteTarget {
  filePath: string;
  scope: EditableScope;
}

export interface LegacyLocalRepositoryFile {
  filePath: string;
  entryCount: number;
  bundles: string[];
}

/**
 * Detect a committed repository file still named `env/project/local`.
 *
 * Legal — it is now an ordinary repository file — but almost never what the
 * operator meant: it is encrypted to every identity in its reader set and
 * committed to git, while its name says "local". Surfaced by `doctor` and by
 * every mutating command that touches it, because the disclosure it implies
 * cannot be undone by renaming: git history keeps the ciphertext and readers
 * already hold the age keys, so the remedy is rotation.
 */
export function findLegacyLocalRepositoryFile(
  repository: HushV3Repository,
): LegacyLocalRepositoryFile | null {
  const entry = repository.filesByPath[LEGACY_MACHINE_LOCAL_FILE_PATH];
  if (!entry) {
    return null;
  }

  const bundles = Object.entries(repository.manifest.bundles ?? {})
    .filter(([, bundle]) =>
      (bundle.files ?? []).some((ref) => ref.path === LEGACY_MACHINE_LOCAL_FILE_PATH),
    )
    .map(([bundleName]) => bundleName)
    .sort();

  return {
    filePath: LEGACY_MACHINE_LOCAL_FILE_PATH,
    entryCount: entry.logicalPaths.length,
    bundles,
  };
}

export function describeLegacyLocalRepositoryFile(finding: LegacyLocalRepositoryFile): string {
  const reach =
    finding.bundles.length > 0
      ? `it is bundled into ${finding.bundles.join(", ")}, so every collaborator resolves its values`
      : "no bundle selects it, so it does not resolve at runtime";

  return (
    `"${finding.filePath}" is a committed repository file, not machine-local storage. ` +
    `It holds ${finding.entryCount} entry(ies), is decryptable by every identity in its reader set, and ${reach}. ` +
    `Machine-local overrides live at "${MACHINE_LOCAL_FILE_PATH}" and are written with "hush set --repo-local". ` +
    "If any value here was meant to stay on one machine, treat it as disclosed: rotate it, then move the rest with " +
    `"hush copy-key <KEY> --from ${finding.filePath} --to <destination>" and drop the file with ` +
    `"hush file remove ${finding.filePath}".`
  );
}

/**
 * Re-read a just-written logical path from durable storage, using the SAME
 * reader the runtime resolution path uses for that scope.
 *
 * Machine-local writes are read back through `loadMachineLocalOverrides` and
 * repository writes through a freshly loaded repository (never the caller's
 * in-memory repository, whose file cache would happily echo a document that
 * was never persisted). Returns `undefined` when the value is not readable.
 */
export function readBackEditableValue(
  ctx: HushContext,
  store: StoreContext,
  target: EditableWriteTarget,
  key: string,
): string | undefined {
  const document =
    target.scope === "machine-local"
      ? loadMachineLocalOverrides(ctx, store)
      : loadV3Repository(store.root, { keyIdentity: store.keyIdentity }).loadFile(target.filePath);

  if (!document) {
    return undefined;
  }

  const entry = document.entries[envVarKeyToLogicalPath(target.filePath, key)];
  if (!entry || "type" in entry || typeof entry.value !== "string") {
    return undefined;
  }

  return entry.value;
}

/**
 * Fail-loud write verification. A secrets tool that prints success without
 * proving the value is readable is worse than one that errors, so every `set`
 * write is confirmed against durable storage before any success line is
 * emitted. Never includes the secret value in the error message.
 */
export function assertEditableValuePersisted(
  ctx: HushContext,
  store: StoreContext,
  target: EditableWriteTarget,
  key: string,
  expectedValue: string,
): void {
  let persisted: string | undefined;

  try {
    persisted = readBackEditableValue(ctx, store, target, key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Write verification failed for ${key} in ${target.filePath} (${target.scope}): ` +
        `the value could not be read back after writing (${message}). Nothing was reported as saved.`,
      { cause: error },
    );
  }

  if (persisted === undefined) {
    throw new Error(
      `Write verification failed for ${key} in ${target.filePath} (${target.scope}): ` +
        "the value is missing when read back from durable storage. " +
        "The write did not persist; do not treat this secret as saved.",
    );
  }

  if (persisted !== expectedValue) {
    throw new Error(
      `Write verification failed for ${key} in ${target.filePath} (${target.scope}): ` +
        "the value read back from durable storage does not match the value written. " +
        "Do not treat this secret as saved.",
    );
  }
}

/**
 * Second-order check after a verified write: the value is durably stored, but
 * does the runtime target actually select the file it landed in?
 *
 * This is a warning rather than an error because writing into a file the
 * current target does not resolve is legitimate (stage-split production and
 * staging files are written from a development checkout all the time). It
 * exists so the common misconfiguration — a declared file that no bundle
 * includes — stops looking like a fully successful write.
 *
 * Returns `undefined` when the value resolves, or when resolution cannot be
 * determined at all; never throws.
 */
export function describeUnresolvedWrite(
  ctx: HushContext,
  store: StoreContext,
  key: string,
  filePath: string,
): string | undefined {
  try {
    const view = resolveTargetEnvView(ctx, store, undefined, { name: "set", args: [key] });
    if (view.envVars.some((variable) => variable.key === key)) {
      return undefined;
    }

    return (
      `${key} is stored in ${filePath}, but target "${view.targetName}" does not resolve that file, ` +
      `so "hush get ${key}" will not return it here. ` +
      `Add ${filePath} to that target's bundle, or run "hush trace ${key}" to see which targets select it.`
    );
  } catch {
    // Resolution is unavailable (no runtime target, ambiguous target, unreadable
    // file). The write itself is already verified, so stay quiet.
    return undefined;
  }
}

export function openEditor(ctx: HushContext, systemPath: string, editorOverride?: string): void {
  const resolvedEditor = editorOverride ?? ctx.process.env.EDITOR ?? "vi";
  ctx.logger.info(pc.dim(`Using editor: ${resolvedEditor}`));
  const [bin, ...editorArgs] = resolvedEditor.split(/\s+/);
  ctx.exec.spawnSync(bin, [...editorArgs, systemPath], { stdio: "inherit" });
}

export function validateEditedFileDocument(ctx: HushContext, systemPath: string): HushFileDocument {
  return createFileDocument(readPlainYamlObject(ctx, systemPath) as HushFileDocument);
}

function createPrivateTempYaml(): { tempDir: string; tempPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "hush-edit-"));
  const tempPath = join(tempDir, "document.yaml");
  chmodSync(tempDir, 0o700);
  return { tempDir, tempPath };
}

export function openEncryptedDocumentEditor(
  ctx: HushContext,
  store: StoreContext,
  systemPath: string,
  repository?: HushV3Repository,
  editorOverride?: string,
): HushFileDocument {
  const { tempDir, tempPath } = createPrivateTempYaml();

  try {
    const decrypted = ctx.sops.decryptYaml(systemPath, {
      root: store.root,
      keyIdentity: store.keyIdentity,
    });
    writeFileSync(tempPath, decrypted, { encoding: "utf-8", mode: 0o600 });
    chmodSync(tempPath, 0o600);
    openEditor(ctx, tempPath, editorOverride);
    const document = validateEditedFileDocument(ctx, tempPath);
    if (repository) {
      persistV3FileDocument(ctx, store, repository, systemPath, document);
    } else {
      ctx.sops.encryptYamlContent(stringifyYaml(document, { indent: 2 }), systemPath, {
        root: store.root,
        keyIdentity: store.keyIdentity,
      });
    }
    return document;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function resolveTargetEnvView(
  ctx: HushContext,
  store: StoreContext,
  requestedTarget: string | undefined,
  command: { name: string; args: string[]; supportsTargetFlag?: boolean },
): V3ResolvedEnvView {
  const repository = requireV3Repository(store, command.name);
  const activeIdentity = requireActiveIdentity(ctx, store, repository.manifest.identities, command);
  const { targetName, target } = selectRuntimeTargetForCommand(
    repository,
    store,
    command,
    requestedTarget,
    ctx.process.cwd(),
  );
  // Machine-local overrides are a property of resolution, not of this wrapper.
  // They used to be post-merged here, which is exactly why `hush run` — which
  // resolves without going through this function — never saw them.
  const resolution = resolveV3Target(ctx, {
    store,
    repository,
    importedRepositories: loadImportedRepositories(repository),
    targetName,
    command,
    machineLocal: "include",
  });
  // Value-producing path: a machine-local override that shadows a repository
  // value is refused unless the operator opts in for this invocation. See
  // HushLocalOverrideShadowError for why silence here is the expensive default.
  const shaped = shapeTargetArtifacts(targetName, target, resolution, shadowPolicyFromEnv(ctx));
  const logicalPaths = [
    ...Object.keys(resolution.values),
    ...Object.keys(resolution.artifacts),
  ].sort();

  return {
    repository,
    targetName,
    target,
    activeIdentity,
    resolution,
    envVars: shaped.envVars,
    env: shaped.env,
    files: resolution.files,
    logicalPaths,
    localOverrideFile: resolution.files.includes(MACHINE_LOCAL_FILE_PATH)
      ? MACHINE_LOCAL_FILE_PATH
      : undefined,
    shadowed: shaped.shadowed,
  };
}

function getCompactSource(record: HushProvenanceRecord): string {
  return record.filePath;
}

function getCompactPrecedence(node: Pick<HushResolvedNode, "provenance">): number {
  return Math.max(node.provenance.length - 1, 0);
}

export function toCompactRecord(
  key: string,
  target: string,
  node: Pick<HushResolvedNode, "provenance">,
): HushCompactRecord {
  const primarySource = node.provenance.at(-1) ?? node.provenance[0];

  return {
    key,
    source: primarySource ? getCompactSource(primarySource) : "-",
    target,
    precedence: getCompactPrecedence(node),
  };
}

export function formatCompactRecord(record: HushCompactRecord): string {
  return `  ${pc.cyan(record.key)} ${pc.dim(`source=${record.source} target=${record.target} precedence=${record.precedence}`)}`;
}

export function appendCommandReadAudit(
  ctx: HushContext,
  store: StoreContext,
  view: Pick<
    V3ResolvedEnvView,
    "activeIdentity" | "files" | "logicalPaths" | "targetName" | "resolution"
  >,
  command: { name: string; args: string[] },
): void {
  appendAuditEvent(ctx, store, {
    type: "read_attempt",
    activeIdentity: view.activeIdentity,
    success: true,
    command,
    files: view.files,
    logicalPaths: view.logicalPaths,
    bundle: view.resolution.bundle,
    target: view.targetName,
  });
}

export function requireMutableIdentity(
  ctx: HushContext,
  store: StoreContext,
  repository: HushV3Repository,
  command: { name: string; args: string[] },
): string {
  const activeIdentity = requireActiveIdentity(ctx, store, repository.manifest.identities, command);
  const identityRecord = repository.manifest.identities[activeIdentity];

  if (!identityRecord?.roles.includes("owner")) {
    appendAuditEvent(ctx, store, {
      type: "access_denied",
      activeIdentity,
      requestedIdentity: activeIdentity,
      success: false,
      command,
      reason: `Active identity "${activeIdentity}" must have the owner role to mutate v3 repository data`,
    });

    throw new Error(
      `Active identity "${activeIdentity}" must have the owner role to mutate v3 repository data`,
    );
  }

  return activeIdentity;
}

export function readCurrentIdentity(ctx: HushContext, store: StoreContext): string | undefined {
  try {
    return getActiveIdentity(ctx, store) ?? undefined;
  } catch {
    return undefined;
  }
}

export function formatDuplicateKeyHint(key: string, files: string[], target: string): string {
  const fileList = files.map((f) => `  - ${f}`).join("\n");
  const precedence = files.map((f, i) => `  ${i + 1}. ${f}`).join("\n");

  return `\n\nTo fix this duplicate key conflict:\n\n1. Choose which file should own the key\n2. Remove the duplicate from the other file(s):\n\n   hush move-key ${key} --from <source> --to <destination>\n   # or\n   hush delete-key ${key} --from <file-to-remove-from>\n\nFiles containing the duplicate:\n${fileList}\n\nPrecedence order for target "${target}":\n${precedence}\n\nKeys in earlier files take precedence when the same key exists in multiple files.`;
}
