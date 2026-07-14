export const V3_SCHEMA_VERSION = 3;

export const HUSH_V3_ROOT_DIR = '.hush';
export const HUSH_V3_MANIFEST_BASENAME = 'manifest.encrypted';
export const HUSH_V3_FILES_DIRNAME = 'files';
export const HUSH_V3_ENCRYPTED_FILE_EXTENSION = '.encrypted';

export const HUSH_V3_NAMESPACES = ['env', 'artifacts', 'bundles', 'user', 'imports'] as const;
export const HUSH_V3_ROLES = ['owner', 'member', 'ci'] as const;

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
      `Invalid Hush namespace "${value}". Expected one of: ${HUSH_V3_NAMESPACES.join(', ')}`,
    );
  }

  return value;
}

export function assertHushRole(value: string): HushRole {
  if (!isHushRole(value)) {
    throw new Error(
      `Invalid Hush role "${value}". Expected one of: ${HUSH_V3_ROLES.join(', ')}`,
    );
  }

  return value;
}

export function normalizeHushPath(path: string): string {
  const trimmed = path.trim();

  if (!trimmed) {
    throw new Error('Hush path cannot be empty');
  }

  const withoutLeadingSlash = trimmed.replace(/^\/+/, '');
  const withoutTrailingSlash = withoutLeadingSlash.replace(/\/+$/, '');

  if (!withoutTrailingSlash) {
    throw new Error('Hush path cannot be empty');
  }

  if (withoutTrailingSlash.includes('//')) {
    throw new Error(`Hush path "${path}" cannot contain empty segments`);
  }

  const segments = withoutTrailingSlash.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`Hush path "${path}" cannot contain "." or ".." segments`);
  }

  if (withoutTrailingSlash.includes('\\')) {
    throw new Error(`Hush path "${path}" must use forward slashes`);
  }

  return withoutTrailingSlash;
}

export function splitHushPath(path: string): string[] {
  return normalizeHushPath(path).split('/');
}

export function getNamespaceFromPath(path: string): HushNamespace {
  const [namespace] = splitHushPath(path);
  return assertHushNamespace(namespace);
}

export function assertNamespacedPath(path: string): string {
  getNamespaceFromPath(path);
  return normalizeHushPath(path);
}

export function assertRoleList(values: readonly string[] | undefined): HushRole[] {
  return (values ?? []).map(assertHushRole);
}
