#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import pc from "picocolors";

import { bootstrapCommand } from "./commands/bootstrap.js";
import { bundleCommand } from "./commands/bundle.js";
import { checkCommand } from "./commands/check.js";
import { completionCommand } from "./commands/completion.js";
import { configCommand } from "./commands/config.js";
import { copyKeyCommand } from "./commands/copy-key.js";
import { decryptCommand } from "./commands/decrypt.js";
import { deleteKeyCommand } from "./commands/delete-key.js";
import { diffCommand } from "./commands/diff.js";
import { doctorCommand } from "./commands/doctor.js";
import { editCommand } from "./commands/edit.js";
import { encryptCommand } from "./commands/encrypt.js";
import { expansionsCommand } from "./commands/expansions.js";
import { exportExampleCommand } from "./commands/export-example.js";
import { fileCommand } from "./commands/file.js";
import { hasCommand } from "./commands/has.js";
import { importAddCommand } from "./commands/import.js";
import { initCommand } from "./commands/init.js";
import { inspectCommand } from "./commands/inspect.js";
import { keysCommand } from "./commands/keys.js";
import { listCommand } from "./commands/list.js";
import { materializeCommand } from "./commands/materialize.js";
import { migrateCommand } from "./commands/migrate.js";
import { projectCommand } from "./commands/project.js";
import { pushCommand } from "./commands/push.js";
import { resolveCommand } from "./commands/resolve.js";
import { runCommand } from "./commands/run.js";
import { setCommand } from "./commands/set.js";
import { skillCommand } from "./commands/skill.js";
import { statusCommand } from "./commands/status.js";
import { targetCommand } from "./commands/target.js";
import { templateCommand } from "./commands/template.js";
import { traceCommand } from "./commands/trace.js";
import { verifyTargetCommand } from "./commands/verify-target.js";
import { findProjectRoot } from "./config/loader.js";
import { defaultContext } from "./context.js";
import { jsonError } from "./lib/command-output.js";
import { resolveStoreContext } from "./store.js";
import type { Environment, StoreMode, VercelEnvironment } from "./types.js";
import { checkForUpdate } from "./utils/version-check.js";

// Injected at single-binary compile time via `bun build --compile --define HUSH_EMBEDDED_VERSION=...`;
// undefined when running from the npm package under node.
declare const HUSH_EMBEDDED_VERSION: string | undefined;

function resolveVersion(): string {
  if (typeof HUSH_EMBEDDED_VERSION === "string") {
    return HUSH_EMBEDDED_VERSION;
  }
  const require = createRequire(import.meta.url);
  const { version } = require("../package.json") as { version: string };
  return version;
}

const VERSION = resolveVersion();

function printHelp(): void {
  console.log(`
${pc.bold("hush")} - AI-native encrypted config for projects and teams

${pc.bold("Usage:")}
  hush <command> [options]

${pc.bold("Commands:")}
  bootstrap         Bootstrap a v3 .hush repository
  config            Inspect or update v3 repository config
  init              Deprecated alias for bootstrap
  encrypt           Retired legacy helper; use hush migrate --from v2
  run -- <cmd>      Run command with secrets in memory (AI-safe)
  set <KEY> [VALUE] Set a single secret (AI-safe, prompts if no value)
  copy-key <KEY>    Copy one key between encrypted v3 files without printing it
  move-key <KEY>    Move one key between encrypted v3 files without printing it
  delete-key <KEY>  Delete one key from an encrypted v3 file (--from <file>)
  edit [file]       Edit secrets in $EDITOR (alias or declared v3 file path)
  list              List all variables (values masked; --reveal to show)
  inspect           List all variables (masked values, AI-safe)
  has <key>         Check if a secret exists (exit 0 if set, 1 if not)
  check             Verify secrets are encrypted (for pre-commit hooks)
  push              Push secrets to Cloudflare (Workers/Pages) or Vercel
  status            Show configuration and status
  doctor            Diagnose root, key, and store resolution for the current directory
  skill             Install Claude Code / OpenCode skill
  completion        Generate shell completion script (bash|zsh|fish)
  keys <cmd>        Manage SOPS age keys (setup, generate, list, pull --from vercel)
  migrate           Migrate a legacy hush.yaml repo to v3
  materialize       Write target or bundle artifacts to disk for CI/tooling
  verify-target     Verify a target resolves required keys (AI-safe)
  project <cmd>     Reconcile Hush target, Wrangler vars, remote secrets, and provider checks

${pc.bold("Debugging Commands:")}
  resolve <target>  Show what variables a target receives (AI-safe)
  trace <key>       Trace a variable through sources and targets (AI-safe)
  verify-target <target> --require KEY  Check target completeness (AI-safe)
  diff              Compare current v3 state against HEAD or --ref (AI-safe)
  export-example    Emit a redacted target or bundle example (AI-safe)
  template          Retired legacy helper; use hush migrate --from v2
  expansions        Retired legacy helper; use hush migrate --from v2

${pc.bold("Advanced Commands:")}
  decrypt --force   Write secrets to disk (requires confirmation, last resort)
  file <cmd>        Manage encrypted files (add, remove, list, readers)
  bundle <cmd>      Manage bundles (add, add-file, remove-file, remove, list)
  target <cmd>      Manage targets (add, remove, list)
  import add        Bind a bundle or file from another encrypted repository

${pc.bold("Options:")}
  -e, --env <env>   Environment: development or production (set and legacy commands; not valid for run)
  -r, --root <dir>  Start directory for project mode, execution directory for run (default: current directory)
  -t, --target <t>  Target selection (run/resolve/push/materialize/diff/export-example/verify-target; not set)
  -q, --quiet       Suppress output (has/check commands)
  --dry-run         Preview changes without applying
  --verbose         Show detailed output (push --dry-run only)
  --vercel          Push the selected Hush target to Vercel
  --project <id>    Vercel project id (push --vercel only)
  --team <id>       Vercel team id (push --vercel and keys pull --from vercel)
  --environment <e> Vercel environment: production, preview, development (repeatable; push --vercel only)
  --wrangler-env <e> Wrangler environment for stage-scoped Cloudflare push (e.g. staging, production)
  --token <tok>     Vercel token for keys pull --from vercel (falls back to VERCEL_TOKEN)
  --warn            Warn but exit 0 on drift (check only)
  --json            Output machine-readable JSON where supported
  --require <key>   Require key for verify-target (repeatable)
  --config <path>   Project env config file for hush project (project only)
  --only-changed    Only check git-modified files (check only)
  --require-source  Fail if source file is missing (check only)
  --allow-plaintext Allow plaintext .env files (check only, not recommended)
  --global          Use explicit global store at ~/.hush (or install skill globally)
  --local           Install skill to ./.claude/skills/ (skill only); legacy alias for set repo-local writes
  --file <path>     Set destination file alias or declared v3 file path (set only)
  --repo-local      Write to repo-local machine overrides (set only)
  --gui             Use a native dialog for input (set only, for AI agents)
  --reveal          Print plaintext values (list only; avoid in AI sessions)
  --skip-remote     Skip remote worker secret metadata checks (project only)
  --skip-provider   Skip provider validation checks (project only)
  --surface <name>  Select a project surface from the project config (project only)
  --ref <git-ref>   Compare diff output against a git ref (diff only)
  --bundle <name>   Resolve a specific bundle (diff/export-example only)
  --from <version>  Legacy repo version to migrate from (migrate only)
  --from <file>     Source v3 file for copy-key/move-key
  --cleanup         Remove validated v2 leftovers after migration (migrate only)
  --new-repo        Force child-local bootstrap; ignore parent .hush/ discovery
  --yes, -y         Skip interactive confirmation during bootstrap
  --output-root <d> Destination root for materialized files (materialize only)
  --to <dir>        Alias for --output-root (materialize only)
  --to <file>       Destination v3 file for copy-key/move-key
  -h, --help        Show this help message
  -v, --version     Show version number

${pc.bold("Repository Model (current v3):")}
  Hush stores repo authority in encrypted-at-rest v3 docs:

    .hush/manifest.encrypted
    .hush/files/**.encrypted

  Use ${pc.cyan("hush bootstrap")} to create a repo and ${pc.cyan("hush migrate --from v2")} to convert
  a legacy ${pc.cyan("hush.yaml")} repo. Normal runtime commands do not use hush.yaml.

${pc.bold("Examples:")}
  hush bootstrap                Bootstrap a v3 repo + active identity
  hush config show             Show v3 config structure
  hush config active-identity  Show or switch the active identity
  hush init                     Deprecated alias for bootstrap
  hush migrate --from v2        Inventory or convert a legacy hush.yaml repo to v3
  hush completion zsh           Install shell completion (see: hush completion --help)
  hush run -- npm start         Run with secrets in memory (AI-safe!)
  hush run -t api -- wrangler dev  Run a specific v3 target
  hush set DATABASE_URL         Set a secret interactively (prompts for value)
  hush set API_KEY "myvalue"    Set a secret inline (no prompt)
  echo "val" | hush set KEY     Set a secret from piped input
  hush set API_KEY --gui        Set secret via GUI dialog (for AI agents)
  hush set --global OPENAI_API_KEY  Set a global secret in ~/.hush
  hush run --global -- npm start    Run with global secrets only
  hush set API_KEY -e prod      Set a production secret
  hush set WORKER_ENV staging --file env/project/staging
  hush copy-key RESEND_API_KEY --from env/project/production --to env/api/production
  hush move-key RESEND_API_KEY --from env/project/production --to env/api/production
  hush delete-key OLD_KEY --from env/project/shared
  hush keys setup               Verify local age key
  hush keys generate            Generate new local age key
  hush keys pull --from vercel --project prj_123  Recover age key from Vercel SOPS_AGE_KEY
  hush edit                     Edit all shared secrets in $EDITOR
  hush edit development         Edit development secrets in $EDITOR
  hush edit local               Edit personal local overrides
  hush edit env/targets/media/runtime  Edit a declared v3 file (see hush file list)
  hush inspect                  List all variables (masked, AI-safe)
  hush has DATABASE_URL         Check if DATABASE_URL is set
  hush has API_KEY -q && echo "API_KEY is configured"
  hush check                    Verify secrets are encrypted
  hush push --dry-run           Preview configured remote push targets
  hush push -t app              Push only the 'app' target
  hush push --vercel -t web --project prj_123 --environment production --dry-run
  hush push -t worker --wrangler-env staging --dry-run   Stage-scoped Cloudflare push
  hush status                   Show current status
  hush diff                     Compare current runtime target against HEAD
  hush diff --ref HEAD~1        Compare current runtime target against HEAD~1
  hush diff --bundle project    Compare a bundle against HEAD
  hush verify-target api-production --require DATABASE_URL --require RESEND_API_KEY
  hush project plan staging
  hush project validate staging --skip-remote
  hush project sync production --dry-run
  hush export-example           Emit a safe example for the default target
  hush export-example --bundle project  Emit a safe example from a bundle
  hush materialize -t runtime --json --to /tmp/hush-out
  hush materialize -t ios-signing --to /tmp/fitbot-signing -- bash scripts/ci/install-ios-signing.sh /tmp/fitbot-signing
  hush materialize --bundle fitbot-signing --to /tmp/fitbot-signing
  hush skill                    Install Claude skill (interactive)
`);
}

type FileKey = "shared" | "development" | "production" | "local";

export interface ParsedArgs {
  /** Canonical option names explicitly supplied by the operator. */
  suppliedOptions: string[];
  helpRequested: boolean;
  command: string;
  subcommand?: string;
  env: Environment;
  envExplicit: boolean;
  root: string;
  dryRun: boolean;
  verbose: boolean;
  quiet: boolean;
  warn: boolean;
  json: boolean;
  onlyChanged: boolean;
  requireSource: boolean;
  allowPlaintext: boolean;
  global: boolean;
  local: boolean;
  force: boolean;
  gui: boolean;
  roles?: string;
  identities?: string;
  ref?: string;
  bundle?: string;
  from?: string;
  cleanup: boolean;
  newRepo: boolean;
  yes: boolean;
  outputRoot?: string;
  file?: string;
  key?: string;
  value?: string;
  setFile?: string;
  target?: string;
  requireKeys: string[];
  positionalArgs: string[];
  cmdArgs: string[];
  // file/bundle/target options
  format?: string;
  mode?: string;
  filename?: string;
  subpath?: string;
  materializeAs?: string;
  keepFile?: boolean;
  files?: string;
  repoLocal: boolean;
  reveal: boolean;
  write: boolean;
  /** Override the derived import name for `hush import add`. */
  importName?: string;
  /** Source store root for `hush import add --source-root <path>`. */
  sourceRoot?: string;
  projectConfig?: string;
  surface?: string;
  skipRemote: boolean;
  skipProvider: boolean;
  vercel: boolean;
  project?: string;
  team?: string;
  environments: VercelEnvironment[];
  /** Wrangler --env for stage-scoped Cloudflare push (e.g. "staging", "production"). */
  wranglerEnv?: string;
  /** Token for `hush keys pull --from vercel` (falls back to VERCEL_TOKEN). */
  keysToken?: string;
}

const OPTION_ALIASES: Readonly<Record<string, string>> = {
  "-e": "--env",
  "-f": "--force",
  "-q": "--quiet",
  "-r": "--root",
  "--cwd": "--root",
  "-t": "--target",
  "-y": "--yes",
  "--output-root": "--to",
};

const RECOGNIZED_OPTIONS = new Set([
  "--env",
  "--environment",
  "--root",
  "--cwd",
  "--dry-run",
  "--verbose",
  "--quiet",
  "--warn",
  "--json",
  "--only-changed",
  "--require-source",
  "--require",
  "--allow-plaintext",
  "--global",
  "--local",
  "--force",
  "--gui",
  "--repo-local",
  "--reveal",
  "--write",
  "--roles",
  "--identities",
  "--ref",
  "--bundle",
  "--file",
  "--files",
  "--from",
  "--cleanup",
  "--new-repo",
  "--yes",
  "--output-root",
  "--to",
  "--format",
  "--mode",
  "--filename",
  "--subpath",
  "--materialize-as",
  "--import-name",
  "--source-root",
  "--config",
  "--surface",
  "--vercel",
  "--project",
  "--team",
  "--wrangler-env",
  "--token",
  "--skip-remote",
  "--skip-provider",
  "--keep-file",
  "--target",
  "-e",
  "-f",
  "-q",
  "-r",
  "-t",
  "-y",
]);

const SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  config: ["show", "active-identity", "readers"],
  keys: ["setup", "generate", "list", "pull"],
  project: ["plan", "validate", "sync"],
  file: ["add", "remove", "list", "readers"],
  bundle: ["add", "add-file", "remove-file", "remove", "list"],
  target: ["add", "remove", "list"],
  import: ["add"],
  completion: ["bash", "zsh", "fish"],
};

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[right.length];
}

export function suggestUnique(input: string, candidates: readonly string[]): string | null {
  const ranked = candidates
    .map((candidate) => ({ candidate, distance: editDistance(input, candidate) }))
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  if (!ranked[0] || ranked[0].distance > 2 || ranked[1]?.distance === ranked[0].distance)
    return null;
  return ranked[0].candidate;
}

function failCli(args: {
  code: string;
  message: string;
  command?: string;
  rejectedInput?: string;
  suggestion?: string;
  json: boolean;
}): never {
  if (args.json) {
    console.error(
      jsonError(args.command ?? "cli", {
        code: args.code,
        message: args.message,
        rejectedInput: args.rejectedInput,
        suggestion: args.suggestion,
      }),
    );
  } else {
    console.error(pc.red(`Error: ${args.message}`));
    if (args.suggestion) console.error(pc.dim(`Did you mean: ${args.suggestion}`));
  }
  process.exit(1);
}

function failUnknownSubcommand(
  command: string,
  subcommand: string | undefined,
  json: boolean,
): never {
  const rejected = subcommand ?? "(none)";
  const suggestion = subcommand ? suggestUnique(subcommand, SUBCOMMANDS[command] ?? []) : null;
  return failCli({
    code: "UNKNOWN_SUBCOMMAND",
    message: `Unknown ${command} subcommand: ${rejected}`,
    command,
    rejectedInput: subcommand,
    suggestion: suggestion ? `hush ${command} ${suggestion}` : undefined,
    json,
  });
}

function collectSuppliedOptions(args: string[]): string[] {
  const supplied = new Set<string>();
  for (const arg of args) {
    if (arg === "--") break;
    if (RECOGNIZED_OPTIONS.has(arg)) supplied.add(OPTION_ALIASES[arg] ?? arg);
  }
  return [...supplied];
}

const COMMON_STORE_OPTIONS = ["--root", "--global"] as const;
const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  init: COMMON_STORE_OPTIONS,
  bootstrap: [...COMMON_STORE_OPTIONS, "--new-repo", "--yes"],
  config: [...COMMON_STORE_OPTIONS, "--roles", "--identities", "--json"],
  encrypt: COMMON_STORE_OPTIONS,
  decrypt: [...COMMON_STORE_OPTIONS, "--env", "--force"],
  run: [...COMMON_STORE_OPTIONS, "--target", "--json"],
  set: [...COMMON_STORE_OPTIONS, "--env", "--local", "--file", "--gui", "--repo-local", "--json"],
  "copy-key": [...COMMON_STORE_OPTIONS, "--from", "--to", "--json"],
  "move-key": [...COMMON_STORE_OPTIONS, "--from", "--to", "--json"],
  "delete-key": [...COMMON_STORE_OPTIONS, "--from", "--yes", "--json"],
  edit: COMMON_STORE_OPTIONS,
  list: [...COMMON_STORE_OPTIONS, "--env", "--reveal", "--json"],
  inspect: [...COMMON_STORE_OPTIONS, "--env", "--json"],
  has: [...COMMON_STORE_OPTIONS, "--env", "--quiet", "--json"],
  check: [
    ...COMMON_STORE_OPTIONS,
    "--warn",
    "--json",
    "--quiet",
    "--only-changed",
    "--require-source",
    "--allow-plaintext",
  ],
  push: [
    ...COMMON_STORE_OPTIONS,
    "--dry-run",
    "--verbose",
    "--target",
    "--vercel",
    "--project",
    "--team",
    "--environment",
    "--wrangler-env",
  ],
  project: [
    ...COMMON_STORE_OPTIONS,
    "--config",
    "--surface",
    "--json",
    "--dry-run",
    "--skip-remote",
    "--skip-provider",
  ],
  status: [...COMMON_STORE_OPTIONS, "--json"],
  doctor: ["--root", "--new-repo", "--json"],
  skill: ["--root", "--global", "--local"],
  completion: [],
  keys: [...COMMON_STORE_OPTIONS, "--force", "--from", "--project", "--team", "--token"],
  resolve: [...COMMON_STORE_OPTIONS, "--env", "--target", "--json"],
  trace: [...COMMON_STORE_OPTIONS, "--env", "--json"],
  "verify-target": [...COMMON_STORE_OPTIONS, "--env", "--target", "--require", "--json"],
  diff: [...COMMON_STORE_OPTIONS, "--env", "--target", "--bundle", "--ref", "--json"],
  "export-example": [
    ...COMMON_STORE_OPTIONS,
    "--env",
    "--target",
    "--bundle",
    "--write",
    "--to",
    "--force",
    "--json",
  ],
  template: ["--root", "--env"],
  expansions: ["--root", "--env"],
  migrate: ["--root", "--dry-run", "--from", "--cleanup"],
  materialize: [...COMMON_STORE_OPTIONS, "--target", "--bundle", "--json", "--to", "--cleanup"],
  file: [...COMMON_STORE_OPTIONS, "--roles", "--identities", "--keep-file", "--json"],
  bundle: [...COMMON_STORE_OPTIONS, "--files", "--json"],
  target: [
    ...COMMON_STORE_OPTIONS,
    "--bundle",
    "--format",
    "--mode",
    "--filename",
    "--subpath",
    "--materialize-as",
    "--json",
  ],
  import: [
    ...COMMON_STORE_OPTIONS,
    "--source-root",
    "--bundle",
    "--file",
    "--import-name",
    "--json",
  ],
};

const COMMAND_SUMMARIES: Readonly<Record<string, string>> = {
  init: "Deprecated alias for bootstrap.",
  bootstrap: "Create or adopt a v3 encrypted repository.",
  config: "Inspect or update repository identities and readers.",
  encrypt: "Encrypt legacy plaintext environment files.",
  decrypt: "Decrypt legacy files to disk as an explicit last resort.",
  run: "Resolve a target and run a child process with values in memory.",
  set: "Write one value to one explicit repository or machine-local destination.",
  "copy-key": "Copy a key between declared files.",
  "move-key": "Move a key between declared files.",
  "delete-key": "Delete a key from a declared file.",
  edit: "Edit one encrypted file.",
  list: "List keys without revealing values by default.",
  inspect: "Inspect repository structure and metadata.",
  has: "Test whether a key exists.",
  check: "Check source and repository policy.",
  push: "Push a resolved target to a configured provider.",
  project: "Plan, validate, or synchronize a project environment.",
  status: "Show repository status.",
  doctor: "Diagnose repository and key configuration.",
  skill: "Install the generated Hush AI skill.",
  completion: "Generate shell completion.",
  keys: "Manage local age keys.",
  resolve: "Show the values and sources selected for a target.",
  trace: "Trace one key through files, bundles, and targets.",
  "verify-target": "Verify that a target resolves required keys.",
  diff: "Compare resolved state with a Git reference.",
  "export-example": "Emit a redacted example for a target or bundle.",
  template: "Retired legacy helper.",
  expansions: "Retired legacy helper.",
  migrate: "Migrate a legacy v2 repository to v3.",
  materialize: "Materialize target artifacts and optionally run a command.",
  file: "Add, remove, list, or update readers for encrypted files.",
  bundle: "Add, remove, list, or modify bundles.",
  target: "Add, remove, or list targets.",
  import: "Bind a bundle or file from another encrypted repository.",
};

const COMMAND_USAGE: Readonly<Record<string, string>> = {
  set: "hush set <KEY> [VALUE] [--file <path> | --repo-local | --env <development|production>]",
  run: "hush run [--target <name>] -- <command> [args...]",
  resolve: "hush resolve <target> [--json]",
  trace: "hush trace <KEY> [--json]",
  "verify-target": "hush verify-target <target> [--require <KEY> ...] [--json]",
  "copy-key": "hush copy-key <KEY> --from <file> --to <file> [--json]",
  "move-key": "hush move-key <KEY> --from <file> --to <file> [--json]",
  "delete-key": "hush delete-key <KEY> --from <file> [--yes] [--json]",
  file: "hush file <add|remove|list|readers> [args] [options]",
  bundle: "hush bundle <add|add-file|remove-file|remove|list> [args] [options]",
  target: "hush target <add|remove|list> [args] [options]",
  config: "hush config <show|active-identity|readers> [args] [options]",
  keys: "hush keys <setup|generate|list|pull> [options]",
  project: "hush project <plan|validate|sync> <stage> [options]",
  import:
    "hush import add --source-root <path> (--bundle <name> | --file <path>) [--import-name <name>] [--json]",
  completion: "hush completion <bash|zsh|fish>",
  materialize:
    "hush materialize [--target <name> | --bundle <name>] [--to <dir>] [--json] [-- <command>]",
};

const OPTION_HELP: Readonly<Record<string, string>> = {
  "--root": "<dir> Start directory (alias: --cwd).",
  "--global": "Use the explicit global store.",
  "--env": "<development|production> Select an environment file.",
  "--target": "<name> Select a declared target.",
  "--bundle": "<name> Select a declared bundle.",
  "--file": "<path> Select a declared namespaced file.",
  "--from": "<path> Select the source.",
  "--to": "<path> Select the destination (alias: --output-root).",
  "--json": "Emit machine-readable JSON.",
  "--force": "Confirm an explicit overwrite or unsafe operation.",
  "--yes": "Skip the confirmation prompt.",
  "--local": "Use local scope.",
  "--repo-local": "Use the repository-local override file.",
  "--gui": "Read the value from a native GUI prompt.",
  "--require": "<KEY> Require a resolved key; repeatable.",
  "--format": "<dotenv|wrangler|vercel|json|shell|yaml> Set target output format.",
  "--mode": "<process|file|example> Set target materialization mode.",
  "--environment": "<production|preview|development> Select a Vercel environment; repeatable.",
  "--wrangler-env": "<name> Select a Wrangler environment.",
  "--source-root": "<path> Source repository root.",
  "--import-name": "<name> Stable local import name.",
  "--roles": "<csv> Reader roles.",
  "--identities": "<csv> Reader identities.",
  "--files": "<csv> Bundle files.",
  "--filename": "<name> Materialized filename.",
};

export function renderCommandHelp(command: string): string | null {
  const options = COMMAND_OPTIONS[command];
  const summary = COMMAND_SUMMARIES[command];
  if (!options || !summary) return null;
  const usage = COMMAND_USAGE[command] ?? `hush ${command} [options]`;
  const optionLines =
    options.length === 0
      ? "  (none)"
      : options
          .map((option) => `  ${option.padEnd(18)} ${OPTION_HELP[option] ?? "Command option."}`)
          .join("\n");
  const setSafety =
    command === "set"
      ? "\nSafety:\n  --target is not accepted. Resolve the target, then choose exactly one destination with --file, --repo-local, or --env.\n"
      : "";
  return `${summary}\n\nUsage:\n  ${usage}\n\nOptions:\n${optionLines}${setSafety}`;
}

export function validateCommandOptions(parsed: ParsedArgs): string | null {
  const allowed = COMMAND_OPTIONS[parsed.command];
  if (!allowed) return null;
  const rejected = parsed.suppliedOptions.find((option) => !allowed.includes(option));
  if (rejected) {
    if (parsed.command === "set" && rejected === "--target") {
      return "`hush set` does not accept --target. Choose a destination explicitly with: hush set KEY --file <namespaced-path>";
    }
    return `\`hush ${parsed.command}\` does not accept ${rejected}.`;
  }
  if (parsed.command === "set") {
    const selectors = parsed.suppliedOptions.filter((option) =>
      ["--file", "--repo-local", "--local", "--env"].includes(option),
    );
    if (selectors.length > 1) {
      return `\`hush set\` received conflicting destination selectors: ${selectors.join(", ")}. Choose exactly one of --file, --repo-local, or --env.`;
    }
  }
  return null;
}

function parseEnvironment(value: string): Environment | null {
  if (value === "development" || value === "dev") return "development";
  if (value === "production" || value === "prod") return "production";
  return null;
}

function parseFileKey(value: string): FileKey | null {
  if (value === "shared" || value === "development" || value === "production" || value === "local")
    return value;
  if (value === "dev") return "development";
  if (value === "prod") return "production";
  return null;
}

function parseVercelEnvironment(value: string): VercelEnvironment | null {
  if (value === "production" || value === "preview" || value === "development") {
    return value;
  }
  return null;
}

export function parseArgs(args: string[]): ParsedArgs {
  const suppliedOptions = collectSuppliedOptions(args);
  let helpRequested = false;
  let command = "";
  let subcommand: string | undefined;
  let env: Environment = "development";
  let envExplicit = false;
  let root = process.cwd();
  let dryRun = false;
  let verbose = false;
  let quiet = false;
  let warn = false;
  let json = false;
  let onlyChanged = false;
  let requireSource = false;
  let allowPlaintext = false;
  let global = false;
  let local = false;
  let force = false;
  let gui = false;
  let roles: string | undefined;
  let identities: string | undefined;
  let ref: string | undefined;
  let bundle: string | undefined;
  let from: string | undefined;
  let cleanup = false;
  let newRepo = false;
  let yes = false;
  let outputRoot: string | undefined;
  let file: string | undefined;
  let key: string | undefined;
  let value: string | undefined;
  let setFile: string | undefined;
  let target: string | undefined;
  let requireKeys: string[] = [];
  let positionalArgs: string[] = [];
  let cmdArgs: string[] = [];
  let format: string | undefined;
  let mode: string | undefined;
  let filename: string | undefined;
  let subpath: string | undefined;
  let materializeAs: string | undefined;
  let keepFile = false;
  let files: string | undefined;
  let repoLocal = false;
  let reveal = false;
  let write = false;
  let importName: string | undefined;
  let sourceRoot: string | undefined;
  let projectConfig: string | undefined;
  let surface: string | undefined;
  let skipRemote = false;
  let skipProvider = false;
  let vercel = false;
  let project: string | undefined;
  let team: string | undefined;
  let environments: VercelEnvironment[] = [];
  let wranglerEnv: string | undefined;
  let keysToken: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      helpRequested = true;
      continue;
    }

    if (arg === "-v" || arg === "--version") {
      console.log(VERSION);
      process.exit(0);
    }

    if (arg === "-e" || arg === "--env") {
      const nextArg = args[++i];
      const parsed = parseEnvironment(nextArg);
      if (parsed) {
        env = parsed;
        envExplicit = true;
      } else {
        console.error(pc.red(`Invalid environment: ${nextArg}`));
        console.error(pc.dim("Use: development, dev, production, or prod"));
        process.exit(1);
      }
      continue;
    }

    if (arg === "--environment") {
      const nextArg = args[++i];
      const parsedValues = (nextArg ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => parseVercelEnvironment(value));
      if (parsedValues.length === 0 || parsedValues.some((value) => value === null)) {
        console.error(pc.red(`Invalid Vercel environment: ${nextArg}`));
        console.error(pc.dim("Use: production, preview, or development"));
        process.exit(1);
      }
      environments.push(...(parsedValues as VercelEnvironment[]));
      continue;
    }

    if (arg === "-r" || arg === "--root" || arg === "--cwd") {
      root = args[++i];
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
      continue;
    }

    if (arg === "-q" || arg === "--quiet") {
      quiet = true;
      continue;
    }

    if (arg === "--warn") {
      warn = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--only-changed") {
      onlyChanged = true;
      continue;
    }

    if (arg === "--require-source") {
      requireSource = true;
      continue;
    }

    if (arg === "--require") {
      const nextArg = args[++i];
      if (!nextArg) {
        console.error(pc.red("Missing value for --require"));
        process.exit(1);
      }
      requireKeys.push(nextArg);
      continue;
    }

    if (arg === "--allow-plaintext") {
      allowPlaintext = true;
      continue;
    }

    if (arg === "--global") {
      global = true;
      continue;
    }

    if (arg === "--local") {
      local = true;
      continue;
    }

    if (arg === "--force" || arg === "-f") {
      force = true;
      continue;
    }

    if (arg === "--gui") {
      gui = true;
      continue;
    }

    if (arg === "--repo-local") {
      repoLocal = true;
      continue;
    }

    if (arg === "--reveal") {
      reveal = true;
      continue;
    }

    if (arg === "--write") {
      write = true;
      continue;
    }

    if (arg === "--roles") {
      roles = args[++i];
      continue;
    }

    if (arg === "--identities") {
      identities = args[++i];
      continue;
    }

    if (arg === "--ref") {
      ref = args[++i];
      continue;
    }

    if (arg === "--bundle") {
      bundle = args[++i];
      continue;
    }

    if (arg === "--file") {
      setFile = args[++i];
      continue;
    }

    if (arg === "--files") {
      files = args[++i];
      continue;
    }

    if (arg === "--from") {
      from = args[++i];
      continue;
    }

    if (arg === "--cleanup") {
      cleanup = true;
      continue;
    }

    if (arg === "--new-repo") {
      newRepo = true;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }

    if (arg === "--output-root" || arg === "--to") {
      outputRoot = args[++i];
      continue;
    }

    if (arg === "--format") {
      format = args[++i];
      continue;
    }

    if (arg === "--mode") {
      mode = args[++i];
      continue;
    }

    if (arg === "--filename") {
      filename = args[++i];
      continue;
    }

    if (arg === "--subpath") {
      subpath = args[++i];
      continue;
    }

    if (arg === "--materialize-as") {
      materializeAs = args[++i];
      continue;
    }

    if (arg === "--import-name") {
      importName = args[++i];
      continue;
    }

    if (arg === "--source-root") {
      sourceRoot = args[++i];
      continue;
    }

    if (arg === "--config") {
      projectConfig = args[++i];
      continue;
    }

    if (arg === "--surface") {
      surface = args[++i];
      continue;
    }

    if (arg === "--vercel") {
      vercel = true;
      continue;
    }

    if (arg === "--project") {
      project = args[++i];
      continue;
    }

    if (arg === "--team") {
      team = args[++i];
      continue;
    }

    if (arg === "--wrangler-env") {
      wranglerEnv = args[++i];
      continue;
    }

    if (arg === "--token") {
      keysToken = args[++i];
      continue;
    }

    if (arg === "--skip-remote") {
      skipRemote = true;
      continue;
    }

    if (arg === "--skip-provider") {
      skipProvider = true;
      continue;
    }

    if (arg === "--keep-file") {
      keepFile = true;
      continue;
    }

    if (arg === "-t" || arg === "--target") {
      target = args[++i];
      continue;
    }

    if (arg === "--") {
      cmdArgs = args.slice(i + 1);
      break;
    }

    if (!command && !arg.startsWith("-")) {
      command = arg;
      continue;
    }

    if (command === "edit" && !arg.startsWith("-")) {
      // Accept short aliases (shared/dev/prod/...) and any declared v3 file path.
      // Validation against the repository file index happens in editCommand so it
      // can hard-error with the full list of registered files.
      file = parseFileKey(arg) ?? arg;
      continue;
    }

    if (command === "set" && !arg.startsWith("-") && (!key || !value)) {
      if (!key) {
        key = arg;
      } else {
        // Second positional arg is the value
        // Syntax: hush set <KEY> <VALUE>
        value = arg;
      }
      continue;
    }

    if (
      (command === "copy-key" || command === "move-key" || command === "delete-key") &&
      !arg.startsWith("-") &&
      !key
    ) {
      key = arg;
      continue;
    }

    if (command === "has" && !arg.startsWith("-") && !key) {
      key = arg;
      continue;
    }

    if (command === "trace" && !arg.startsWith("-") && !key) {
      key = arg;
      continue;
    }

    if (command === "resolve" && !arg.startsWith("-") && !target) {
      target = arg;
      continue;
    }

    if (command === "verify-target" && !arg.startsWith("-") && !target) {
      target = arg;
      continue;
    }

    if (command === "keys" && !arg.startsWith("-") && !subcommand) {
      subcommand = arg;
      continue;
    }

    if (command === "config" && !arg.startsWith("-")) {
      if (!subcommand) {
        subcommand = arg;
      } else {
        positionalArgs.push(arg);
      }
      continue;
    }

    if (command === "import" && !arg.startsWith("-")) {
      if (!subcommand) {
        subcommand = arg;
      } else {
        positionalArgs.push(arg);
      }
      continue;
    }

    if (
      (command === "file" ||
        command === "bundle" ||
        command === "target" ||
        command === "project") &&
      !arg.startsWith("-")
    ) {
      if (!subcommand) {
        subcommand = arg;
      } else {
        positionalArgs.push(arg);
      }
      continue;
    }

    if (command === "completion" && !arg.startsWith("-") && !subcommand) {
      subcommand = arg;
      continue;
    }

    // Fail loud instead of silently ignoring input. Silently swallowed flags
    // previously made documented-but-unwired options look like they worked.
    if (arg.startsWith("-")) {
      const optionCandidates = [...RECOGNIZED_OPTIONS].filter((option) => option.startsWith("--"));
      const suggestion = suggestUnique(arg, optionCandidates);
      failCli({
        code: "UNKNOWN_OPTION",
        message: `Unknown option: ${arg}`,
        command: command || undefined,
        rejectedInput: arg,
        suggestion: suggestion ? `hush ${command} ${suggestion}` : undefined,
        json: args.includes("--json"),
      });
    }

    console.error(pc.red(`Unexpected argument: ${arg}`));
    if (command === "run" || command === "materialize") {
      console.error(pc.dim(`Did you mean: hush ${command} -- ${arg} ...`));
    }
    console.error(pc.dim("Run 'hush --help' for usage."));
    process.exit(1);
  }

  return {
    suppliedOptions,
    helpRequested,
    command,
    subcommand,
    env,
    envExplicit,
    root,
    dryRun,
    verbose,
    quiet,
    warn,
    json,
    onlyChanged,
    requireSource,
    allowPlaintext,
    global,
    local,
    force,
    gui,
    repoLocal,
    reveal,
    roles,
    identities,
    ref,
    bundle,
    from,
    cleanup,
    newRepo,
    yes,
    outputRoot,
    file,
    key,
    value,
    setFile,
    target,
    requireKeys,
    positionalArgs,
    cmdArgs,
    format,
    mode,
    filename,
    subpath,
    materializeAs,
    keepFile,
    files,
    write,
    importName,
    sourceRoot,
    projectConfig,
    surface,
    skipRemote,
    skipProvider,
    vercel,
    project,
    team,
    environments: Array.from(new Set(environments)),
    wranglerEnv,
    keysToken,
  };
}

function checkMigrationNeeded(root: string, command: string, json: boolean): void {
  const skipCommands = ["", "help", "version", "bootstrap", "config", "init", "skill", "migrate"];
  if (skipCommands.includes(command)) return;

  const project = findProjectRoot(root);
  if (project?.repositoryKind === "legacy-v2") {
    if (json) {
      failCli({
        code: "MIGRATION_REQUIRED",
        message: "This repository still uses legacy hush.yaml runtime authority.",
        command,
        rejectedInput: project.projectRoot,
        suggestion: "Run `hush migrate --from v2 --dry-run`, then `hush migrate --from v2`.",
        json: true,
      });
    }
    console.log("");
    console.log(pc.yellow("━".repeat(60)));
    console.log(pc.yellow(pc.bold("  Migration Required")));
    console.log(pc.yellow("━".repeat(60)));
    console.log("");
    console.log(`  This repository still uses ${pc.cyan("hush.yaml")} legacy runtime authority.`);
    console.log(
      `  Hush ${VERSION} expects a ${pc.bold(".hush/")} v3 repository for normal runtime commands.`,
    );
    console.log("");
    console.log(pc.dim("  Run this first:"));
    console.log(`  ${pc.cyan("hush migrate --from v2 --dry-run")}`);
    console.log(`  ${pc.cyan("hush migrate --from v2")}`);
    console.log("");
    console.log(pc.yellow("━".repeat(60)));
    console.log("");
  }
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const parsed = parseArgs(args);
  if (parsed.helpRequested) {
    if (!parsed.command) {
      printHelp();
    } else {
      const commandHelp = renderCommandHelp(parsed.command);
      if (!commandHelp) {
        const suggestion = suggestUnique(parsed.command, Object.keys(COMMAND_OPTIONS));
        failCli({
          code: "UNKNOWN_COMMAND",
          message: `Unknown command: ${parsed.command}`,
          command: parsed.command,
          rejectedInput: parsed.command,
          suggestion: suggestion ? `hush ${suggestion} --help` : undefined,
          json: parsed.json,
        });
      }
      console.log(commandHelp);
    }
    process.exit(0);
  }
  const optionError = validateCommandOptions(parsed);
  if (optionError) {
    const rejected = parsed.suppliedOptions.find(
      (option) => !(COMMAND_OPTIONS[parsed.command] ?? []).includes(option),
    );
    failCli({
      code: "UNSUPPORTED_OPTION",
      message: optionError,
      command: parsed.command,
      rejectedInput: rejected,
      json: parsed.json,
    });
  }
  if (!parsed.command) {
    failCli({ code: "MISSING_COMMAND", message: "No command provided.", json: parsed.json });
  }
  if (!COMMAND_OPTIONS[parsed.command]) {
    const suggestion = suggestUnique(parsed.command, Object.keys(COMMAND_OPTIONS));
    failCli({
      code: "UNKNOWN_COMMAND",
      message: `Unknown command: ${parsed.command}`,
      command: parsed.command,
      rejectedInput: parsed.command,
      suggestion: suggestion ? `hush ${suggestion}` : undefined,
      json: parsed.json,
    });
  }
  const allowedSubcommands = SUBCOMMANDS[parsed.command];
  if (
    allowedSubcommands &&
    (!parsed.subcommand || !allowedSubcommands.includes(parsed.subcommand))
  ) {
    failUnknownSubcommand(parsed.command, parsed.subcommand, parsed.json);
  }
  const {
    command,
    subcommand,
    env,
    envExplicit,
    root,
    dryRun,
    verbose,
    quiet,
    warn,
    json,
    onlyChanged,
    requireSource,
    allowPlaintext,
    global,
    local,
    repoLocal,
    reveal,
    force,
    gui,
    roles,
    identities,
    ref,
    bundle,
    from,
    cleanup,
    newRepo,
    yes,
    outputRoot,
    file,
    key,
    value,
    setFile,
    target,
    requireKeys,
    positionalArgs,
    cmdArgs,
    keepFile,
    format,
    mode,
    filename,
    subpath,
    materializeAs,
    files,
    write,
    importName,
    sourceRoot,
    projectConfig,
    surface,
    skipRemote,
    skipProvider,
    vercel,
    project,
    team,
    environments,
    wranglerEnv,
    keysToken,
  } = parsed;
  const storeMode: StoreMode = global && command !== "skill" ? "global" : "project";
  const store = resolveStoreContext(root, storeMode);

  if (command !== "run" && !json && !quiet) {
    checkForUpdate(VERSION);
  }

  checkMigrationNeeded(store.root, command, json);

  try {
    switch (command) {
      case "init":
        await initCommand(defaultContext, { store });
        break;

      case "bootstrap": {
        const bootstrapStore = resolveStoreContext(root, storeMode, {
          ignoreAncestors: newRepo,
          explicitRoot: newRepo ? root : undefined,
        });
        await bootstrapCommand(defaultContext, {
          store: bootstrapStore,
          newRepo,
          yes,
          explicitRoot: newRepo ? root : undefined,
        });
        break;
      }

      case "config":
        await configCommand(defaultContext, {
          store,
          subcommand,
          args: positionalArgs,
          roles,
          identities,
          json,
        });
        break;

      case "encrypt":
        await encryptCommand(defaultContext, { store });
        break;

      case "decrypt":
        await decryptCommand(defaultContext, { store, env, force });
        break;

      case "run":
        if (envExplicit) {
          console.error(pc.red("-e/--env is not supported by `hush run`."));
          console.error(
            pc.dim(
              "Select the secrets to inject with a target instead: hush run -t <target> -- <cmd>",
            ),
          );
          console.error(pc.dim("List available targets with: hush target list"));
          process.exit(1);
        }
        await runCommand(defaultContext, { store, cwd: root, target, command: cmdArgs, json });
        break;

      case "set": {
        if (value !== undefined) {
          console.error(
            pc.yellow("Warning: inline values are visible in shell history and process listings."),
          );
          console.error(
            pc.dim(
              'Prefer: hush set KEY (interactive prompt), echo "val" | hush set KEY, or hush set KEY --gui',
            ),
          );
        }
        let resolvedSetFile = setFile;
        let resolvedRepoLocal = repoLocal;

        if (local) {
          resolvedRepoLocal = true;
        } else if (!resolvedSetFile && envExplicit) {
          resolvedSetFile = env;
        }

        await setCommand(defaultContext, {
          store,
          file: resolvedSetFile,
          key,
          value,
          gui,
          repoLocal: resolvedRepoLocal,
          json,
        });
        break;
      }

      case "copy-key":
      case "move-key":
        await copyKeyCommand(defaultContext, {
          store,
          key,
          from,
          to: outputRoot,
          move: command === "move-key",
          json,
        });
        break;

      case "delete-key":
        await deleteKeyCommand(defaultContext, { store, key, from, yes, json });
        break;

      case "edit":
        await editCommand(defaultContext, { store, file });
        break;

      case "list":
        await listCommand(defaultContext, { store, env, reveal, json });
        break;

      case "inspect":
        await inspectCommand(defaultContext, { store, env, json });
        break;

      case "has":
        if (!key) {
          console.error(pc.red("Usage: hush has <KEY>"));
          process.exit(1);
        }
        await hasCommand(defaultContext, { store, env, key, quiet, json });
        break;

      case "check":
        await checkCommand(defaultContext, {
          store,
          warn,
          json,
          quiet,
          onlyChanged,
          requireSource,
          allowPlaintext,
        });
        break;

      case "push":
        await pushCommand(defaultContext, {
          store,
          dryRun,
          verbose,
          target,
          vercel,
          project,
          team,
          environments,
          wranglerEnv,
        });
        break;

      case "project":
        if (subcommand !== "plan" && subcommand !== "validate" && subcommand !== "sync") {
          failUnknownSubcommand("project", subcommand, json);
        }
        if (!positionalArgs[0]) {
          console.error(pc.red(`Usage: hush project ${subcommand} <stage>`));
          process.exit(1);
        }
        await projectCommand(defaultContext, {
          store,
          subcommand,
          stage: positionalArgs[0],
          json,
          dryRun,
          skipRemote,
          skipProvider,
          surface,
          configPath: projectConfig,
        });
        break;

      case "status":
        await statusCommand(defaultContext, { store, json });
        break;

      case "doctor":
        await doctorCommand(defaultContext, {
          startDir: root,
          newRepo,
          explicitRoot: newRepo ? root : undefined,
          json,
        });
        break;

      case "skill":
        await skillCommand(defaultContext, { root, global, local });
        break;

      case "completion":
        await completionCommand(defaultContext, { shell: subcommand ?? "" });
        break;

      case "keys":
        if (!subcommand) {
          failUnknownSubcommand("keys", subcommand, json);
        }
        await keysCommand(defaultContext, {
          store,
          subcommand,
          force,
          from,
          project,
          team,
          token: keysToken,
        });
        break;

      case "resolve":
        if (!target) {
          console.error(pc.red("Usage: hush resolve <target>"));
          console.error(pc.dim("Example: hush resolve api-workers"));
          process.exit(1);
        }
        await resolveCommand(defaultContext, { store, env, target, json });
        break;

      case "trace":
        if (!key) {
          console.error(pc.red("Usage: hush trace <KEY>"));
          console.error(pc.dim("Example: hush trace DATABASE_URL"));
          process.exit(1);
        }
        await traceCommand(defaultContext, { store, env, key, json });
        break;

      case "verify-target":
        if (!target) {
          console.error(pc.red("Usage: hush verify-target <target> [--require KEY ...]"));
          console.error(
            pc.dim("Example: hush verify-target api-production --require RESEND_API_KEY"),
          );
          process.exit(1);
        }
        await verifyTargetCommand(defaultContext, {
          store,
          env,
          target,
          require: requireKeys,
          json,
        });
        break;

      case "diff":
        await diffCommand(defaultContext, { store, env, target, bundle, ref, json });
        break;

      case "export-example":
        await exportExampleCommand(defaultContext, {
          store,
          env,
          target,
          bundle,
          write,
          writePath: outputRoot,
          force,
          json,
        });
        break;

      case "template":
        await templateCommand(defaultContext, { root, env });
        break;

      case "expansions":
        await expansionsCommand(defaultContext, { root, env });
        break;

      case "migrate":
        await migrateCommand(defaultContext, { root, dryRun, from, cleanup });
        break;

      case "materialize":
        if (format) {
          console.error(pc.red("--format is not supported by `hush materialize`."));
          console.error(
            pc.dim(
              "Output format is a property of the target: hush target add <name> --bundle <b> --format <fmt>",
            ),
          );
          process.exit(1);
        }
        await materializeCommand(defaultContext, {
          store,
          target,
          bundle,
          json,
          outputRoot,
          cleanup,
          command: cmdArgs,
        });
        break;

      case "file": {
        const filePath = positionalArgs[0] ?? "";
        if (subcommand === "add") {
          await fileCommand(defaultContext, {
            store,
            subcommand,
            path: filePath,
            roles,
            identities,
            json,
          });
        } else if (subcommand === "remove") {
          await fileCommand(defaultContext, {
            store,
            subcommand,
            path: filePath,
            keepFile,
            json,
          });
        } else if (subcommand === "list") {
          await fileCommand(defaultContext, {
            store,
            subcommand,
            json,
          });
        } else if (subcommand === "readers") {
          await fileCommand(defaultContext, {
            store,
            subcommand,
            path: filePath,
            roles,
            identities,
            json,
          });
        } else {
          failUnknownSubcommand("file", subcommand, json);
        }
        break;
      }

      case "bundle": {
        const bundleName = positionalArgs[0] ?? "";
        if (subcommand === "add") {
          await bundleCommand(defaultContext, {
            store,
            subcommand: "add",
            name: bundleName,
            files,
            json,
          });
        } else if (subcommand === "add-file") {
          await bundleCommand(defaultContext, {
            store,
            subcommand: "add-file",
            bundle: bundleName,
            file: positionalArgs[1] ?? "",
            json,
          });
        } else if (subcommand === "remove-file") {
          await bundleCommand(defaultContext, {
            store,
            subcommand: "remove-file",
            bundle: bundleName,
            file: positionalArgs[1] ?? "",
            json,
          });
        } else if (subcommand === "remove") {
          await bundleCommand(defaultContext, {
            store,
            subcommand: "remove",
            name: bundleName,
            json,
          });
        } else if (subcommand === "list") {
          await bundleCommand(defaultContext, {
            store,
            subcommand: "list",
            json,
          });
        } else {
          failUnknownSubcommand("bundle", subcommand, json);
        }
        break;
      }

      case "target": {
        const targetName = positionalArgs[0] ?? "";
        if (subcommand === "add") {
          await targetCommand(defaultContext, {
            store,
            subcommand: "add",
            name: targetName,
            bundle,
            format: format ?? "",
            mode,
            filename,
            subpath,
            materializeAs,
            json,
          });
        } else if (subcommand === "remove") {
          await targetCommand(defaultContext, {
            store,
            subcommand: "remove",
            name: targetName,
            json,
          });
        } else if (subcommand === "list") {
          await targetCommand(defaultContext, {
            store,
            subcommand: "list",
            json,
          });
        } else {
          failUnknownSubcommand("target", subcommand, json);
        }
        break;
      }

      case "import": {
        if (subcommand === "add") {
          // --source-root is the source store path; --root is the usual CWD start dir.
          // The first positional arg (after 'add') may also be the source root if
          // --source-root was not supplied explicitly.
          const effectiveSourceRoot = sourceRoot ?? positionalArgs[0] ?? "";
          await importAddCommand(defaultContext, {
            store,
            sourceRoot: effectiveSourceRoot,
            bundle,
            file: setFile,
            importName,
            json,
          });
        } else {
          failUnknownSubcommand("import", subcommand, json);
        }
        break;
      }

      default:
        if (command) {
          const suggestion = suggestUnique(command, Object.keys(COMMAND_OPTIONS));
          failCli({
            code: "UNKNOWN_COMMAND",
            message: `Unknown command: ${command}`,
            command,
            rejectedInput: command,
            suggestion: suggestion ? `hush ${suggestion}` : undefined,
            json,
          });
        }
        failCli({ code: "MISSING_COMMAND", message: "No command provided.", json });
    }
  } catch (error) {
    const err = error as Error;
    console.error(pc.red(`Error: ${err.message}`));
    process.exit(1);
  }
}

function isCliEntrypoint(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (process.env.HUSH_CLI_ENTRYPOINT === "1" || isCliEntrypoint()) {
  await main();
}
