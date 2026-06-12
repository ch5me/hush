import { join } from 'node:path';
import pc from 'picocolors';
import { stringify as yamlStringify } from 'yaml';
import { HushContext, StoreContext } from '../types.js';
import { keysList } from '../lib/age.js';
import { getProjectIdentifier } from '../project.js';
import { GLOBAL_STORE_KEY_IDENTITY } from '../store.js';
import { ensureGlobalStoreBootstrap } from '../global-store.js';
import { missingBinaryError } from '../lib/install-hints.js';

export interface KeysOptions {
  store: StoreContext;
  subcommand: string;
  force?: boolean;
}

function getProject(ctx: HushContext, store: StoreContext): string {
  if (store.mode === 'global') {
    return GLOBAL_STORE_KEY_IDENTITY;
  }

  const discovered = ctx.config.findProjectRoot(store.root);
  if (discovered?.repositoryKind === 'legacy-v2') {
    const config = ctx.config.loadConfig(discovered.projectRoot);
    if (config.project) {
      return config.project;
    }
  }

  const project = getProjectIdentifier(store.root);
  if (project) {
    return project;
  }

  ctx.logger.error(pc.red('No project identifier found.'));
  ctx.logger.error(pc.dim('Add "project: my-project" to hush.yaml or a GitHub repository field to package.json'));
  ctx.process.exit(1);
}

export async function keysCommand(ctx: HushContext, options: KeysOptions): Promise<void> {
  const { store, subcommand, force } = options;
  const root = store.root;
  
  switch (subcommand) {
    case 'setup': {
      const project = getProject(ctx, store);
      ctx.logger.log(pc.blue(`Setting up keys for ${pc.cyan(project)}...`));
      
      if (ctx.age.keyExists(project)) {
        ctx.logger.log(pc.green('Key already exists locally.'));
        return;
      }
      
      ctx.logger.log(pc.yellow(`No local key found for ${project}.`));
      ctx.logger.log(pc.dim(`Run "hush keys generate" to create one, or copy an age key into ${ctx.age.keyPath(project)}.`));
      break;
    }
    
    case 'generate': {
      if (!ctx.age.ageAvailable()) {
        throw missingBinaryError('age');
      }

      const project = getProject(ctx, store);
      
      if (ctx.age.keyExists(project) && !force) {
        ctx.logger.error(pc.yellow(`Key exists for ${project}. Use --force to overwrite.`));
        ctx.process.exit(1);
      }

      ctx.logger.log(pc.blue(`Generating key for ${pc.cyan(project)}...`));
      const key = ctx.age.ageGenerate();
      ctx.age.keySave(project, key);
      ctx.logger.log(pc.green(`Saved to ${ctx.age.keyPath(project)}`));
      ctx.logger.log(pc.dim(`Public: ${key.public}`));

      if (store.mode === 'global') {
        ensureGlobalStoreBootstrap(ctx, store, key.public);
        ctx.logger.log(pc.green('Bootstrapped ~/.hush'));
      }
      
      if (store.mode === 'global') {
        break;
      }

      const sopsPath = join(root, '.sops.yaml');
      if (!ctx.fs.existsSync(sopsPath)) {
        if (!ctx.fs.existsSync(root)) {
          ctx.fs.mkdirSync(root, { recursive: true });
        }
        ctx.fs.writeFileSync(sopsPath, yamlStringify({ creation_rules: [{ encrypted_regex: '.*', age: key.public }] }));
        ctx.logger.log(pc.green('Created .sops.yaml'));
      } else {
        ctx.logger.log(pc.yellow('.sops.yaml exists. Add this public key:'));
        ctx.logger.log(`  ${key.public}`);
      }
      break;
    }
    
    case 'pull': {
      ctx.logger.error(pc.red('hush keys pull was removed. Hush no longer integrates with 1Password.'));
      ctx.logger.log(pc.dim('Copy the age private key into ~/.config/sops/age/keys/<project>.txt, then run "hush keys setup".'));
      ctx.process.exit(1);
    }
    
    case 'push': {
      ctx.logger.error(pc.red('hush keys push was removed. Hush no longer integrates with 1Password.'));
      ctx.logger.log(pc.dim('Back up ~/.config/sops/age/keys/<project>.txt using your own password manager workflow.'));
      ctx.process.exit(1);
    }
    
    case 'list': {
      ctx.logger.log(pc.blue('Local keys:'));
      for (const k of keysList()) {
        ctx.logger.log(`  ${pc.cyan(k.project)} ${pc.dim(k.public.slice(0, 20))}...`);
      }

      break;
    }

    default:
      ctx.logger.error(pc.red(`Unknown: hush keys ${subcommand}`));
      ctx.logger.log(pc.dim('Commands: setup, generate, list'));
      ctx.process.exit(1);
  }
}
