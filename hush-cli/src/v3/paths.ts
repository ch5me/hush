import { posix as posixPath, resolve, sep } from 'node:path';
import {
  HUSH_V3_ENCRYPTED_FILE_EXTENSION,
  HUSH_V3_FILES_DIRNAME,
  HUSH_V3_MANIFEST_BASENAME,
  HUSH_V3_ROOT_DIR,
  normalizeHushPath,
} from './schema.js';

export function getV3RepoRoot(root: string): string {
  return posixPath.join(root, HUSH_V3_ROOT_DIR);
}

export function getV3ManifestPath(root: string): string {
  return posixPath.join(getV3RepoRoot(root), HUSH_V3_MANIFEST_BASENAME);
}

export function getV3FilesRoot(root: string): string {
  return posixPath.join(getV3RepoRoot(root), HUSH_V3_FILES_DIRNAME);
}

export function getV3EncryptedFilePath(root: string, filePath: string): string {
  const normalizedFilePath = normalizeHushPath(filePath);
  const filesRoot = resolve(getV3FilesRoot(root));
  const encryptedPath = resolve(filesRoot, `${normalizedFilePath}${HUSH_V3_ENCRYPTED_FILE_EXTENSION}`);
  if (!encryptedPath.startsWith(`${filesRoot}${sep}`)) {
    throw new Error(`Hush path "${filePath}" resolves outside the repository files directory`);
  }
  return encryptedPath;
}

export function stripEncryptedFileExtension(filePath: string): string {
  return filePath.endsWith(HUSH_V3_ENCRYPTED_FILE_EXTENSION)
    ? filePath.slice(0, -HUSH_V3_ENCRYPTED_FILE_EXTENSION.length)
    : filePath;
}

export function isV3ManifestPath(filePath: string): boolean {
  return filePath.endsWith(`/${HUSH_V3_ROOT_DIR}/${HUSH_V3_MANIFEST_BASENAME}`);
}

export function isV3EncryptedFilePath(filePath: string): boolean {
  return filePath.includes(`/${HUSH_V3_ROOT_DIR}/${HUSH_V3_FILES_DIRNAME}/`)
    && filePath.endsWith(HUSH_V3_ENCRYPTED_FILE_EXTENSION);
}
