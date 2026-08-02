export const V3_SCHEMA_VERSION = 3;

export const HUSH_V3_ROOT_DIR = ".hush";
export const HUSH_V3_MANIFEST_BASENAME = "manifest.encrypted";
export const HUSH_V3_FILES_DIRNAME = "files";
export const HUSH_V3_ENCRYPTED_FILE_EXTENSION = ".encrypted";

export const HUSH_V3_NAMESPACES = ["env", "artifacts", "bundles", "user", "imports"] as const;
export const HUSH_V3_ROLES = ["owner", "member", "ci"] as const;

/**
 * The first path segment names the storage class.
 *
 * `user/**` is the machine-local override store: per-machine, never committed,
 * addressable only through `--repo-local`/`--local`. Every other namespace is
 * repository storage: committed under `.hush/files/`, decryptable by every
 * identity in the file's reader set.
 *
 * Nothing may declare a repository file under `user/**`. That separation is the
 * whole point: before it, `env/project/local` named the machine-local store
 * *and* could name a committed repository file, so one logical path resolved to
 * two storage locations depending on invisible manifest state, and their entries
 * collided in a single logical-path namespace.
 */
export const HUSH_MACHINE_LOCAL_NAMESPACE = "user";

/** Logical path of the machine-local override document. */
export const MACHINE_LOCAL_FILE_PATH = "user/local";

/**
 * The path machine-local override documents carried before `user/local`. Still
 * read (and normalized) from disk; never written, never resolved as an alias.
 */
export const LEGACY_MACHINE_LOCAL_FILE_PATH = "env/project/local";

export class ReservedFilePathError extends Error {
  readonly path: string;

  constructor(path: string, remedy: string) {
    super(
      `"${path}" is in the reserved "${HUSH_MACHINE_LOCAL_NAMESPACE}/" namespace. ` +
        "That namespace is machine-local override storage and can never be a repository file. " +
        remedy,
    );
    this.name = "ReservedFilePathError";
    this.path = path;
  }
}

export type HushNamespace = (typeof HUSH_V3_NAMESPACES)[number];
export type HushRole = (typeof HUSH_V3_ROLES)[number];

const HUSH_V3_NAMESPACE_SET = new Set<string>(HUSH_V3_NAMESPACES);
const HUSH_V3_ROLE_SET = new Set<string>(HUSH_V3_ROLES);

export function isHushNamespace(value: string): value is HushNamespace {
  return HUSH_V3_NAMESPACE_SET.has(value);
}

export function isHushRole(value: string): value is HushRole {
  return HUSH_V3_ROLE_SET.has(value);
}

export function assertHushNamespace(value: string): HushNamespace {
  if (!isHushNamespace(value)) {
    throw new Error(
      `Invalid Hush namespace "${value}". Expected one of: ${HUSH_V3_NAMESPACES.join(", ")}`,
    );
  }

  return value;
}

export function assertHushRole(value: string): HushRole {
  if (!isHushRole(value)) {
    throw new Error(`Invalid Hush role "${value}". Expected one of: ${HUSH_V3_ROLES.join(", ")}`);
  }

  return value;
}

export function normalizeHushPath(path: string): string {
  const trimmed = path.trim();

  if (!trimmed) {
    throw new Error("Hush path cannot be empty");
  }

  const withoutLeadingSlash = trimmed.replace(/^\/+/, "");
  const withoutTrailingSlash = withoutLeadingSlash.replace(/\/+$/, "");

  if (!withoutTrailingSlash) {
    throw new Error("Hush path cannot be empty");
  }

  if (withoutTrailingSlash.includes("//")) {
    throw new Error(`Hush path "${path}" cannot contain empty segments`);
  }

  const segments = withoutTrailingSlash.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Hush path "${path}" cannot contain "." or ".." segments`);
  }

  if (withoutTrailingSlash.includes("\\")) {
    throw new Error(`Hush path "${path}" must use forward slashes`);
  }

  return withoutTrailingSlash;
}

export function splitHushPath(path: string): string[] {
  return normalizeHushPath(path).split("/");
}

export function getNamespaceFromPath(path: string): HushNamespace {
  const [namespace] = splitHushPath(path);
  return assertHushNamespace(namespace);
}

export function assertNamespacedPath(path: string): string {
  getNamespaceFromPath(path);
  return normalizeHushPath(path);
}

export function isMachineLocalPath(path: string): boolean {
  return splitHushPath(path)[0] === HUSH_MACHINE_LOCAL_NAMESPACE;
}

/**
 * Assert a path names repository storage. Use wherever a command may only ever
 * touch a committed `.hush/files/` document, so a machine-local selector fails
 * closed with a typed error instead of being silently reinterpreted.
 */
export function assertRepositoryFilePath(path: string, remedy: string): string {
  const normalized = assertNamespacedPath(path);

  if (isMachineLocalPath(normalized)) {
    throw new ReservedFilePathError(normalized, remedy);
  }

  return normalized;
}

export function assertRoleList(values: readonly string[] | undefined): HushRole[] {
  return (values ?? []).map(assertHushRole);
}
