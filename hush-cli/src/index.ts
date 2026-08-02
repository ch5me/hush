export type {
  ActiveIdentityStateDocument,
  HushBundleConflictDetail,
  HushBundleResolution,
  HushNamespace,
  HushRole,
  HushAuditCommandContext,
  HushAuditEvent,
  HushAuditEventType,
  HushProjectStatePaths,
  HushArtifactEntry,
  HushArtifactBinaryEntry,
  HushArtifactFileEntry,
  HushArtifactFormat,
  HushBundleConflict,
  HushBundleDefinition,
  HushBundleFileRef,
  HushBundleImportRef,
  HushBundleName,
  HushFileDocument,
  HushFileEntry,
  HushFilePath,
  HushIdentityName,
  HushIdentityRecord,
  HushImportDefinition,
  HushImportName,
  HushImportRepositoryMap,
  HushImportPullSpec,
  HushInterpolationDependency,
  HushProjectDiscoveryResult,
  HushProjectRuntimeAuthority,
  HushLogicalPath,
  HushManifestDocument,
  HushResolvedNode,
  HushV3Repository,
  HushProvenanceImportRecord,
  HushProvenanceRecord,
  HushReaders,
  HushResolvedValue,
  HushResolverResult,
  HushSelectedEntryCandidate,
  HushScalarValue,
  HushTargetDefinition,
  HushTargetName,
  HushTargetResolution,
  HushValueEntry,
  OutputFormat,
  Environment,
  LegacyTarget,
  LegacySourceFiles,
  LegacyHushConfig,
  LegacyV2Inventory,
  StoreContext,
  StoreMode,
  EnvVar,
  DecryptOptions,
  EncryptOptions,
  EditOptions,
  DiffOptions,
  PushOptions,
  StatusOptions,
  ProjectOptions,
  InitOptions,
  BootstrapOptions,
  ConfigOptions,
  ExportExampleOptions,
  MaterializeOptions,
  ListOptions,
  ResolveV3BundleOptions,
  ResolveV3Options,
  ResolveV3TargetOptions,
  HushArtifactDescriptor,
  HushArtifactFileDescriptor,
  HushArtifactBinaryDescriptor,
  HushArtifactShapeResult,
  HushTargetArtifactDescriptor,
  HushMaterialization,
  HushMaterializationFailure,
  HushMaterializationMode,
  HushMaterializeBundleOptions,
  HushMaterializeTargetOptions,
} from "./types.js";
export type { DeclaredIdentities, SetActiveIdentityOptions } from "./v3/identity.js";

export {
  ACTIVE_IDENTITY_STATE_BASENAME,
  ACTIVE_IDENTITY_STATE_VERSION,
  AUDIT_LOG_BASENAME,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SOURCES,
  FORMAT_OUTPUT_FILES,
  HUSH_AUDIT_EVENT_VERSION,
  HUSH_MACHINE_ROOT,
  HUSH_STATE_DIRNAME,
  HUSH_STATE_PROJECTS_DIRNAME,
  HUSH_V3_ENCRYPTED_FILE_EXTENSION,
  HUSH_V3_FILES_DIRNAME,
  HUSH_V3_MANIFEST_BASENAME,
  HUSH_V3_NAMESPACES,
  HUSH_V3_ROLES,
  HUSH_V3_ROOT_DIR,
  V3_SCHEMA_VERSION,
  assertHushNamespace,
  assertHushRole,
  assertNamespacedPath,
  createBundleDefinition,
  createFileDocument,
  createFileIndexEntry,
  createIdentityRecord,
  createImportDefinition,
  createManifestDocument,
  createProvenanceRecord,
  createReaders,
  createTargetDefinition,
  createAuditEvent,
  getNamespaceFromPath,
  getActiveIdentity,
  getProjectStatePaths,
  getStoreStateSeed,
  createProjectSlug,
  appendAuditEvent,
  getV3EncryptedFilePath,
  getV3FilesRoot,
  getV3ManifestPath,
  getV3RepoRoot,
  readActiveIdentityState,
  requireActiveIdentity,
  serializeAuditEvent,
  setActiveIdentity,
  ensureProjectStateRoot,
  isHushNamespace,
  isHushRole,
  isIdentityAllowed,
  isV3EncryptedFilePath,
  isV3ManifestPath,
  normalizeHushPath,
  readStateJsonFile,
  stripEncryptedFileExtension,
  writeStateJsonFile,
} from "./types.js";
export {
  resolveStoreContext,
  GLOBAL_STORE_ROOT,
  GLOBAL_STORE_KEY_IDENTITY,
  GLOBAL_STORE_STATE_ROOT,
} from "./store.js";

export {
  loadConfig,
  findConfigPath,
  findProjectRoot,
  isV3RepositoryRoot,
  loadProjectRuntimeAuthority,
  validateConfig,
} from "./config/loader.js";
export { loadLegacyV2Inventory } from "./v3/legacy-v2.js";
export { loadV3Repository } from "./v3/repository.js";
export { HushResolutionConflictError, resolveV3Bundle, resolveV3Target } from "./v3/resolver.js";
export {
  ALLOW_LOCAL_OVERRIDES_ENV,
  HushLocalOverrideShadowError,
  type ShadowPolicy,
  shapeBundleArtifacts,
  shapeResolvedArtifacts,
  shapeTargetArtifacts,
  targetFormatToArtifactFormat,
} from "./v3/artifacts.js";
export {
  HushMaterializationInterruptedError,
  materializeV3Bundle,
  materializeV3Target,
  withMaterializedBundle,
  withMaterializedTarget,
} from "./v3/materialize.js";

export { parseEnvContent, parseEnvFile, varsToRecord, recordToVars } from "./core/parse.js";
export {
  interpolateVars,
  interpolateValue,
  hasUnresolvedVars,
  getUnresolvedVars,
} from "./core/interpolate.js";
export { mergeVars } from "./core/merge.js";
export { decrypt, encrypt, edit, isSopsInstalled, isAgeKeyConfigured } from "./core/sops.js";
export { maskValue, maskVars, formatMaskedVar } from "./core/mask.js";
export type { MaskedVar } from "./core/mask.js";

export {
  formatVars,
  formatDotenv,
  formatWrangler,
  formatJson,
  formatShell,
  formatYaml,
} from "./formats/index.js";

export { decryptCommand } from "./commands/decrypt.js";
export { encryptCommand } from "./commands/encrypt.js";
export { editCommand } from "./commands/edit.js";
export { statusCommand } from "./commands/status.js";
export { pushCommand } from "./commands/push.js";
export { bootstrapCommand } from "./commands/bootstrap.js";
export { configCommand } from "./commands/config.js";
export { initCommand } from "./commands/init.js";
export { listCommand } from "./commands/list.js";
export { inspectCommand } from "./commands/inspect.js";
export { hasCommand } from "./commands/has.js";
export { diffCommand } from "./commands/diff.js";
export { exportExampleCommand } from "./commands/export-example.js";
export { materializeCommand } from "./commands/materialize.js";
export { projectCommand } from "./commands/project.js";
