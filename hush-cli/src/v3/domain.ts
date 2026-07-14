import {
  assertHushRole,
  assertNamespacedPath,
  assertRoleList,
  getNamespaceFromPath,
  type HushNamespace,
  type HushRole,
  V3_SCHEMA_VERSION,
} from './schema.js';

export type HushIdentityName = string;
export type HushBundleName = string;
export type HushTargetName = string;
export type HushImportName = string;
export type HushLogicalPath = string;
export type HushFilePath = string;
export type HushArtifactFormat =
  | 'dotenv'
  | 'wrangler'
  | 'json'
  | 'shell'
  | 'yaml'
  | 'env'
  | 'binary'
  | (string & {});

export type HushScalarValue =
  | string
  | number
  | boolean
  | null
  | HushScalarValue[]
  | { [key: string]: HushScalarValue };

export interface HushIdentityRecord {
  roles: HushRole[];
  description?: string;
}

export interface HushReaders {
  roles: HushRole[];
  identities: HushIdentityName[];
}

export interface HushValueEntry {
  value: HushScalarValue;
  sensitive: boolean;
}

export interface HushArtifactFileEntry {
  type: 'file';
  format: HushArtifactFormat;
  sensitive: boolean;
  value?: string;
  filename?: string;
  subpath?: string;
  materializeAs?: string;
}

export interface HushArtifactBinaryEntry {
  type: 'binary';
  format: HushArtifactFormat;
  sensitive: boolean;
  value?: string;
  encoding?: 'base64' | 'utf8';
  filename?: string;
  subpath?: string;
  materializeAs?: string;
}

export type HushArtifactEntry = HushArtifactFileEntry | HushArtifactBinaryEntry;
export type HushFileEntry = HushValueEntry | HushArtifactEntry;

export interface HushFileDocument {
  path: HushFilePath;
  readers: HushReaders;
  sensitive: boolean;
  entries: Record<HushLogicalPath, HushFileEntry>;
}

export interface HushFileIndexEntry {
  path: HushFilePath;
  readers: HushReaders;
  sensitive: boolean;
  logicalPaths: HushLogicalPath[];
}

export interface HushBundleFileRef {
  path: HushFilePath;
}

export interface HushBundleImportRef {
  bundle?: HushBundleName | HushLogicalPath;
  file?: HushFilePath;
  project?: HushImportName;
}

export interface HushImportPullSpec {
  bundles?: HushLogicalPath[];
  files?: HushFilePath[];
  artifacts?: HushLogicalPath[];
}

export interface HushImportDefinition {
  project: string;
  /** Absolute source repository root, stored inside the encrypted manifest. */
  sourceRoot?: string;
  pull: HushImportPullSpec;
}

export interface HushBundleDefinition {
  files?: HushBundleFileRef[];
  imports?: HushBundleImportRef[];
  paths?: HushLogicalPath[];
}

export interface HushTargetDefinition {
  bundle?: HushBundleName;
  path?: HushLogicalPath;
  format: HushArtifactFormat;
  mode?: 'process' | 'file' | 'example';
  filename?: string;
  subpath?: string;
  materializeAs?: string;
}

export interface HushManifestDocument {
  version: typeof V3_SCHEMA_VERSION;
  activeIdentity?: HushIdentityName;
  identities: Record<HushIdentityName, HushIdentityRecord>;
  fileIndex?: Record<HushFilePath, HushFileIndexEntry>;
  imports?: Record<HushImportName, HushImportDefinition>;
  bundles?: Record<HushBundleName, HushBundleDefinition>;
  targets?: Record<HushTargetName, HushTargetDefinition>;
  metadata?: Record<string, HushScalarValue>;
}

export interface HushProvenanceImportRecord {
  project: string;
  bundle?: HushLogicalPath;
  file?: HushFilePath;
}

export interface HushProvenanceRecord {
  logicalPath: HushLogicalPath;
  namespace: HushNamespace;
  filePath: HushFilePath;
  bundle?: HushBundleName;
  import?: HushProvenanceImportRecord;
}

export interface HushResolvedValue {
  path: HushLogicalPath;
  entry: HushFileEntry;
  provenance: HushProvenanceRecord[];
}

export interface HushBundleConflict {
  path: HushLogicalPath;
  contenders: HushProvenanceRecord[];
}

export interface HushResolverResult {
  identity: HushIdentityName;
  bundle?: HushBundleName;
  values: Record<HushLogicalPath, HushResolvedValue>;
  artifacts: Record<HushLogicalPath, HushResolvedValue>;
  unreadableFiles: HushFilePath[];
  conflicts: HushBundleConflict[];
}

function assertIdentityName(name: string, label: string): string {
  const trimmed = name.trim();

  if (!trimmed) {
    throw new Error(`${label} cannot be empty`);
  }

  return trimmed;
}

function assertIdentityList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => assertIdentityName(value, 'Identity'));
}

function assertEntry(entry: HushFileEntry): HushFileEntry {
  if ('type' in entry) {
    if (!entry.format) {
      throw new Error('Artifact entries require a format');
    }

    const normalized = normalizeMaterializationHints(entry);

    return normalized;
  }

  return entry;
}

function normalizeMaterializationPath(path: string | undefined, label: string): string | undefined {
  if (path === undefined) {
    return undefined;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty`);
  }

  if (trimmed.startsWith('/')) {
    throw new Error(`${label} must be a relative path`);
  }

  const segments = trimmed.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`${label} cannot be empty`);
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error(`${label} cannot contain "." or ".." segments`);
    }
  }

  return segments.join('/');
}

type HushMaterializationHints = {
  filename?: string;
  subpath?: string;
  materializeAs?: string;
};

function normalizeMaterializationHints<T extends HushMaterializationHints>(value: T): T {
  return {
    ...value,
    filename: normalizeMaterializationPath(value.filename, 'Artifact filename'),
    subpath: normalizeMaterializationPath(value.subpath, 'Artifact subpath'),
    materializeAs: normalizeMaterializationPath(value.materializeAs, 'Artifact materializeAs'),
  };
}

export function createIdentityRecord(identity: HushIdentityRecord): HushIdentityRecord {
  return {
    ...identity,
    roles: assertRoleList(identity.roles),
  };
}

export function createReaders(readers: HushReaders): HushReaders {
  return {
    roles: assertRoleList(readers.roles),
    identities: assertIdentityList(readers.identities),
  };
}

export function createFileDocument(file: HushFileDocument): HushFileDocument {
  const normalizedPath = assertNamespacedPath(file.path);
  const fileNamespace = getNamespaceFromPath(normalizedPath);
  const entries = Object.fromEntries(
    Object.entries(file.entries).map(([logicalPath, entry]) => {
      const normalizedLogicalPath = assertNamespacedPath(logicalPath);
      const logicalNamespace = getNamespaceFromPath(normalizedLogicalPath);

      if (logicalNamespace !== fileNamespace) {
        throw new Error(
          `Entry path "${normalizedLogicalPath}" must stay inside file namespace "${fileNamespace}"`,
        );
      }

      return [normalizedLogicalPath, assertEntry(entry)];
    }),
  );

  return {
    ...file,
    path: normalizedPath,
    readers: createReaders(file.readers),
    entries,
  };
}

export function createFileIndexEntry(file: HushFileDocument): HushFileIndexEntry {
  return {
    path: file.path,
    readers: createReaders(file.readers),
    sensitive: file.sensitive,
    logicalPaths: Object.keys(file.entries)
      .map(assertNamespacedPath)
      .sort((left, right) => left.localeCompare(right)),
  };
}

function createManifestFileIndex(index: Record<HushFilePath, HushFileIndexEntry> | undefined): Record<HushFilePath, HushFileIndexEntry> | undefined {
  if (!index) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(index).map(([path, entry]) => [
      assertNamespacedPath(path),
      {
        path: assertNamespacedPath(path),
        readers: createReaders(entry.readers),
        sensitive: Boolean(entry.sensitive),
        logicalPaths: (entry.logicalPaths ?? [])
          .map(assertNamespacedPath)
          .sort((left, right) => left.localeCompare(right)),
      },
    ]),
  );
}

export function createImportDefinition(definition: HushImportDefinition): HushImportDefinition {
  const pull = definition.pull ?? {};
  const sourceRoot = definition.sourceRoot?.trim();

  if (sourceRoot && !sourceRoot.startsWith('/')) {
    throw new Error('Import sourceRoot must be an absolute path');
  }

  return {
    ...definition,
    project: assertIdentityName(definition.project, 'Import project'),
    sourceRoot,
    pull: {
      bundles: (pull.bundles ?? []).map(assertNamespacedPath),
      files: (pull.files ?? []).map(assertNamespacedPath),
      artifacts: (pull.artifacts ?? []).map(assertNamespacedPath),
    },
  };
}

export function createBundleDefinition(bundle: HushBundleDefinition): HushBundleDefinition {
  return {
    ...bundle,
    files: (bundle.files ?? []).map((file) => ({ path: assertNamespacedPath(file.path) })),
    imports: (bundle.imports ?? []).map((value) => ({
      ...value,
      bundle: value.bundle,
      file: value.file ? assertNamespacedPath(value.file) : value.file,
      project: value.project ? assertIdentityName(value.project, 'Import name') : value.project,
    })),
    paths: (bundle.paths ?? []).map(assertNamespacedPath),
  };
}

export function createTargetDefinition(target: HushTargetDefinition): HushTargetDefinition {
  if (!target.bundle && !target.path) {
    throw new Error('Target must reference a bundle or logical path');
  }

  if (!target.format) {
    throw new Error('Target format is required');
  }

  return normalizeMaterializationHints({
    ...target,
    bundle: target.bundle ? assertIdentityName(target.bundle, 'Bundle name') : target.bundle,
    path: target.path ? assertNamespacedPath(target.path) : target.path,
  });
}

export function createManifestDocument(manifest: HushManifestDocument): HushManifestDocument {
  if (manifest.version !== V3_SCHEMA_VERSION) {
    throw new Error(`Manifest version must be ${V3_SCHEMA_VERSION}`);
  }

  const identities = Object.fromEntries(
    Object.entries(manifest.identities).map(([name, identity]) => [
      assertIdentityName(name, 'Identity name'),
      createIdentityRecord(identity),
    ]),
  );

  if (manifest.activeIdentity) {
    const activeIdentity = assertIdentityName(manifest.activeIdentity, 'Active identity');

    if (!(activeIdentity in identities)) {
      throw new Error(`Active identity "${activeIdentity}" is not declared in identities`);
    }
  }

  return {
    ...manifest,
    identities,
    fileIndex: createManifestFileIndex(manifest.fileIndex),
    imports: manifest.imports
      ? Object.fromEntries(
          Object.entries(manifest.imports).map(([name, value]) => [
            assertIdentityName(name, 'Import name'),
            createImportDefinition(value),
          ]),
        )
      : undefined,
    bundles: manifest.bundles
      ? Object.fromEntries(
          Object.entries(manifest.bundles).map(([name, value]) => [
            assertIdentityName(name, 'Bundle name'),
            createBundleDefinition(value),
          ]),
        )
      : undefined,
    targets: manifest.targets
      ? Object.fromEntries(
          Object.entries(manifest.targets).map(([name, value]) => [
            assertIdentityName(name, 'Target name'),
            createTargetDefinition(value),
          ]),
        )
      : undefined,
  };
}

export function isIdentityAllowed(readers: HushReaders, identity: HushIdentityName, role: HushRole): boolean {
  return readers.identities.includes(identity) || readers.roles.includes(assertHushRole(role));
}

export function upsertManifestFileIndexEntry(
  manifest: HushManifestDocument,
  filePath: HushFilePath,
  entry: HushFileIndexEntry,
): HushManifestDocument {
  return createManifestDocument({
    ...manifest,
    fileIndex: {
      ...(manifest.fileIndex ?? {}),
      [filePath]: entry,
    },
  });
}

export function createProvenanceRecord(record: HushProvenanceRecord): HushProvenanceRecord {
  const logicalPath = assertNamespacedPath(record.logicalPath);
  const filePath = assertNamespacedPath(record.filePath);

  return {
    ...record,
    logicalPath,
    filePath,
    namespace: getNamespaceFromPath(logicalPath),
    bundle: record.bundle ? assertIdentityName(record.bundle, 'Bundle name') : record.bundle,
    import: record.import
      ? {
          project: assertIdentityName(record.import.project, 'Import project'),
          bundle: record.import.bundle ? assertNamespacedPath(record.import.bundle) : record.import.bundle,
          file: record.import.file ? assertNamespacedPath(record.import.file) : record.import.file,
        }
      : undefined,
  };
}
