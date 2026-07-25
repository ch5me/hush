import { basename, join as joinPosix } from 'node:path/posix';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { formatVars } from '../formats/index.js';
import { formatDuplicateKeyHint } from '../commands/v3-command-helpers.js';
import type { EnvVar, OutputFormat } from '../types.js';
import { isMachineLocalPath } from './schema.js';
import type { HushArtifactEntry, HushArtifactFormat, HushLogicalPath, HushTargetDefinition } from './domain.js';
import type { HushResolvedNode, HushTargetResolution } from './provenance.js';

export interface HushArtifactBaseDescriptor {
  logicalPath: HushLogicalPath;
  format: HushArtifactFormat;
  sensitive: boolean;
  provenance: HushResolvedNode['provenance'];
  resolvedFrom: HushResolvedNode['resolvedFrom'];
  suggestedName: string;
  relativePath: string;
  sha256: string;
}

export interface HushArtifactFileDescriptor extends HushArtifactBaseDescriptor {
  kind: 'file';
  content: string;
}

export interface HushArtifactBinaryDescriptor extends HushArtifactBaseDescriptor {
  kind: 'binary';
  content: Uint8Array;
  encoding: 'base64' | 'utf8';
}

export type HushArtifactDescriptor = HushArtifactFileDescriptor | HushArtifactBinaryDescriptor;

export interface HushTargetArtifactDescriptor extends HushArtifactFileDescriptor {
  source: 'target';
  target: string;
}

export interface HushArtifactShapeResult {
  envVars: EnvVar[];
  env: Record<string, string>;
  targetArtifact: HushTargetArtifactDescriptor | null;
  artifacts: HushArtifactDescriptor[];
  /** Repository values that machine-local overrides displaced, if any. */
  shadowed: HushShadowedEnvVar[];
}

function isOutputFormat(format: HushArtifactFormat): format is OutputFormat {
  return format === 'dotenv' || format === 'wrangler' || format === 'vercel' || format === 'json' || format === 'shell' || format === 'yaml';
}

function toEnvVarValue(value: HushResolvedNode['entry']['value']): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null) {
    return '';
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
}

function logicalPathToEnvKey(path: string): string {
  const segments = path.split('/').filter(Boolean);
  const key = segments.at(-1);

  if (!key) {
    throw new Error(`Cannot derive environment key from logical path "${path}"`);
  }

  return key;
}

function buildTargetPrecedenceFiles(values: HushTargetResolution['values']): string[] {
  return Array.from(new Set(
    Object.values(values)
      .flatMap((node) => node.provenance.map((record) => record.filePath)),
  ));
}

/**
 * A repository value that a machine-local override displaced at the
 * environment-key layer.
 *
 * The displaced node stays in the resolution's `values` — only the environment
 * view collapses. That keeps `${env/project/shared/KEY}` interpolation, `hush
 * trace`, and the audit log able to see a path that an override shadows, and it
 * is why shadowing lives here rather than in the resolver's path-level
 * selection: dropping the node there would leave interpolation pointing at a
 * path that no longer exists.
 */
export interface HushShadowedEnvVar {
  key: string;
  /** The winning machine-local logical path. */
  overridePath: HushLogicalPath;
  /** Repository logical paths the override displaced. */
  shadowedPaths: HushLogicalPath[];
  /** Repository files the displaced values came from. */
  shadowedFiles: string[];
}

interface EnvVarPair {
  path: HushLogicalPath;
  value: string;
}

interface CollectedEnvVars {
  envVars: EnvVar[];
  shadowed: HushShadowedEnvVar[];
}

/**
 * Resolve one environment key claimed by several logical paths.
 *
 * A machine-local override deliberately shares an environment key with the one
 * repository value it replaces (`hush set DATABASE_URL --repo-local` shadows
 * `env/project/shared/DATABASE_URL`), so that exact pairing means "override".
 *
 * Anything else stays a hard error, including an override sitting on top of two
 * colliding repository paths. Those two are ambiguous whether an override exists
 * or not, and resolving them here would make the ambiguity visible only to
 * whoever lacks the override — green on one laptop, broken in CI and for every
 * other developer.
 */
function resolveKeyCollision(
  key: string,
  contenders: EnvVarPair[],
  values: HushTargetResolution['values'],
  target: string,
): { winner: EnvVarPair; shadowed: HushShadowedEnvVar | null } {
  const [first] = contenders;

  if (contenders.length === 1 && first) {
    return { winner: first, shadowed: null };
  }

  const overrides = contenders.filter((pair) => isMachineLocalPath(pair.path));
  const [override] = overrides;

  if (contenders.length !== 2 || overrides.length !== 1 || !override) {
    const paths = contenders.map((pair) => pair.path);
    const duplicateFiles = paths
      .flatMap((path) => values[path]?.resolvedFrom ?? [])
      .sort((left, right) => left.localeCompare(right));
    const precedenceFiles = buildTargetPrecedenceFiles(values);

    throw new Error(
      `Multiple logical paths resolve to environment key "${key}": ${paths.sort().join(', ')}. `
      + formatDuplicateKeyHint(key, duplicateFiles.length > 0 ? duplicateFiles : precedenceFiles, target),
    );
  }

  const shadowedPaths = contenders.filter((pair) => pair !== override).map((pair) => pair.path);

  return {
    winner: override,
    shadowed: {
      key,
      overridePath: override.path,
      shadowedPaths: shadowedPaths.sort(),
      shadowedFiles: Array.from(new Set(
        shadowedPaths.flatMap((path) => values[path]?.resolvedFrom ?? []),
      )).sort(),
    },
  };
}

function collectEnvVars(values: HushTargetResolution['values'], target: string): CollectedEnvVars {
  const byKey = new Map<string, EnvVarPair[]>();

  for (const [path, node] of Object.entries(values)) {
    const key = logicalPathToEnvKey(path);
    const contenders = byKey.get(key) ?? [];
    contenders.push({ path, value: toEnvVarValue(node.entry.value) });
    byKey.set(key, contenders);
  }

  const envVars: EnvVar[] = [];
  const shadowed: HushShadowedEnvVar[] = [];

  for (const [key, contenders] of Array.from(byKey.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    const resolved = resolveKeyCollision(key, contenders, values, target);
    envVars.push({ key, value: resolved.winner.value });

    if (resolved.shadowed) {
      shadowed.push(resolved.shadowed);
    }
  }

  return { envVars, shadowed };
}

function toEnvRecord(envVars: readonly EnvVar[]): Record<string, string> {
  return Object.fromEntries(envVars.map((variable) => [variable.key, variable.value]));
}

function formatToExtension(format: HushArtifactFormat): string {
  switch (format) {
    case 'dotenv':
      return '.env';
    case 'wrangler':
      return '.dev.vars';
    case 'vercel':
      return '.env';
    case 'json':
      return '.json';
    case 'shell':
      return '.sh';
    case 'yaml':
      return '.yaml';
    default:
      return '';
  }
}

function ensureSuggestedName(baseName: string, format: HushArtifactFormat): string {
  const trimmed = baseName.trim() || 'artifact';
  const extension = formatToExtension(format);

  if (!extension || trimmed.endsWith(extension)) {
    return trimmed;
  }

  return `${trimmed}${extension}`;
}

function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

type Hints = {
  filename?: string;
  subpath?: string;
  materializeAs?: string;
};

function resolveArtifactPath(logicalPath: string, format: HushArtifactFormat, hints: Hints): { suggestedName: string; relativePath: string } {
  if (hints.materializeAs) {
    return {
      suggestedName: basename(hints.materializeAs),
      relativePath: hints.materializeAs,
    };
  }

  const defaultName = ensureSuggestedName(basename(logicalPath), format);
  const filename = hints.filename ? ensureSuggestedName(hints.filename, format) : defaultName;
  const defaultSubpath = logicalPath.split('/').filter(Boolean).slice(0, -1).join('/');
  const subpath = hints.subpath ?? defaultSubpath;

  return {
    suggestedName: filename,
    relativePath: subpath ? joinPosix(subpath, filename) : filename,
  };
}

function createTargetArtifact(
  targetName: string,
  target: HushTargetDefinition,
  resolution: HushTargetResolution,
  envVars: EnvVar[],
): HushTargetArtifactDescriptor | null {
  if (!isOutputFormat(target.format)) {
    return null;
  }

  const content = formatVars(envVars, target.format);
  const { suggestedName, relativePath } = resolveArtifactPath(`targets/${targetName}`, target.format, target);

  return {
    kind: 'file',
    source: 'target',
    target: targetName,
    logicalPath: `targets/${targetName}`,
    format: target.format,
    sensitive: Object.values(resolution.values).some((node) => node.entry.sensitive),
    provenance: Object.values(resolution.values).flatMap((node) => node.provenance),
    resolvedFrom: Array.from(new Set(Object.values(resolution.values).flatMap((node) => node.resolvedFrom))).sort(),
    suggestedName,
    relativePath,
    sha256: sha256(content),
    content,
  };
}

function shapeArtifact(
  path: string,
  node: HushResolvedNode,
  envVars: EnvVar[],
): HushArtifactDescriptor {
  const entry = node.entry as HushArtifactEntry;
  const { suggestedName, relativePath } = resolveArtifactPath(path, entry.format, entry);

  if (entry.type === 'binary') {
    const encoding = entry.encoding ?? 'base64';
    const rawValue = entry.value ?? '';
    const content = encoding === 'utf8' ? Buffer.from(rawValue, 'utf8') : Buffer.from(rawValue, 'base64');

    return {
      kind: 'binary',
      logicalPath: path,
      format: entry.format,
      sensitive: entry.sensitive,
      provenance: node.provenance,
      resolvedFrom: node.resolvedFrom,
      suggestedName,
      relativePath,
      encoding,
      sha256: sha256(content),
      content,
    };
  }

  const content = entry.value !== undefined
    ? entry.value
    : isOutputFormat(entry.format)
      ? formatVars(envVars, entry.format)
      : '';

  return {
    kind: 'file',
    logicalPath: path,
    format: entry.format,
    sensitive: entry.sensitive,
    provenance: node.provenance,
    resolvedFrom: node.resolvedFrom,
    suggestedName,
    relativePath,
    sha256: sha256(content),
    content,
  };
}

export function targetFormatToArtifactFormat(format: HushTargetDefinition['format']): HushArtifactFormat {
  return format;
}

export function shapeTargetArtifacts(
  targetName: string,
  target: HushTargetDefinition,
  resolution: HushTargetResolution,
): HushArtifactShapeResult {
  const { envVars, shadowed } = collectEnvVars(resolution.values, targetName);
  const env = toEnvRecord(envVars);
  const targetArtifact = createTargetArtifact(targetName, target, resolution, envVars);
  const artifacts = Object.entries(resolution.artifacts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, node]) => shapeArtifact(path, node, envVars));

  return {
    envVars,
    env,
    targetArtifact,
    artifacts,
    shadowed,
  };
}

export function shapeResolvedArtifacts(
  targetName: string,
  target: HushTargetDefinition,
  resolution: HushTargetResolution,
): HushArtifactShapeResult {
  return shapeTargetArtifacts(targetName, target, resolution);
}

export function shapeBundleArtifacts(resolution: HushTargetResolution | { values: HushTargetResolution['values']; artifacts: HushTargetResolution['artifacts'] }): HushArtifactShapeResult {
  const { envVars, shadowed } = collectEnvVars(resolution.values, 'bundle');
  const env = toEnvRecord(envVars);
  const artifacts = Object.entries(resolution.artifacts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, node]) => shapeArtifact(path, node, envVars));

  return {
    envVars,
    env,
    targetArtifact: null,
    artifacts,
    shadowed,
  };
}
