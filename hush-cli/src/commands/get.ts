import pc from 'picocolors';
import { maskValue } from '../core/mask.js';
import {
  appendCommandReadAudit,
  resolveTargetEnvView,
  type V3ResolvedEnvView,
} from './v3-command-helpers.js';
import type { GetOptions, HushContext } from '../types.js';

/**
 * Read a SINGLE secret's value from a resolved target.
 *
 * Masked by default (AI-safe, like `list`). `--reveal` prints the bare plaintext
 * value to stdout — and nothing else — so it is scriptable:
 *   CODE="$(hush get RELAY_INVITE_CODE --reveal)"
 * The provenance line and the plaintext warning go to stderr so they never
 * pollute a `$(…)` capture. `--json` emits a structured record.
 *
 * This fills the gap where the obvious `hush get <key>` previously errored with
 * "Unexpected argument", forcing `list --reveal | grep` (which dumps every
 * secret) just to read one value back.
 */
export async function getCommand(ctx: HushContext, options: GetOptions): Promise<void> {
  try {
    const command = { name: 'get', args: options.reveal ? ['--reveal'] : [] };
    const view = resolveTargetEnvView(ctx, options.store, options.target, command);
    appendCommandReadAudit(ctx, options.store, view, command);

    const match = view.envVars.find((variable) => variable.key === options.key);
    if (!match) {
      // Throw (not exit) so the catch reports it; this also narrows `match`
      // without an unreachable post-exit return.
      throw new Error(
        `Key "${options.key}" not found in target "${view.targetName}". `
        + `List keys with "hush list", or trace this one with "hush trace ${options.key}".`,
      );
    }

    const source = sourceForKey(view, options.key);

    if (options.json) {
      ctx.logger.log(JSON.stringify({
        key: options.key,
        value: options.reveal ? match.value : maskValue(match.value),
        target: view.targetName,
        source: source ?? null,
        revealed: Boolean(options.reveal),
      }));
      return;
    }

    if (options.reveal) {
      ctx.logger.error(pc.yellow('Warning: --reveal prints a plaintext secret value to stdout.'));
      // Bare value on stdout (scriptable); everything else to stderr.
      ctx.logger.log(match.value);
      ctx.logger.error(pc.dim(`# ${options.key} <- ${source ?? '(machine-local/unknown)'} in target ${view.targetName}`));
      return;
    }

    const origin = source ? pc.dim(`  (from ${source})`) : '';
    ctx.logger.log(`${pc.cyan(options.key)}=${pc.dim(maskValue(match.value))}${origin}`);
    ctx.logger.log(pc.dim('Value masked. Use --reveal to print plaintext (avoid in AI sessions).'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error(pc.red(message));
    ctx.process.exit(1);
  }
}

/**
 * Best-effort source file for a key, read from the resolution's per-key
 * provenance (the last record wins by precedence, matching toCompactRecord). A
 * key present in envVars but absent from the repository resolution came from the
 * machine-local override file.
 */
function sourceForKey(view: V3ResolvedEnvView, key: string): string | undefined {
  for (const [logicalPath, node] of Object.entries(view.resolution.values)) {
    const segment = logicalPath.split('/').filter(Boolean).at(-1);
    if (segment === key) {
      const primary = node.provenance.at(-1) ?? node.provenance[0];
      return primary?.filePath;
    }
  }
  return view.localOverrideFile;
}
