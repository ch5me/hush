import { platform } from 'node:os';
import pc from 'picocolors';
import { appendAuditEvent } from '../index.js';
import type { HushContext, HushFileDocument, HushV3Repository, SetOptions } from '../types.js';
import { ensureGlobalStoreBootstrap } from '../global-store.js';
import {
  DEFAULT_V3_FILE_PATHS,
  ensureEditableFileDocument,
  loadMachineLocalOverrides,
  readCurrentIdentity,
  requireMutableIdentity,
  requireV3Repository,
  setEnvValueInDocument,
  writeMachineLocalOverrides,
  writeEditableFileDocument,
} from './v3-command-helpers.js';

type FileKey = keyof typeof DEFAULT_V3_FILE_PATHS;
const FILE_KEYS = Object.keys(DEFAULT_V3_FILE_PATHS) as FileKey[];
const POSITIONAL_FILE_ALIASES = new Set<FileKey>(FILE_KEYS);
type SetDestination = { fileKey?: FileKey; filePath: string };

function hasStdinPipe(ctx: HushContext): boolean {
  try {
    return !ctx.process.stdin.isTTY;
  } catch {
    return false;
  }
}

function trimTrailingLineEndings(value: string): string {
  return value.replace(/[\r\n]+$/, '');
}

function readFromStdinPipe(ctx: HushContext): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';

    ctx.process.stdin.setEncoding('utf8');
    ctx.process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    ctx.process.stdin.on('end', () => {
      resolve(trimTrailingLineEndings(data));
    });
    ctx.process.stdin.on('error', reject);
    ctx.process.stdin.resume();
  });
}

function getExecErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }

  const execError = error as Error & { stderr?: string | Buffer };

  if (typeof execError.stderr === 'string' && execError.stderr.trim()) {
    return execError.stderr.trim();
  }

  if (Buffer.isBuffer(execError.stderr) && execError.stderr.length > 0) {
    return execError.stderr.toString('utf-8').trim();
  }

  return execError.message;
}

function promptViaMacOSDialog(ctx: HushContext, key: string): string {
  try {
    const script = `text returned of (display dialog "Enter value for ${key}:" default answer "" with hidden answer with title "Hush - Set Secret")`;
    const result = ctx.exec.execSync(`osascript -e '${script}'`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.toString().trim();
  } catch (error) {
    const message = getExecErrorMessage(error);
    if (message.toLowerCase().includes('user canceled')) {
      throw new Error('Cancelled');
    }
    throw new Error(`macOS dialog failed: ${message}`);
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

    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
    const result = ctx.exec.execSync(`powershell -EncodedCommand "${encodedCommand}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.toString().trim();
  } catch {
    return null;
  }
}

function promptViaLinuxDialog(ctx: HushContext, key: string): string | null {
  try {
    const result = ctx.exec.execSync(`zenity --entry --title="Hush - Set Secret" --text="Enter value for ${key}:"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.toString().trim();
  } catch {
    try {
      const result = ctx.exec.execSync(`kdialog --inputbox "Enter value for ${key}:" --title "Hush - Set Secret"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.toString().trim();
    } catch {
      return null;
    }
  }
}

function promptViaTTY(ctx: HushContext, key: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ctx.process.stdout.write(`Enter value for ${pc.cyan(key)}: `);

    const stdin = ctx.process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const onData = (char: string) => {
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          ctx.process.stdout.write('\n');
          resolve(trimTrailingLineEndings(value));
          break;
        case '\u0003':
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          ctx.process.stdout.write('\n');
          reject(new Error('Cancelled'));
          break;
        case '\u007F':
        case '\b':
          if (value.length > 0) {
            value = value.slice(0, -1);
            ctx.process.stdout.write('\b \b');
          }
          break;
        default:
          value += char;
          ctx.process.stdout.write('\u2022');
      }
    };

    stdin.on('data', onData);
  });
}

function normalizePromptValue(value: string): string {
  return trimTrailingLineEndings(value);
}

function isFileKey(value: string): value is FileKey {
  return POSITIONAL_FILE_ALIASES.has(value as FileKey);
}

function normalizeRequestedFilePath(value: string): string {
  return value.trim().replace(/\.encrypted$/, '').replace(/^\.hush\/files\//, '').replace(/^\/+/, '');
}

function resolveSetDestination(
  file: string | undefined,
  repoLocal: boolean | undefined,
  repository: HushV3Repository,
): SetDestination {
  if (repoLocal) {
    return { fileKey: 'local', filePath: DEFAULT_V3_FILE_PATHS.local };
  }

  const selected = file ?? 'shared';
  if (isFileKey(selected)) {
    return {
      fileKey: selected,
      filePath: DEFAULT_V3_FILE_PATHS[selected],
    };
  }

  const normalized = normalizeRequestedFilePath(selected);
  const matchedEntry = Object.entries(DEFAULT_V3_FILE_PATHS).find(([, candidatePath]) => candidatePath === normalized);
  if (matchedEntry) {
    const [fileKey, filePath] = matchedEntry as [FileKey, string];
    return { fileKey, filePath };
  }

  if (repository.filesByPath[normalized]) {
    return { filePath: normalized };
  }

  throw new Error(
    `Unknown set destination "${selected}". Use one of: shared, development, production, local, or a declared v3 file path like env/project/staging.`,
  );
}

function getScopeLabel(fileKey: FileKey | undefined, scope: 'repository' | 'machine-local'): string {
  if (scope === 'machine-local') {
    return 'repo-local';
  }

  if (!fileKey) {
    return 'repository';
  }

  return fileKey;
}

function getUsageLines(): string[] {
  return [
    pc.red('Usage: hush set <KEY> [VALUE] [--file <path-or-alias>] [--repo-local]'),
    pc.dim('Examples:'),
    pc.dim('  hush set DATABASE_URL'),
    pc.dim('  hush set API_KEY --file production'),
    pc.dim('  hush set API_KEY --repo-local'),
    pc.dim('  hush set WORKER_ENV staging --file env/project/staging'),
    pc.dim('\nTo edit all secrets in an editor, use: hush edit'),
  ];
}

function logUsage(ctx: HushContext): void {
  for (const line of getUsageLines()) {
    ctx.logger.error(line);
  }
}

function detectLegacyPositionalFileArg(key: string | undefined, file: string | undefined, repoLocal: boolean | undefined): void {
  if (repoLocal || file || !key || !isFileKey(key)) {
    return;
  }

  throw new Error(
    `Invalid syntax: "hush set ${key} KEY VALUE" is no longer supported. Use "hush set KEY VALUE --file ${key}" or "hush set KEY VALUE --repo-local" for local.`,
  );
}

function getDocumentValue(document: HushFileDocument | null, filePath: string, key: string): string | undefined {
  if (!document) {
    return undefined;
  }

  const entry = document.entries[`${filePath}/${key}`];
  if (!entry || 'type' in entry) {
    return undefined;
  }

  return typeof entry.value === 'string' ? entry.value : undefined;
}

function findSharedConflicts(ctx: HushContext, store: SetOptions['store'], repository: HushV3Repository, key: string): string[] {
  return FILE_KEYS
    .filter((fileKey) => fileKey !== 'shared')
    .filter((fileKey) => {
      const filePath = DEFAULT_V3_FILE_PATHS[fileKey];
      if (fileKey === 'local') {
        return getDocumentValue(loadMachineLocalOverrides(ctx, store), filePath, key) !== undefined;
      }

      const existing = repository.filesByPath[filePath];
      if (!existing) {
        return false;
      }

      return getDocumentValue(repository.loadFile(filePath), filePath, key) !== undefined;
    })
    .map((fileKey) => DEFAULT_V3_FILE_PATHS[fileKey]);
}

function loadEditableDestination(
  ctx: HushContext,
  store: SetOptions['store'],
  repository: HushV3Repository,
  destination: SetDestination,
): { document: HushFileDocument; filePath: string; systemPath: string; scope: 'repository' | 'machine-local' } {
  if (destination.fileKey) {
    return ensureEditableFileDocument(ctx, store, repository, destination.fileKey);
  }

  const systemPath = repository.fileSystemPaths[destination.filePath];
  if (!systemPath) {
    throw new Error(`File "${destination.filePath}" is not declared in this repository`);
  }

  return {
    document: repository.loadFile(destination.filePath),
    filePath: destination.filePath,
    systemPath,
    scope: 'repository',
  };
}

async function promptForValue(ctx: HushContext, key: string, forceGui: boolean): Promise<string> {
  if (!forceGui && hasStdinPipe(ctx)) {
    return normalizePromptValue(await readFromStdinPipe(ctx));
  }

  if (ctx.process.stdin.isTTY && !forceGui) {
    return normalizePromptValue(await promptViaTTY(ctx, key));
  }

  ctx.logger.log(pc.dim('Opening dialog for secret input...'));

  let value: string | null = null;

  switch (platform()) {
    case 'darwin':
      value = promptViaMacOSDialog(ctx, key);
      break;
    case 'win32':
      value = promptViaWindowsDialog(ctx, key);
      break;
    case 'linux':
      value = promptViaLinuxDialog(ctx, key);
      break;
  }

  if (value !== null) {
    return normalizePromptValue(value);
  }

  if (platform() === 'linux') {
    throw new Error('GUI prompt failed. Please install "zenity" or "kdialog".');
  }

  throw new Error('Dialog cancelled or failed. Interactive input requires a terminal (TTY) or a supported GUI environment.');
}

export async function setCommand(ctx: HushContext, options: SetOptions): Promise<void> {
  const {
    store,
    file,
    key,
    value: inlineValue,
    gui,
    repoLocal,
    showLength,
  } = options;

  if (store.mode === 'global') {
    ensureGlobalStoreBootstrap(ctx, store);
  }

  if (!key) {
    logUsage(ctx);
    ctx.process.exit(1);
  }

  let destination: SetDestination | null = null;
  let repository: HushV3Repository | null = null;

  try {
    detectLegacyPositionalFileArg(key, file, repoLocal);
    repository = requireV3Repository(store, 'set');
    destination = resolveSetDestination(file, repoLocal, repository);

    const value = inlineValue ?? await promptForValue(ctx, key, gui ?? false);

    if (!value) {
      ctx.logger.error(pc.yellow('No value entered. Nothing written.'));
      ctx.process.exit(1);
    }

    if (inlineValue === undefined && showLength) {
      ctx.logger.log(pc.dim(`input length: ${value.length} chars`));
    }

    ctx.logger.log(pc.dim(`will write ${key} -> ${destination.filePath}`));

    const activeIdentity = requireMutableIdentity(ctx, store, repository, {
      name: 'set',
      args: [destination.fileKey ?? destination.filePath, key],
    });
    const editable = loadEditableDestination(ctx, store, repository, destination);

    if (destination.filePath === DEFAULT_V3_FILE_PATHS.shared) {
      const conflicts = findSharedConflicts(ctx, store, repository, key);
      if (conflicts.length > 0) {
        ctx.logger.warn(pc.yellow(`warning: ${key} already exists in ${conflicts.join(', ')}; shared may not win at runtime.`));
      }
    }

    const nextDocument = setEnvValueInDocument(editable.document, key, value);
    if (editable.scope === 'machine-local') {
      writeMachineLocalOverrides(ctx, store, nextDocument);
    } else {
      writeEditableFileDocument(ctx, store, repository, editable.systemPath, nextDocument);
    }

    appendAuditEvent(ctx, store, {
      type: 'write',
      activeIdentity,
      success: true,
      command: { name: 'set', args: [destination.fileKey ?? destination.filePath, key] },
      files: [editable.filePath],
      logicalPaths: [`${editable.filePath}/${key}`],
      details: {
        scope: editable.scope,
        chars: value.length,
      },
    });

    const scopeLabel = getScopeLabel(destination.fileKey, editable.scope);
    ctx.logger.log(pc.green(`\n${key} set in ${editable.filePath} (${scopeLabel}, ${value.length} chars)`));
  } catch (error) {
    const err = error as Error;
    if (err.message === 'Cancelled') {
      ctx.logger.log(pc.yellow('Cancelled'));
      ctx.process.exit(1);
    }
    if (err.message.startsWith('Invalid syntax:') || err.message.startsWith('Unknown set destination')) {
      appendAuditEvent(ctx, store, {
        type: 'write',
        activeIdentity: readCurrentIdentity(ctx, store),
        success: false,
        command: { name: 'set', args: [destination?.fileKey ?? destination?.filePath ?? file ?? 'shared', key ?? ''] },
        reason: err.message,
      });
      ctx.logger.error(pc.red(err.message));
      logUsage(ctx);
      ctx.process.exit(1);
    }
    appendAuditEvent(ctx, store, {
      type: 'write',
      activeIdentity: readCurrentIdentity(ctx, store),
      success: false,
      command: { name: 'set', args: [destination?.fileKey ?? destination?.filePath ?? file ?? 'shared', key ?? ''] },
      reason: err.message,
    });
    throw err;
  }
}
