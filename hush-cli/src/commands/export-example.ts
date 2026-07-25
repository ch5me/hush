import { join } from 'node:path';
import pc from 'picocolors';
import { writeJsonSuccess } from '../lib/command-output.js';
import { formatVars } from '../formats/index.js';
import { requireActiveIdentity } from '../v3/identity.js';
import { resolveV3Bundle, resolveV3Target } from '../v3/resolver.js';
import { requireV3Repository, selectRuntimeTarget } from './v3-command-helpers.js';
import type {
  EnvVar,
  ExportExampleOptions,
  HushArtifactEntry,
  HushBundleResolution,
  HushContext,
  HushTargetDefinition,
  HushTargetResolution,
  OutputFormat,
} from '../types.js';

type ExportSelection =
  | { kind: 'target'; name: string; target: HushTargetDefinition }
  | { kind: 'bundle'; name: string };

function isArtifactEntry(entry: unknown): entry is HushArtifactEntry {
  return typeof entry === 'object' && entry !== null && 'type' in entry;
}

function isOutputFormat(format: string): format is OutputFormat {
  return format === 'dotenv' || format === 'wrangler' || format === 'vercel' || format === 'json' || format === 'shell' || format === 'yaml';
}

function toSafeScalarValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function toSafeEnvVar(path: string, entry: HushTargetResolution['values'][string]['entry']): EnvVar | null {
  if (entry.sensitive) {
    return null;
  }

  const key = path.split('/').filter(Boolean).at(-1) ?? path;
  const value = toSafeScalarValue(entry.value);

  return { key, value };
}

function selectExportSubject(repository: ReturnType<typeof requireV3Repository>, options: Pick<ExportExampleOptions, 'target' | 'bundle'>): ExportSelection {
  if (options.target && options.bundle) {
    throw new Error('Use either --target or --bundle, not both.');
  }

  if (options.bundle) {
    if (!repository.manifest.bundles?.[options.bundle]) {
      throw new Error(`Bundle "${options.bundle}" not found. Available bundles: ${Object.keys(repository.manifest.bundles ?? {}).sort().join(', ') || '(none)'}`);
    }

    return { kind: 'bundle', name: options.bundle };
  }

  const { targetName, target } = selectRuntimeTarget(repository, options.target);
  return { kind: 'target', name: targetName, target };
}

function toSafeEnvVars(values: HushBundleResolution['values']): EnvVar[] {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([path, node]) => {
      const safeVar = toSafeEnvVar(path, node.entry);
      return safeVar ? [safeVar] : [];
    });
}

function countOmittedValues(values: HushBundleResolution['values']): number {
  return Object.values(values).filter((node) => node.entry.sensitive).length;
}

function formatEnvExample(envVars: EnvVar[]): string {
  if (envVars.length === 0) {
    return '(none)';
  }

  return formatVars(envVars, 'dotenv');
}

function formatArtifactExample(node: HushBundleResolution['artifacts'][string], safeEnvVars: EnvVar[]): string {
  const entry = node.entry;

  if (!isArtifactEntry(entry)) {
    return toSafeScalarValue(entry.value);
  }

  if (entry.sensitive) {
    return entry.type === 'binary'
      ? '[redacted binary artifact]'
      : '# [redacted sensitive artifact]';
  }

  if (entry.type === 'binary') {
    return entry.value ?? '[binary artifact with no inline payload]';
  }

  if (entry.value !== undefined) {
    return entry.value;
  }

  if (isOutputFormat(entry.format)) {
    return formatVars(safeEnvVars, entry.format);
  }

  return `[generated ${entry.format}]`;
}

function createBundleExampleOutput(selectionName: string, resolution: HushBundleResolution): string {
  const lines: string[] = [pc.blue('Hush export-example\n')];
  const safeEnvVars = toSafeEnvVars(resolution.values);
  const envExample = formatEnvExample(safeEnvVars);
  const omittedValues = countOmittedValues(resolution.values);

  lines.push(`Selection: ${pc.cyan(`bundle ${selectionName}`)}`);
  lines.push(`Active identity: ${pc.green(resolution.identity)}`);
  lines.push(`Resolved files: ${pc.cyan(String(resolution.files.length))}`);
  lines.push(`Protected values omitted: ${pc.cyan(String(omittedValues))}`);
  lines.push('');
  lines.push('Env example:');
  lines.push(...envExample.split(/\r?\n/).map((line) => `  ${line}`));
  lines.push('');
  lines.push('Artifacts:');

  const artifactEntries = Object.entries(resolution.artifacts).sort(([left], [right]) => left.localeCompare(right));
  if (artifactEntries.length === 0) {
    lines.push(`  ${pc.dim('(none)')}`);
  } else {
    for (const [path, node] of artifactEntries) {
      const label = isArtifactEntry(node.entry) ? `(${node.entry.type}:${node.entry.format})` : '';
      lines.push(`  ${path}${label ? ` ${pc.dim(label)}` : ''}`);
      for (const line of formatArtifactExample(node, safeEnvVars).split(/\r?\n/)) {
        lines.push(`    ${line}`);
      }
    }
  }

  return lines.join('\n');
}

function createTargetExampleOutput(selection: ExportSelection & { kind: 'target' }, resolution: HushTargetResolution): string {
  const safeEnvVars = toSafeEnvVars(resolution.values);
  const envExample = formatEnvExample(safeEnvVars);
  const omittedValues = countOmittedValues(resolution.values);
  const lines: string[] = [pc.blue('Hush export-example\n')];

  lines.push(`Selection: ${pc.cyan(`target ${selection.name}`)}`);
  lines.push(`Format: ${pc.dim(selection.target.format)}${selection.target.mode ? pc.dim(` (${selection.target.mode})`) : ''}`);
  lines.push(`Active identity: ${pc.green(resolution.identity)}`);
  lines.push(`Protected values omitted: ${pc.cyan(String(omittedValues))}`);
  lines.push('');
  lines.push('Target example:');

  const renderedTarget = selection.target.format === 'env'
    ? envExample
    : isOutputFormat(selection.target.format)
      ? formatVars(safeEnvVars, selection.target.format)
      : envExample;

  lines.push(...renderedTarget.split(/\r?\n/).map((line) => `  ${line}`));
  lines.push('');
  lines.push('Artifacts:');

  const artifactEntries = Object.entries(resolution.artifacts).sort(([left], [right]) => left.localeCompare(right));
  if (artifactEntries.length === 0) {
    lines.push(`  ${pc.dim('(none)')}`);
  } else {
    for (const [path, node] of artifactEntries) {
      const label = isArtifactEntry(node.entry) ? `(${node.entry.type}:${node.entry.format})` : '';
      lines.push(`  ${path}${label ? ` ${pc.dim(label)}` : ''}`);
      for (const line of formatArtifactExample(node, safeEnvVars).split(/\r?\n/)) {
        lines.push(`    ${line}`);
      }
    }
  }

  return lines.join('\n');
}

function stripAnsiCodes(text: string): string {
  // Remove ANSI escape sequences for clean file output
  return text.replace(/\[[0-9;]*m/g, '');
}

function resolveWritePath(options: ExportExampleOptions): string {
  // Use explicit writePath if provided, otherwise default to .env.example in the store root
  if (options.writePath) {
    return options.writePath;
  }
  return join(options.store.root, '.env.example');
}

function writeExampleFile(ctx: HushContext, filePath: string, content: string, force: boolean, quiet = false): void {
  // Strip ANSI codes for clean file content
  const cleanContent = stripAnsiCodes(content);

  if (ctx.fs.existsSync(filePath)) {
    const existing = ctx.fs.readFileSync(filePath, 'utf-8') as string;
    if (existing !== cleanContent) {
      if (!force) {
        throw new Error(
          `File already exists at ${filePath} with different content. Use --force to overwrite.`,
        );
      }
    }
  }

  ctx.fs.writeFileSync(filePath, cleanContent, 'utf-8');
  if (!quiet) ctx.logger.log(pc.green(`\nWrote example to ${filePath}`));
}

export async function exportExampleCommand(ctx: HushContext, options: ExportExampleOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'export-example');
  const selection = selectExportSubject(repository, options);
  const identity = requireActiveIdentity(ctx, options.store, repository.manifest.identities, {
    name: 'export-example',
    args: [selection.name],
  });

  if (selection.kind === 'bundle') {
    const resolution = resolveV3Bundle(ctx, {
      store: options.store,
      repository,
      bundleName: selection.name,
      activeIdentity: identity,
      command: { name: 'export-example', args: [selection.name] },
      // The example is committed and shared. One developer's machine-local keys
      // must never appear in it.
      machineLocal: 'exclude',
    });
    const output = createBundleExampleOutput(selection.name, resolution);
    const filePath = options.write ? resolveWritePath(options) : undefined;
    if (options.json) writeJsonSuccess(ctx, 'export-example', { selection, output, writtenTo: filePath ?? null });
    else ctx.logger.log(output);

    if (filePath) {
      writeExampleFile(ctx, filePath, output, options.force ?? false, options.json);
    }
    return;
  }

  const resolution = resolveV3Target(ctx, {
    store: options.store,
    repository,
    targetName: selection.name,
    activeIdentity: identity,
    command: { name: 'export-example', args: [selection.name] },
    machineLocal: 'exclude',
  });
  const output = createTargetExampleOutput(selection, resolution);
  const filePath = options.write ? resolveWritePath(options) : undefined;
  if (options.json) writeJsonSuccess(ctx, 'export-example', { selection, output, writtenTo: filePath ?? null });
  else ctx.logger.log(output);

  if (filePath) {
    writeExampleFile(ctx, filePath, output, options.force ?? false, options.json);
  }
}
