import { stringify as stringifyYaml } from 'yaml';
import type { HushContext, TargetAddOptions, TargetListOptions, TargetRemoveOptions } from '../types.js';
import { appendAuditEvent, createManifestDocument, createTargetDefinition } from '../index.js';
import { persistV3ManifestDocument } from '../v3/repository.js';
import { requireMutableIdentity, requireV3Repository } from './v3-command-helpers.js';
import { withSuggestion } from './mutation-feedback.js';
import { writeJsonSuccess } from '../lib/command-output.js';

type TargetSubcommand = 'add' | 'remove' | 'list';

function getSubcommand(options: TargetAddOptions | TargetRemoveOptions | TargetListOptions): TargetSubcommand {
  if ('subcommand' in options && options.subcommand) {
    return options.subcommand as TargetSubcommand;
  }
  if ('name' in options && options.name) {
    return 'add';
  }
  return 'list';
}

export async function targetCommand(
  ctx: HushContext,
  options: TargetAddOptions | TargetRemoveOptions | TargetListOptions,
): Promise<void> {
  const subcommand = getSubcommand(options);

  switch (subcommand) {
    case 'add':
      await handleAdd(ctx, options as TargetAddOptions);
      return;
    case 'remove':
      await handleRemove(ctx, options as TargetRemoveOptions);
      return;
    case 'list':
      await handleList(ctx, options as TargetListOptions);
      return;
  }
}

async function handleAdd(ctx: HushContext, options: TargetAddOptions): Promise<void> {
  if (!options.format) {
    throw new Error('--format is required for target add');
  }

  if (!options.bundle) {
    throw new Error('--bundle is required for target add');
  }

  const repository = requireV3Repository(options.store, 'target add');
  const bundle = options.bundle;
  const command = { name: 'target', args: ['add', options.name, '--bundle', bundle, '--format', options.format] };
  const activeIdentity = requireMutableIdentity(ctx, options.store, repository, command);

  const bundles = repository.manifest.bundles ?? {};
  if (!(options.bundle in bundles)) {
    throw new Error(withSuggestion(
      `Bundle "${options.bundle}" is not declared in this repository. No target was changed.`,
      options.bundle,
      Object.keys(bundles),
    ));
  }

  const targetDef = createTargetDefinition({
    bundle: options.bundle,
    format: options.format,
    mode: options.mode as 'process' | 'file' | 'example' | undefined,
    filename: options.filename,
    subpath: options.subpath,
    materializeAs: options.materializeAs,
  });

  const existingTarget = repository.manifest.targets?.[options.name];
  if (existingTarget) {
    if (JSON.stringify(existingTarget) === JSON.stringify(targetDef)) {
      const payload = { action: 'add-target', changed: false, name: options.name, ...targetDef };
      if (options.json) writeJsonSuccess(ctx, 'target', payload);
      else ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
      return;
    }
    throw new Error(`Target "${options.name}" already exists with different configuration. No target was changed. Remove it explicitly before replacing it.`);
  }

  const nextManifest = createManifestDocument({
    ...repository.manifest,
    targets: {
      ...(repository.manifest.targets ?? {}),
      [options.name]: targetDef,
    },
  });

  persistV3ManifestDocument(ctx, options.store, repository, nextManifest);

  appendAuditEvent(ctx, options.store, {
    type: 'metadata_change',
    activeIdentity,
    success: true,
    command,
    details: { target: options.name, action: 'add' },
  });

  if (options.json) {
    writeJsonSuccess(ctx, 'target', { action: 'add-target', changed: true, name: options.name, ...targetDef });
    return;
  }

  ctx.logger.log(stringifyYaml({ name: options.name, ...targetDef }, { indent: 2 }).trimEnd());
}

async function handleRemove(ctx: HushContext, options: TargetRemoveOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'target remove');
  const command = { name: 'target', args: ['remove', options.name] };
  const activeIdentity = requireMutableIdentity(ctx, options.store, repository, command);

  const targets = repository.manifest.targets ?? {};
  if (!targets[options.name]) {
    throw new Error(withSuggestion(`Target "${options.name}" was not found. Nothing was removed.`, options.name, Object.keys(targets)));
  }

  const nextTargets = { ...targets };
  delete nextTargets[options.name];

  const nextManifest = createManifestDocument({
    ...repository.manifest,
    targets: Object.keys(nextTargets).length > 0 ? nextTargets : undefined,
  });

  persistV3ManifestDocument(ctx, options.store, repository, nextManifest);

  appendAuditEvent(ctx, options.store, {
    type: 'metadata_change',
    activeIdentity,
    success: true,
    command,
    details: { target: options.name, action: 'remove' },
  });

  const payload = { action: 'remove-target', changed: true, name: options.name };
  if (options.json) writeJsonSuccess(ctx, 'target', payload);
  else ctx.logger.log(`Removed target "${options.name}"`);
}

async function handleList(ctx: HushContext, options: TargetListOptions): Promise<void> {
  const repository = requireV3Repository(options.store, 'target list');
  const targets = repository.manifest.targets ?? {};

  if (options.json) {
    writeJsonSuccess(ctx, 'target', { targets });
    return;
  }

  ctx.logger.log(stringifyYaml(targets, { indent: 2 }).trimEnd());
}
