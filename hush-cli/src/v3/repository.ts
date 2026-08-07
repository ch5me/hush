import { join } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { decryptYaml, readEncryptedFileRecipients } from "../core/sops.js";
import { fs } from "../lib/fs.js";
import type { HushContext, HushV3Repository, StoreContext } from "../types.js";
import type {
  HushFileDocument,
  HushFilePath,
  HushIdentityName,
  HushManifestDocument,
  HushReaders,
} from "./domain.js";
import {
  createFileIndexEntry,
  createManifestDocument,
  upsertManifestFileIndexEntry,
} from "./domain.js";
import { parseFileDocument, parseManifestDocument } from "./manifest.js";
import { getV3FilesRoot, getV3ManifestPath, stripEncryptedFileExtension } from "./paths.js";
import { HUSH_V3_ENCRYPTED_FILE_EXTENSION } from "./schema.js";

interface LoadV3RepositoryOptions {
  keyIdentity?: string;
}

export class ReaderRecipientAuthorityError extends Error {
  readonly code = "READER_RECIPIENT_AUTHORITY_MISSING";

  constructor(filePath: string) {
    super(
      `Cannot update readers for "${filePath}": Hush has no authoritative identity-to-age-recipient mapping. ` +
        "Reader metadata was not changed; configure recipient authority before retrying.",
    );
    this.name = "ReaderRecipientAuthorityError";
  }
}

/**
 * Reader metadata is an access promise only when the encrypted file carries
 * recipients for the same identities. Hush currently has no authoritative
 * identity-to-recipient mapping, so refuse metadata-only mutations.
 */
export function assertReaderRecipientAuthority(
  filePath: string,
  currentReaders: HushReaders,
  nextReaders: HushReaders,
): void {
  if (JSON.stringify(currentReaders) !== JSON.stringify(nextReaders)) {
    throw new ReaderRecipientAuthorityError(filePath);
  }
}

export interface ReaderRecipientDriftFinding {
  filePath: HushFilePath;
  /** The file's full `readers.identities` declaration, unfiltered. */
  declaredIdentities: HushIdentityName[];
  /** Identities named in readers that are not recorded as holding the `owner` role. */
  unaccountedIdentities: HushIdentityName[];
  /** Age public keys actually wrapped into the file's own sops footer. */
  recipients: string[];
  /** Minimum recipient count for the declared identities to even be possible: owner + one each. */
  requiredRecipients: number;
}

export function describeReaderRecipientDrift(findings: ReaderRecipientDriftFinding[]): string {
  const lines = findings.map(
    (finding) =>
      `  "${finding.filePath}": readers.identities=[${finding.declaredIdentities.join(", ")}] ` +
      `names ${finding.unaccountedIdentities.length} identity(ies) not recorded as owner ` +
      `(${finding.unaccountedIdentities.join(", ")}), but the file has only ` +
      `${finding.recipients.length} age recipient(s) [${finding.recipients.join(", ")}] -- ` +
      `needs at least ${finding.requiredRecipients}.`,
  );

  return (
    `${findings.length} file(s) declare reader identities their age recipients cannot back:\n` +
    `${lines.join("\n")}\n` +
    "Hush's readers metadata does not match who can actually decrypt these files. Either add " +
    "a distinct age recipient for each named identity to .sops.yaml and re-encrypt " +
    '("sops updatekeys"), or remove the identity from readers if the grant was never backed ' +
    "by a real key."
  );
}

export class ReaderRecipientDriftError extends Error {
  readonly code = "READER_RECIPIENT_DRIFT";

  constructor(readonly findings: ReaderRecipientDriftFinding[]) {
    super(describeReaderRecipientDrift(findings));
    this.name = "ReaderRecipientDriftError";
  }
}

/**
 * Hush's readers metadata (`hush config readers`, `hush file add --identities`) is a
 * promise about who can decrypt a file. The file's actual age recipients are what
 * governs decryption, and nothing keeps the two in sync:
 * `assertReaderRecipientAuthority` only stops the promise from being WIDENED after
 * creation -- it never checks whether an existing promise is real, and file
 * creation has no prior state to compare against at all.
 *
 * This computes every file whose `readers.identities` names an identity that is not
 * recorded as holding the `owner` role -- the one role guaranteed to correspond to a
 * real recipient, since owner is whoever ran `hush keys generate` / `hush bootstrap`
 * -- and for which the file's actual recipient count leaves no room for that
 * identity to hold a distinct key: fewer recipients exist than the
 * "owner key + one per named identity" floor requires.
 *
 * This is a necessary-condition check, not a full identity-to-key proof: Hush has no
 * identity-to-age-key registry (see `ReaderRecipientAuthorityError`), so it cannot
 * confirm any SPECIFIC named identity holds a SPECIFIC recipient key -- only that
 * there is not even enough room for all of them to have distinct ones. Files that
 * only widen `readers.roles` (not `readers.identities`) are out of scope: every file
 * defaults to `roles: [owner, member, ci]` regardless of intent, so a roles-only
 * signal cannot separate "never customized" from "deliberately widened" without
 * flooding the entire fleet.
 */
export function computeReaderRecipientDrift(
  repository: HushV3Repository,
): ReaderRecipientDriftFinding[] {
  const ownerIdentities = new Set(
    Object.entries(repository.manifest.identities)
      .filter(([, record]) => record.roles.includes("owner"))
      .map(([name]) => name),
  );

  const findings: ReaderRecipientDriftFinding[] = [];

  for (const [filePath, entry] of Object.entries(repository.filesByPath)) {
    const declaredIdentities = entry.readers.identities;
    if (declaredIdentities.length === 0) {
      continue;
    }

    const unaccountedIdentities = declaredIdentities.filter((name) => !ownerIdentities.has(name));
    if (unaccountedIdentities.length === 0) {
      continue;
    }

    const systemPath = repository.fileSystemPaths[filePath];
    if (!systemPath) {
      throw new Error(`File "${filePath}" is not declared in repository ${repository.projectRoot}`);
    }

    const recipients = readEncryptedFileRecipients(systemPath);
    const requiredRecipients = unaccountedIdentities.length + 1; // +1 for the owner's own key

    if (recipients.length < requiredRecipients) {
      findings.push({
        filePath,
        declaredIdentities,
        unaccountedIdentities,
        recipients,
        requiredRecipients,
      });
    }
  }

  return findings.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

/** Throws `ReaderRecipientDriftError` when any file fails `computeReaderRecipientDrift`. */
export function assertNoReaderRecipientDrift(repository: HushV3Repository): void {
  const findings = computeReaderRecipientDrift(repository);
  if (findings.length > 0) {
    throw new ReaderRecipientDriftError(findings);
  }
}

function walkEncryptedFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }

  const discovered: string[] = [];

  for (const entry of fs.readdirSync(root)) {
    const entryPath = join(root, entry);
    const stats = fs.statSync(entryPath);

    if (stats.isDirectory()) {
      discovered.push(...walkEncryptedFiles(entryPath));
      continue;
    }

    if (entryPath.endsWith(HUSH_V3_ENCRYPTED_FILE_EXTENSION)) {
      discovered.push(entryPath);
    }
  }

  return discovered.sort();
}

function validateBundleFileReferences(
  manifest: HushManifestDocument,
  filesByPath: Record<string, { logicalPaths: string[] }>,
): void {
  for (const [bundleName, bundle] of Object.entries(manifest.bundles ?? {})) {
    for (const file of bundle.files ?? []) {
      if (!filesByPath[file.path]) {
        throw new Error(`Bundle "${bundleName}" references missing file "${file.path}"`);
      }
    }
  }
}

function validateTargetReferences(manifest: HushManifestDocument): void {
  for (const [targetName, target] of Object.entries(manifest.targets ?? {})) {
    if (target.bundle && !(target.bundle in (manifest.bundles ?? {}))) {
      throw new Error(`Target "${targetName}" references missing bundle "${target.bundle}"`);
    }
  }
}

function getRepositoryFilePath(filesRoot: string, fileSystemPath: string): HushFilePath {
  return stripEncryptedFileExtension(
    fileSystemPath
      .slice(filesRoot.length + 1)
      .split("/")
      .join("/"),
  );
}

function validateFileIndex(
  manifest: HushManifestDocument,
  filesRoot: string,
  discoveredFiles: string[],
): {
  fileIndexByPath: Record<HushFilePath, HushV3Repository["filesByPath"][string]>;
  fileSystemPaths: Record<HushFilePath, string>;
} {
  const manifestFileIndex = manifest.fileIndex ?? {};
  const fileIndexByPath: Record<HushFilePath, HushV3Repository["filesByPath"][string]> = {};
  const fileSystemPaths: Record<HushFilePath, string> = {};
  const discoveredPaths = discoveredFiles
    .map((filePath) => getRepositoryFilePath(filesRoot, filePath))
    .sort();
  const indexedPaths = Object.keys(manifestFileIndex).sort();

  for (const indexedPath of indexedPaths) {
    const systemPath = join(filesRoot, `${indexedPath}.encrypted`);

    if (!discoveredPaths.includes(indexedPath)) {
      throw new Error(`Manifest file index references missing encrypted file "${indexedPath}"`);
    }

    fileIndexByPath[indexedPath] = manifestFileIndex[indexedPath]!;
    fileSystemPaths[indexedPath] = systemPath;
  }

  for (const discoveredPath of discoveredPaths) {
    if (!(discoveredPath in manifestFileIndex)) {
      throw new Error(`Encrypted file "${discoveredPath}" is missing from manifest file index`);
    }
  }

  return { fileIndexByPath, fileSystemPaths };
}

function loadRepositoryFile(
  root: string,
  filesRoot: string,
  filePath: string,
  keyIdentity: string | undefined,
): HushFileDocument {
  const content = decryptYaml(filePath, { root, keyIdentity });
  return parseFileDocument(filePath, content, filesRoot);
}

export function persistV3ManifestDocument(
  ctx: HushContext,
  store: StoreContext,
  repository: HushV3Repository,
  nextManifest: HushManifestDocument,
): HushManifestDocument {
  const validatedManifest = createManifestDocument(nextManifest);

  validateBundleFileReferences(validatedManifest, repository.filesByPath);
  validateTargetReferences(validatedManifest);

  const content = stringifyYaml(validatedManifest, { indent: 2 });
  ctx.sops.encryptYamlContent(content, repository.manifestPath, {
    root: store.root,
    keyIdentity: store.keyIdentity,
  });

  repository.manifest = validatedManifest;
  return validatedManifest;
}

export function persistV3FileDocument(
  ctx: HushContext,
  store: StoreContext,
  repository: HushV3Repository,
  systemPath: string,
  document: HushFileDocument,
): HushManifestDocument {
  return persistV3FileDocuments(ctx, store, repository, [{ systemPath, document }]);
}

interface FileDocumentWrite {
  systemPath: string;
  document: HushFileDocument;
}

function snapshotFile(filePath: string): string | Buffer | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function restoreFile(filePath: string, snapshot: string | Buffer | null): void {
  if (snapshot === null) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  fs.writeFileSync(filePath, snapshot);
}

export function persistV3FileDocuments(
  ctx: HushContext,
  store: StoreContext,
  repository: HushV3Repository,
  writes: FileDocumentWrite[],
): HushManifestDocument {
  const snapshots = new Map<string, string | Buffer | null>();
  for (const { systemPath } of writes) snapshots.set(systemPath, snapshotFile(systemPath));
  snapshots.set(repository.manifestPath, snapshotFile(repository.manifestPath));

  let nextManifest = repository.manifest;
  for (const { document } of writes) {
    nextManifest = upsertManifestFileIndexEntry(
      nextManifest,
      document.path,
      createFileIndexEntry(document),
    );
  }

  try {
    for (const { systemPath, document } of writes) {
      ctx.sops.encryptYamlContent(stringifyYaml(document, { indent: 2 }), systemPath, {
        root: store.root,
        keyIdentity: store.keyIdentity,
      });
    }
    ctx.sops.encryptYamlContent(
      stringifyYaml(nextManifest, { indent: 2 }),
      repository.manifestPath,
      {
        root: store.root,
        keyIdentity: store.keyIdentity,
      },
    );
  } catch (error) {
    for (const [filePath, snapshot] of snapshots) restoreFile(filePath, snapshot);
    throw error;
  }

  repository.manifest = nextManifest;
  for (const { systemPath, document } of writes) {
    repository.filesByPath[document.path] = createFileIndexEntry(document);
    repository.fileSystemPaths[document.path] = systemPath;
    repository.cacheFile?.(document);
  }
  repository.files = Object.entries(repository.filesByPath)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);
  return nextManifest;
}

export function removeV3FileDocument(
  ctx: HushContext,
  store: StoreContext,
  repository: HushV3Repository,
  filePath: HushFilePath,
  systemPath: string | undefined,
  keepFile: boolean,
  nextManifest: HushManifestDocument,
): HushManifestDocument {
  const manifestSnapshot = snapshotFile(repository.manifestPath);
  const fileSnapshot = systemPath ? snapshotFile(systemPath) : null;
  const previousManifest = repository.manifest;
  try {
    persistV3ManifestDocument(ctx, store, repository, nextManifest);
    if (!keepFile && systemPath) fs.unlinkSync(systemPath);
  } catch (error) {
    restoreFile(repository.manifestPath, manifestSnapshot);
    if (systemPath) restoreFile(systemPath, fileSnapshot);
    repository.manifest = previousManifest;
    throw error;
  }
  delete repository.filesByPath[filePath];
  delete repository.fileSystemPaths[filePath];
  repository.files = Object.entries(repository.filesByPath)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);
  return nextManifest;
}

export function loadV3Repository(
  root: string,
  options?: LoadV3RepositoryOptions,
): HushV3Repository {
  const manifestPath = getV3ManifestPath(root);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Missing v3 manifest at ${manifestPath}. Bootstrap this repository with "hush bootstrap" before using v3 commands.`,
    );
  }

  const filesRoot = getV3FilesRoot(root);
  const manifestContent = decryptYaml(manifestPath, { root, keyIdentity: options?.keyIdentity });
  const manifest = parseManifestDocument(manifestPath, manifestContent);
  const { fileIndexByPath, fileSystemPaths } = validateFileIndex(
    manifest,
    filesRoot,
    walkEncryptedFiles(filesRoot),
  );
  const fileCache = new Map<HushFilePath, HushFileDocument>();

  validateBundleFileReferences(manifest, fileIndexByPath);
  validateTargetReferences(manifest);

  return {
    kind: "v3",
    projectRoot: root,
    manifestPath,
    filesRoot,
    manifest,
    files: Object.entries(fileIndexByPath)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, entry]) => entry),
    filesByPath: fileIndexByPath,
    fileSystemPaths,
    loadFile(filePath) {
      const cached = fileCache.get(filePath);
      if (cached) {
        return cached;
      }

      const systemPath = fileSystemPaths[filePath];
      if (!systemPath) {
        throw new Error(`File "${filePath}" is not declared in repository ${root}`);
      }

      const document = loadRepositoryFile(root, filesRoot, systemPath, options?.keyIdentity);
      fileCache.set(filePath, document);
      return document;
    },
    cacheFile(document) {
      fileCache.set(document.path, document);
    },
  };
}
