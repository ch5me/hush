import { join } from "node:path";

import pc from "picocolors";
import { stringify as yamlStringify } from "yaml";

import { ensureGlobalStoreBootstrap } from "../global-store.js";
import { keysList } from "../lib/age.js";
import { missingBinaryError } from "../lib/install-hints.js";
import { getProjectIdentifier } from "../project.js";
import { GLOBAL_STORE_KEY_IDENTITY } from "../store.js";
import { HushContext, StoreContext } from "../types.js";

export interface KeysOptions {
  store: StoreContext;
  subcommand: string;
  force?: boolean;
  /** Source platform for `hush keys pull --from <platform>` */
  from?: string;
  /** Vercel project ID for `hush keys pull --from vercel` */
  project?: string;
  /** Vercel team ID for `hush keys pull --from vercel` */
  team?: string;
  /** Vercel token (falls back to VERCEL_TOKEN env var) */
  token?: string;
}

function getProject(ctx: HushContext, store: StoreContext): string {
  if (store.mode === "global") {
    return GLOBAL_STORE_KEY_IDENTITY;
  }

  const discovered = ctx.config.findProjectRoot(store.root);
  if (discovered?.repositoryKind === "legacy-v2") {
    const config = ctx.config.loadConfig(discovered.projectRoot);
    if (config.project) {
      return config.project;
    }
  }

  const project = getProjectIdentifier(store.root);
  if (project) {
    return project;
  }

  ctx.logger.error(pc.red("No project identifier found."));
  ctx.logger.error(
    pc.dim('Add "project: my-project" to hush.yaml or a Git repository field to package.json'),
  );
  ctx.process.exit(1);
}

// ---------------------------------------------------------------------------
// Vercel key recovery helpers
// ---------------------------------------------------------------------------

interface VercelEnvEntry {
  key: string;
  value?: string;
  type?: string;
  target?: string[];
}

interface VercelEnvListResponse {
  envs?: VercelEnvEntry[];
  env?: VercelEnvEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractVercelErrorMessage(body: unknown, status: number): string {
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.message === "string") {
      return error.message;
    }
    if (typeof body.message === "string") {
      return body.message;
    }
  }
  return `HTTP ${status}`;
}

async function fetchVercelEnvVars(
  ctx: HushContext,
  projectId: string,
  teamId: string | undefined,
  token: string,
): Promise<VercelEnvEntry[]> {
  const params = new URLSearchParams({ decrypt: "true" });
  if (teamId) {
    params.set("teamId", teamId);
  }
  const url = `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env?${params.toString()}`;

  const fetchImpl = ctx.network?.fetch ?? fetch;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new Error(`Vercel API error: ${extractVercelErrorMessage(body, response.status)}`);
  }

  const data = body as VercelEnvListResponse;
  return data.envs ?? data.env ?? [];
}

function resolveVercelKeyRecoveryToken(ctx: HushContext, token?: string): string {
  const resolved = token?.trim() || ctx.process.env.VERCEL_TOKEN?.trim() || "";
  if (!resolved) {
    throw new Error("Vercel token required. Pass --token or export VERCEL_TOKEN.");
  }
  return resolved;
}

/** Pull SOPS_AGE_KEY from Vercel and install locally. Returns the installed public key. */
export async function keysRecoverFromVercel(
  ctx: HushContext,
  options: {
    project: string;
    team?: string;
    token?: string;
    project_name: string;
    force?: boolean;
  },
): Promise<string> {
  const token = resolveVercelKeyRecoveryToken(ctx, options.token);

  ctx.logger.log(pc.blue(`Fetching env vars from Vercel project ${pc.cyan(options.project)}...`));

  const envVars = await fetchVercelEnvVars(ctx, options.project, options.team, token);
  const sopsEntry = envVars.find((entry) => entry.key === "SOPS_AGE_KEY");

  if (!sopsEntry) {
    throw new Error(
      `SOPS_AGE_KEY not found in Vercel project "${options.project}". ` +
        "Ensure the project has a SOPS_AGE_KEY env var containing the age private key.",
    );
  }

  const privateKey = sopsEntry.value?.trim() ?? "";
  if (!privateKey.startsWith("AGE-SECRET-KEY-")) {
    throw new Error(
      "SOPS_AGE_KEY value does not look like an age private key (expected AGE-SECRET-KEY-... prefix).",
    );
  }

  // Derive the public key safely (never prints the private key).
  const publicKey = ctx.age.agePublicFromPrivate(privateKey);
  ctx.logger.log(pc.dim(`Derived public key: ${publicKey}`));

  if (ctx.age.keyExists(options.project_name) && !options.force) {
    ctx.logger.error(
      pc.yellow(`Key already exists for "${options.project_name}". Use --force to overwrite.`),
    );
    throw new Error(`Key already exists for "${options.project_name}".`);
  }

  ctx.age.keySave(options.project_name, { private: privateKey, public: publicKey });
  ctx.logger.log(pc.green(`Saved to ${ctx.age.keyPath(options.project_name)}`));
  ctx.logger.log(pc.dim(`Public: ${publicKey}`));

  return publicKey;
}

export async function keysCommand(ctx: HushContext, options: KeysOptions): Promise<void> {
  const { store, subcommand, force } = options;
  const root = store.root;

  switch (subcommand) {
    case "setup": {
      const project = getProject(ctx, store);
      ctx.logger.log(pc.blue(`Setting up keys for ${pc.cyan(project)}...`));

      if (ctx.age.keyExists(project)) {
        ctx.logger.log(pc.green("Key already exists locally."));
        return;
      }

      ctx.logger.log(pc.yellow(`No local key found for ${project}.`));
      ctx.logger.log(
        pc.dim(
          `Run "hush keys generate" to create one, or copy an age key into ${ctx.age.keyPath(project)}.`,
        ),
      );
      break;
    }

    case "generate": {
      if (!ctx.age.ageAvailable()) {
        throw missingBinaryError("age");
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

      if (store.mode === "global") {
        ensureGlobalStoreBootstrap(ctx, store, key.public);
        ctx.logger.log(pc.green("Bootstrapped ~/.hush"));
      }

      if (store.mode === "global") {
        break;
      }

      const sopsPath = join(root, ".sops.yaml");
      if (!ctx.fs.existsSync(sopsPath)) {
        if (!ctx.fs.existsSync(root)) {
          ctx.fs.mkdirSync(root, { recursive: true });
        }
        ctx.fs.writeFileSync(
          sopsPath,
          yamlStringify({ creation_rules: [{ encrypted_regex: ".*", age: key.public }] }),
        );
        ctx.logger.log(pc.green("Created .sops.yaml"));
      } else {
        ctx.logger.log(pc.yellow(".sops.yaml exists. Add this public key:"));
        ctx.logger.log(`  ${key.public}`);
      }
      break;
    }

    case "pull": {
      // `hush keys pull --from vercel` — recover the age key from a Vercel project env var.
      const from = options.from?.trim().toLowerCase();

      if (from !== "vercel") {
        ctx.logger.error(pc.red(`hush keys pull requires --from <platform>. Supported: vercel`));
        ctx.logger.log(
          pc.dim("Example: hush keys pull --from vercel --project prj_123 [--team team_456]"),
        );
        ctx.logger.log(pc.dim("Export VERCEL_TOKEN or pass --token."));
        ctx.process.exit(1);
      }

      if (!options.project) {
        ctx.logger.error(
          pc.red("hush keys pull --from vercel requires --project <vercel-project-id>"),
        );
        ctx.logger.log(pc.dim("Example: hush keys pull --from vercel --project prj_123"));
        ctx.process.exit(1);
      }

      const projectName = getProject(ctx, store);

      try {
        await keysRecoverFromVercel(ctx, {
          project: options.project,
          team: options.team,
          token: options.token,
          project_name: projectName,
          force,
        });
        ctx.logger.log(pc.green('\nKey installed. Run "hush doctor" to verify resolution.'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.error(pc.red(message));
        ctx.process.exit(1);
      }
      break;
    }

    case "push": {
      ctx.logger.error(
        pc.red("hush keys push was removed. Hush no longer integrates with 1Password."),
      );
      ctx.logger.log(
        pc.dim(
          "Back up ~/.config/sops/age/keys/<project>.txt using your own password manager workflow.",
        ),
      );
      ctx.process.exit(1);
    }

    case "list": {
      ctx.logger.log(pc.blue("Local keys:"));
      for (const k of keysList()) {
        ctx.logger.log(`  ${pc.cyan(k.project)} ${pc.dim(k.public.slice(0, 20))}...`);
      }

      break;
    }

    default:
      ctx.logger.error(pc.red(`Unknown: hush keys ${subcommand}`));
      ctx.logger.log(pc.dim("Commands: setup, generate, list, pull"));
      ctx.process.exit(1);
  }
}
