import { basename, join as joinPosix } from 'node:path/posix';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { formatVars } from '../formats/index.js';
import { formatDuplicateKeyHint } from '../commands/v3-command-helpers.js';
import type { EnvVar, OutputFormat } from '../types.js';
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

function collectEnvVars(values: HushTargetResolution['values'], target: string): EnvVar[] {
  const pairs = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, node]) => {
      const key = logicalPathToEnvKey(path);
      return {
        key,
        path,
        value: toEnvVarValue(node.entry.value),
      };
    });

  const collisions = new Map<string, string[]>();

  for (const pair of pairs) {
    const existing = collisions.get(pair.key) ?? [];
    existing.push(pair.path);
    collisions.set(pair.key, existing);
  }

  const duplicate = Array.from(collisions.entries()).find(([, paths]) => paths.length > 1);

  if (duplicate) {
    const duplicateFiles = duplicate[1]
      .map((path) => values[path]?.resolvedFrom ?? [])
      .flat()
      .sort((left, right) => left.localeCompare(right));
    const precedenceFiles = buildTargetPrecedenceFiles(values);

    throw new Error(
      `Multiple logical paths resolve to environment key "${duplicate[0]}": ${duplicate[1].sort().join(', ')}. `
      + formatDuplicateKeyHint(duplicate[0], duplicateFiles.length > 0 ? duplicateFiles : precedenceFiles, target),
    );
  }

  return pairs.map(({ key, value }) => ({ key, value }));
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
  const envVars = collectEnvVars(resolution.values, targetName);
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
  const envVars = collectEnvVars(resolution.values, 'bundle');
  const env = toEnvRecord(envVars);
  const artifacts = Object.entries(resolution.artifacts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, node]) => shapeArtifact(path, node, envVars));

  return {
    envVars,
    env,
    targetArtifact: null,
    artifacts,
  };
}
