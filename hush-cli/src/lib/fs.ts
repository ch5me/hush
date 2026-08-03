import {
  existsSync as nodeExistsSync,
  readFileSync as nodeReadFileSync,
  writeFileSync as nodeWriteFileSync,
  mkdirSync as nodeMkdirSync,
  readdirSync as nodeReaddirSync,
  unlinkSync as nodeUnlinkSync,
  rmSync as nodeRmSync,
  statSync as nodeStatSync,
  fstatSync as nodeFstatSync,
  renameSync as nodeRenameSync,
  type PathLike,
  type WriteFileOptions,
} from "node:fs";

/**
 * Filesystem wrapper to allow for easier testing and isolation of side effects.
 * All core logic and commands should use these instead of direct node:fs calls.
 */

export const fs = {
  existsSync: (path: PathLike): boolean => {
    return nodeExistsSync(path);
  },

  readFileSync: (
    path: PathLike,
    options?: { encoding?: BufferEncoding; flag?: string } | BufferEncoding,
  ): string | Buffer => {
    return nodeReadFileSync(path, options);
  },

  writeFileSync: (path: PathLike, data: string | Uint8Array, options?: WriteFileOptions): void => {
    nodeWriteFileSync(path, data, options);
  },

  mkdirSync: (
    path: PathLike,
    options?: { recursive?: boolean; mode?: number },
  ): string | undefined => {
    return nodeMkdirSync(path, options);
  },

  readdirSync: (path: PathLike, options?: { recursive?: boolean }): string[] => {
    // @ts-expect-error - handled by node:fs
    return nodeReaddirSync(path, options);
  },

  unlinkSync: (path: PathLike): void => {
    nodeUnlinkSync(path);
  },

  rmSync: (path: PathLike, options?: { recursive?: boolean; force?: boolean }): void => {
    nodeRmSync(path, options);
  },

  statSync: (path: PathLike) => {
    return nodeStatSync(path);
  },

  fstatSync: (fd: number) => {
    return nodeFstatSync(fd);
  },

  renameSync: (oldPath: PathLike, newPath: PathLike): void => {
    nodeRenameSync(oldPath, newPath);
  },
};
