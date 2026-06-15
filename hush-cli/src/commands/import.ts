/**
 * `hush import add` command.
 *
 * Writes an explicit import declaration into the current repository's manifest
 * per the v3 spec. The import references an external store root and optionally
 * a specific bundle or file within that store.
 *
 * Design invariants:
 * - Pull-only: only the current repo's manifest is mutated, never the source store.
 * - Idempotent: re-running with identical args does not duplicate the declaration.
 * - Validates that the source root exists and (when --bundle is given) that the
 *   named bundle is declared in the source manifest.
 * - Never decrypts values from the source store; reads only structural names.
 */

import pc from 'picocolors';
import { stringify as stringifyYaml } from 'yaml';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { appendAuditEvent, createManifestDocument } from '../index.js';
import { persistV3ManifestDocument } from '../v3/repository.js';
import { requireMutableIdentity, requireV3Repository } from './v3-command-helpers.js';
import type { HushContext, ImportAddOptions } from '../types.js';

/**
 * Safely read target/bundle names from an external store's manifest without
 * decrypting any secret values.
 */
function readExternalManifestNames(storeRoot: string): { targetNames: string[]; bundleNames: string[] } | undefined {
  const manifestPath = join(storeRoot, '.hush', 'manifest.encrypted');
  if (!existsSync(manifestPath)) {
    return undefined;
  }
  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return undefined;

    const targets = parsed.targets;
    const bundles = parsed.bundles;
    return {
      targetNames: targets && typeof targets === 'object' && !Array.isArray(targets)
        ? Object.keys(targets as Record<string, unknown>)
        : [],
      bundleNames: bundles && typeof bundles === 'object' && !Array.isArray(bundles)
        ? Object.keys(bundles as Record<string, unknown>)
        : [],
    };
  } catch {
    return undefined;
  }
}

/**
 * Derive a stable import name from the source root path and optional bundle.
 * E.g. ~/.hush + bundle 'project' → 'global-project'
 *      ~/.hush (no bundle)        → 'global'
 *      /path/to/other-repo + bundle 'shared' → 'other-repo-shared'
 */
function deriveImportName(sourceRoot: string, bundle?: string): string {
  const home = process.env.HOME ?? '';
  const isGlobal = home && resolve(sourceRoot) === resolve(join(home, '.hush'));
  const baseName = isGlobal ? 'global' : basename(resolve(sourceRoot));
  return bundle ? `${baseName}-${bundle}` : baseName;
}

export async function importAddCommand(ctx: HushContext, options: ImportAddOptions): Promise<void> {
  const { store, sourceRoot, bundle, file: fileArg, json } = options;

  if (!sourceRoot) {
    ctx.logger.error(pc.red('Usage: hush import add --source-root <source-store-root> [--bundle <name>] [--file <path>] [--import-name <name>] [--json]'));
    ctx.process.exit(1);
  }

  const resolvedSourceRoot = resolve(sourceRoot);

  // Validate source root exists and has a v3 manifest.
  if (!existsSync(resolvedSourceRoot)) {
    ctx.logger.error(pc.red(`Source store root does not exist: ${resolvedSourceRoot}`));
    ctx.process.exit(1);
  }

  const sourceManifestPath = join(resolvedSourceRoot, '.hush', 'manifest.encrypted');
  if (!existsSync(sourceManifestPath)) {
    ctx.logger.error(pc.red(`Source root is not a v3 Hush store (no .hush/manifest.encrypted): ${resolvedSourceRoot}`));
    ctx.process.exit(1);
  }

  // Validate bundle name if provided (read-only, names only, no value decryption).
  if (bundle) {
    const names = readExternalManifestNames(resolvedSourceRoot);
    if (names && !names.bundleNames.includes(bundle)) {
      const available = names.bundleNames.length > 0 ? names.bundleNames.join(', ') : '(none)';
      ctx.logger.error(pc.red(`Bundle "${bundle}" not found in source store ${resolvedSourceRoot}.`));
      ctx.logger.error(pc.dim(`Available bundles: ${available}`));
      ctx.process.exit(1);
    }
  }

  const repository = requireV3Repository(store, 'import');
  const command = { name: 'import', args: ['add', '--source-root', resolvedSourceRoot, ...(bundle ? ['--bundle', bundle] : []), ...(fileArg ? ['--file', fileArg] : [])] };
  const activeIdentity = requireMutableIdentity(ctx, store, repository, command);

  // Derive a stable project identity string from the source manifest metadata,
  // or fall back to the basename of the source root.
  let projectName: string;
  try {
    const names = readExternalManifestNames(resolvedSourceRoot);
    // The source manifest metadata.project field — if present, use it as the
    // canonical project identity reference.
    const raw = existsSync(sourceManifestPath) ? readFileSync(sourceManifestPath, 'utf-8') : '';
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    const metadataProject = parsed?.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
      ? (parsed.metadata as Record<string, unknown>).project
      : undefined;
    projectName = typeof metadataProject === 'string' && metadataProject.trim()
      ? metadataProject.trim()
      : basename(resolvedSourceRoot);
    void names; // read for bundle validation above
  } catch {
    projectName = basename(resolvedSourceRoot);
  }

  const importName = options.importName ?? deriveImportName(resolvedSourceRoot, bundle);

  // Build the pull spec. Bundle names in `pull.bundles` must be namespaced paths
  // (e.g. `bundles/project`). Prefix bare names automatically so users can pass
  // `--bundle project` without needing to know the namespace convention.
  function toNamespacedBundle(name: string): string {
    return name.startsWith('bundles/') ? name : `bundles/${name}`;
  }

  function toNamespacedFile(path: string): string {
    // Files must be namespace-prefixed; if the user passed a bare path like
    // `env/project/shared`, it's already namespaced — leave it alone.
    const namespaces = ['env', 'artifacts', 'bundles', 'user', 'imports'];
    const first = path.split('/')[0] ?? '';
    return namespaces.includes(first) ? path : `env/${path}`;
  }

  const pull = {
    ...(bundle ? { bundles: [toNamespacedBundle(bundle)] } : {}),
    ...(fileArg ? { files: [toNamespacedFile(fileArg)] } : {}),
  };

  // If neither bundle nor file is specified, import everything by leaving pull
  // empty — the spec allows this (open pull).
  const existingImports = repository.manifest.imports ?? {};

  // Idempotency: if the same import name already has the same project + pull,
  // treat as a no-op.
  const existing = existingImports[importName];
  if (existing) {
    const existingBundles = existing.pull.bundles ?? [];
    const existingFiles = existing.pull.files ?? [];
    const newBundles = pull.bundles ?? [];
    const newFiles = pull.files ?? [];
    const sameProject = existing.project === projectName;
    const sameBundles = JSON.stringify([...existingBundles].sort()) === JSON.stringify([...newBundles].sort());
    const sameFiles = JSON.stringify([...existingFiles].sort()) === JSON.stringify([...newFiles].sort());

    if (sameProject && sameBundles && sameFiles) {
      const payload = { importName, project: projectName, pull, idempotent: true };
      if (json) {
        ctx.logger.log(JSON.stringify(payload, null, 2));
      } else {
        ctx.logger.log(pc.green(`Import "${importName}" already declared with identical configuration (no change).`));
        ctx.logger.log(pc.dim(stringifyYaml(payload, { indent: 2 }).trimEnd()));
      }
      return;
    }

    // Same name but different config → error; user should pick a different name or remove+re-add.
    ctx.logger.error(pc.red(`Import name "${importName}" already exists with different configuration.`));
    ctx.logger.error(pc.dim('Pass --import-name <name> to use a different import name, or remove the existing import first.'));
    ctx.process.exit(1);
  }

  const nextManifest = createManifestDocument({
    ...repository.manifest,
    imports: {
      ...existingImports,
      [importName]: {
        project: projectName,
        pull,
      },
    },
  });

  persistV3ManifestDocument(ctx, store, repository, nextManifest);

  appendAuditEvent(ctx, store, {
    type: 'metadata_change',
    activeIdentity,
    success: true,
    command,
    details: {
      importName,
      project: projectName,
      pullBundles: pull.bundles ?? [],
      pullFiles: pull.files ?? [],
    },
  });

  const payload = { importName, project: projectName, pull, added: true };
  if (json) {
    ctx.logger.log(JSON.stringify(payload, null, 2));
    return;
  }

  ctx.logger.log(pc.green(`Import "${importName}" added.`));
  ctx.logger.log(pc.dim(stringifyYaml(payload, { indent: 2 }).trimEnd()));
}
