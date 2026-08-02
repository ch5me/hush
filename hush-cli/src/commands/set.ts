import { platform } from "node:os";

import pc from "picocolors";

import { ensureGlobalStoreBootstrap } from "../global-store.js";
import { appendAuditEvent } from "../index.js";
import { writeJsonSuccess } from "../lib/command-output.js";
import type { HushContext, HushFileDocument, HushV3Repository, SetOptions } from "../types.js";
import { LEGACY_MACHINE_LOCAL_FILE_PATH, MACHINE_LOCAL_FILE_PATH } from "../v3/schema.js";
import {
  DEFAULT_V3_FILE_PATHS,
  FILE_KEYS,
  MACHINE_LOCAL_DESTINATION,
  assertEditableValuePersisted,
  describeLegacyLocalRepositoryFile,
  describeUnresolvedWrite,
  findLegacyLocalRepositoryFile,
  isLegacyPositionalFileArg,
  loadEditableDestination,
  loadMachineLocalOverrides,
  readCurrentIdentity,
  requireMutableIdentity,
  requireV3Repository,
  resolveEditableDestination,
  setEnvValueInDocument,
  writeMachineLocalOverrides,
  writeEditableFileDocument,
} from "./v3-command-helpers.js";
import type { EditableDestination, EditableScope } from "./v3-command-helpers.js";

type SetDestination = EditableDestination;

function hasStdinPipe(ctx: HushContext): boolean {
  try {
    return !ctx.process.stdin.isTTY;
  } catch {
    return false;
  }
}

function trimTrailingLineEndings(value: string): string {
  return value.replace(/[\r\n]+$/, "");
}

function readFromStdinPipe(ctx: HushContext): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";

    ctx.process.stdin.setEncoding("utf8");
    ctx.process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    ctx.process.stdin.on("end", () => {
      resolve(trimTrailingLineEndings(data));
    });
    ctx.process.stdin.on("error", reject);
    ctx.process.stdin.resume();
  });
}

function promptViaMacOSDialog(ctx: HushContext, key: string): string {
  try {
    const script = `text returned of (display dialog "Enter value for ${key}:" default answer "" with hidden answer with title "Hush - Set Secret")`;
    const result = ctx.exec.spawnSync("osascript", ["-e", script], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      const message = (result.stderr || result.stdout || "").toString().trim();
      if (message.toLowerCase().includes("user canceled")) {
        throw new Error("Cancelled");
      }
      throw new Error(`macOS dialog failed: ${message}`);
    }
    return result.stdout.toString().trim();
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`macOS dialog failed: unknown error`);
  }
}

function promptViaWindowsDialog(ctx: HushContext, key: string): string | null {
  try {
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing

      $form = New-Object System.Windows.Forms.Form
      $form.Text = 'Hush - Set Secret'
      $form.Size = New-Object System.Drawing.Size(300,150)
      $form.StartPosition = 'CenterScreen'

      $label = New-Object System.Windows.Forms.Label
      $label.Location = New-Object System.Drawing.Point(10,20)
      $label.Size = New-Object System.Drawing.Size(280,20)
      $label.Text = 'Enter value for ${key}:'
      $form.Controls.Add($label)

      $textBox = New-Object System.Windows.Forms.TextBox
      $textBox.Location = New-Object System.Drawing.Point(10,50)
      $textBox.Size = New-Object System.Drawing.Size(260,20)
      $textBox.UseSystemPasswordChar = $true
      $form.Controls.Add($textBox)

      $okButton = New-Object System.Windows.Forms.Button
      $okButton.Location = New-Object System.Drawing.Point(10,80)
      $okButton.Size = New-Object System.Drawing.Size(75,23)
      $okButton.Text = 'OK'
      $okButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
      $form.AcceptButton = $okButton
      $form.Controls.Add($okButton)

      $form.TopMost = $true

      $result = $form.ShowDialog()

      if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $textBox.Text
      } else {
        exit 1
      }
    `;

    const encodedCommand = Buffer.from(psScript, "utf16le").toString("base64");
    const result = ctx.exec.spawnSync("powershell", ["-EncodedCommand", encodedCommand], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      return null;
    }
    return result.stdout.toString().trim();
  } catch {
    return null;
  }
}

function promptViaLinuxDialog(ctx: HushContext, key: string): string | null {
  const zenityResult = ctx.exec.spawnSync(
    "zenity",
    ["--password", `--title=Hush - Set Secret`, `--text=Enter value for ${key}:`],
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  );
  if (zenityResult.status === 0) {
    return zenityResult.stdout.toString().trim();
  }

  const kdialogResult = ctx.exec.spawnSync(
    "kdialog",
    ["--password", `Enter value for ${key}:`, "--title", "Hush - Set Secret"],
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  );
  if (kdialogResult.status === 0) {
    return kdialogResult.stdout.toString().trim();
  }

  return null;
}

function promptViaTTY(ctx: HushContext, key: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ctx.process.stdout.write(`Enter value for ${pc.cyan(key)}: `);

    const stdin = ctx.process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    const onData = (char: string) => {
      switch (char) {
        case "\n":
        case "\r":
        case "\u0004":
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          ctx.process.stdout.write("\n");
          resolve(trimTrailingLineEndings(value));
          break;
        case "\u0003":
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          ctx.process.stdout.write("\n");
          reject(new Error("Cancelled"));
          break;
        case "\u007F":
        case "\b":
          if (value.length > 0) {
            value = value.slice(0, -1);
            ctx.process.stdout.write("\b \b");
          }
          break;
        default:
          value += char;
          ctx.process.stdout.write("\u2022");
      }
    };

    stdin.on("data", onData);
  });
}

function normalizePromptValue(value: string): string {
  return trimTrailingLineEndings(value);
}

function resolveSetDestination(
  file: string | undefined,
  repoLocal: boolean | undefined,
  repository: HushV3Repository,
): SetDestination {
  if (repoLocal) {
    return MACHINE_LOCAL_DESTINATION;
  }

  // Shared resolver: honors explicit --file aliases AND declared v3 paths, and
  // hard-errors (never silently falls back, and never across storage classes)
  // when the selector is unknown. Same class fix covers `set` and `edit`.
  return resolveEditableDestination(file ?? "shared", repository);
}

function getScopeLabel(destination: SetDestination, scope: EditableScope): string {
  if (scope === "machine-local") {
    return "repo-local";
  }

  return destination.fileKey ?? "repository";
}

function getUsageLines(): string[] {
  return [
    pc.red("Usage: hush set <KEY> [VALUE] [--file <path-or-alias>] [--repo-local]"),
    pc.dim("Examples:"),
    pc.dim("  hush set DATABASE_URL"),
    pc.dim("  hush set API_KEY --file production"),
    pc.dim("  hush set API_KEY --repo-local"),
    pc.dim("  hush set WORKER_ENV staging --file env/project/staging"),
    pc.dim("\nTo edit all secrets in an editor, use: hush edit"),
  ];
}

function logUsage(ctx: HushContext): void {
  for (const line of getUsageLines()) {
    ctx.logger.error(line);
  }
}

function detectLegacyPositionalFileArg(
  key: string | undefined,
  file: string | undefined,
  repoLocal: boolean | undefined,
): void {
  if (repoLocal || file || !key || !isLegacyPositionalFileArg(key)) {
    return;
  }

  throw new Error(
    `Invalid syntax: "hush set ${key} KEY VALUE" is no longer supported. Use "hush set KEY VALUE --file ${key}" or "hush set KEY VALUE --repo-local" for local.`,
  );
}

function getDocumentValue(
  document: HushFileDocument | null,
  filePath: string,
  key: string,
): string | undefined {
  if (!document) {
    return undefined;
  }

  const entry = document.entries[`${filePath}/${key}`];
  if (!entry || "type" in entry) {
    return undefined;
  }

  return typeof entry.value === "string" ? entry.value : undefined;
}

function findSharedConflicts(
  ctx: HushContext,
  store: SetOptions["store"],
  repository: HushV3Repository,
  key: string,
): string[] {
  const repositoryConflicts = FILE_KEYS.filter((fileKey) => fileKey !== "shared")
    .map((fileKey) => DEFAULT_V3_FILE_PATHS[fileKey])
    .filter((filePath) => {
      if (!repository.filesByPath[filePath]) {
        return false;
      }

      return getDocumentValue(repository.loadFile(filePath), filePath, key) !== undefined;
    });

  // Machine-local always wins at resolution, so it always shadows shared.
  const machineLocalConflict =
    getDocumentValue(loadMachineLocalOverrides(ctx, store), MACHINE_LOCAL_FILE_PATH, key) !==
    undefined;

  return machineLocalConflict
    ? [...repositoryConflicts, MACHINE_LOCAL_FILE_PATH]
    : repositoryConflicts;
}

/** Repository files holding `key`, which a machine-local override displaces. */
function findMachineLocalShadows(repository: HushV3Repository, key: string): string[] {
  return FILE_KEYS.map((fileKey) => DEFAULT_V3_FILE_PATHS[fileKey]).filter(
    (filePath) =>
      repository.filesByPath[filePath] &&
      getDocumentValue(repository.loadFile(filePath), filePath, key) !== undefined,
  );
}

async function promptForValue(ctx: HushContext, key: string, forceGui: boolean): Promise<string> {
  if (!forceGui && hasStdinPipe(ctx)) {
    return normalizePromptValue(await readFromStdinPipe(ctx));
  }

  if (ctx.process.stdin.isTTY && !forceGui) {
    return normalizePromptValue(await promptViaTTY(ctx, key));
  }

  ctx.logger.log(pc.dim("Opening dialog for secret input..."));

  let value: string | null = null;

  switch (platform()) {
    case "darwin":
      value = promptViaMacOSDialog(ctx, key);
      break;
    case "win32":
      value = promptViaWindowsDialog(ctx, key);
      break;
    case "linux":
      value = promptViaLinuxDialog(ctx, key);
      break;
  }

  if (value !== null) {
    return normalizePromptValue(value);
  }

  if (platform() === "linux") {
    throw new Error('GUI prompt failed. Please install "zenity" or "kdialog".');
  }

  throw new Error(
    "Dialog cancelled or failed. Interactive input requires a terminal (TTY) or a supported GUI environment.",
  );
}

export async function setCommand(ctx: HushContext, options: SetOptions): Promise<void> {
  const { store, file, key, value: inlineValue, gui, repoLocal, showLength, json } = options;

  if (store.mode === "global") {
    ensureGlobalStoreBootstrap(ctx, store);
  }

  if (!key) {
    logUsage(ctx);
    ctx.process.exit(1);
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    ctx.logger.error(
      pc.red(`Invalid key name "${key}". Keys must match /^[A-Za-z_][A-Za-z0-9_]*$/`),
    );
    ctx.process.exit(1);
  }

  let destination: SetDestination | null = null;
  let repository: HushV3Repository | null = null;

  try {
    detectLegacyPositionalFileArg(key, file, repoLocal);
    repository = requireV3Repository(store, "set");
    destination = resolveSetDestination(file, repoLocal, repository);

    const activeIdentity = requireMutableIdentity(ctx, store, repository, {
      name: "set",
      args: [destination.fileKey ?? destination.filePath, key],
    });

    const value = inlineValue ?? (await promptForValue(ctx, key, gui ?? false));

    if (!value) {
      ctx.logger.error(pc.yellow("No value entered. Nothing written."));
      ctx.process.exit(1);
    }

    if (!json && inlineValue === undefined && showLength) {
      ctx.logger.log(pc.dim(`input length: ${value.length} chars`));
    }

    if (!json) ctx.logger.log(pc.dim(`will write ${key} -> ${destination.filePath}`));

    // Preflight, not a source-only note: writing into a committed file named
    // "local" is the one case where the destination's storage class is likely
    // not what the operator assumed.
    const legacyLocal =
      destination.filePath === LEGACY_MACHINE_LOCAL_FILE_PATH
        ? findLegacyLocalRepositoryFile(repository)
        : null;
    const legacyLocalWarning = legacyLocal
      ? describeLegacyLocalRepositoryFile(legacyLocal)
      : undefined;
    if (legacyLocalWarning && !json) {
      ctx.logger.warn(pc.yellow(`warning: ${legacyLocalWarning}`));
    }

    const editable = loadEditableDestination(ctx, store, repository, destination);

    const previousValue = getDocumentValue(editable.document, editable.filePath, key);
    if (previousValue === value) {
      const payload = {
        action: "set",
        changed: false,
        key,
        requestedScope: { file: file ?? (repoLocal ? "repo-local" : "shared") },
        resolvedScope: { file: editable.filePath, scope: editable.scope },
      };
      if (json) writeJsonSuccess(ctx, "set", payload);
      else ctx.logger.log(pc.green(`${key} is already set in ${editable.filePath} (no change).`));
      return;
    }

    if (destination.filePath === DEFAULT_V3_FILE_PATHS.shared) {
      const conflicts = findSharedConflicts(ctx, store, repository, key);
      if (conflicts.length > 0) {
        if (!json)
          ctx.logger.warn(
            pc.yellow(
              `warning: ${key} already exists in ${conflicts.join(", ")}; shared may not win at runtime.`,
            ),
          );
      }
    }

    // A machine-local override wins for every command that resolves for this
    // machine, so say which repository values it displaces. Write time is the
    // only moment the operator is looking; after this the override is silent by
    // design, and a stale one masking a rotated shared secret is the failure
    // this notice exists to make findable.
    if (editable.scope === "machine-local") {
      const shadowed = findMachineLocalShadows(repository, key);
      if (shadowed.length > 0 && !json) {
        ctx.logger.warn(
          pc.yellow(
            `warning: ${key} is also set in ${shadowed.join(", ")}; the repo-local value now wins on this machine.`,
          ),
        );
      }
    }

    const nextDocument = setEnvValueInDocument(editable.document, key, value);
    if (editable.scope === "machine-local") {
      writeMachineLocalOverrides(ctx, store, nextDocument);
    } else {
      writeEditableFileDocument(ctx, store, repository, editable.systemPath, nextDocument);
    }

    // Fail loud: never report success without proving the value reads back from
    // durable storage through the same reader the runtime uses. Throws on
    // missing/mismatched values, which the catch block below audits as a failed
    // write before rethrowing.
    assertEditableValuePersisted(
      ctx,
      store,
      { filePath: editable.filePath, scope: editable.scope },
      key,
      value,
    );

    appendAuditEvent(ctx, store, {
      type: "write",
      activeIdentity,
      success: true,
      command: { name: "set", args: [destination.fileKey ?? destination.filePath, key] },
      files: [editable.filePath],
      logicalPaths: [`${editable.filePath}/${key}`],
      details: {
        scope: editable.scope,
        requestedFile: file ?? (repoLocal ? "repo-local" : "shared"),
        resolvedFile: editable.filePath,
        chars: value.length,
      },
    });

    const unresolvedWarning = describeUnresolvedWrite(ctx, store, key, editable.filePath);
    const scopeLabel = getScopeLabel(destination, editable.scope);
    const payload = {
      action: "set",
      changed: true,
      key,
      requestedScope: { file: file ?? (repoLocal ? "repo-local" : "shared") },
      resolvedScope: { file: editable.filePath, scope: editable.scope },
      chars: value.length,
      ...(unresolvedWarning ? { resolutionWarning: unresolvedWarning } : {}),
      ...(legacyLocalWarning ? { storageClassWarning: legacyLocalWarning } : {}),
    };
    if (json) {
      writeJsonSuccess(ctx, "set", payload);
    } else {
      if (unresolvedWarning) ctx.logger.warn(pc.yellow(`warning: ${unresolvedWarning}`));
      ctx.logger.log(
        pc.green(`\n${key} set in ${editable.filePath} (${scopeLabel}, ${value.length} chars)`),
      );
    }
  } catch (error) {
    const err = error as Error;
    if (err.message === "Cancelled") {
      ctx.logger.log(pc.yellow("Cancelled"));
      ctx.process.exit(1);
    }
    if (err.message.startsWith("Invalid syntax:") || err.message.startsWith("Unknown file")) {
      appendAuditEvent(ctx, store, {
        type: "write",
        activeIdentity: readCurrentIdentity(ctx, store),
        success: false,
        command: {
          name: "set",
          args: [destination?.fileKey ?? destination?.filePath ?? file ?? "shared", key ?? ""],
        },
        reason: err.message,
      });
      ctx.logger.error(pc.red(err.message));
      logUsage(ctx);
      ctx.process.exit(1);
    }
    appendAuditEvent(ctx, store, {
      type: "write",
      activeIdentity: readCurrentIdentity(ctx, store),
      success: false,
      command: {
        name: "set",
        args: [destination?.fileKey ?? destination?.filePath ?? file ?? "shared", key ?? ""],
      },
      reason: err.message,
    });
    throw err;
  }
}
