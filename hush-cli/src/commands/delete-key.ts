import { createInterface } from "node:readline";

import pc from "picocolors";
import { stringify as stringifyYaml } from "yaml";

import { writeJsonSuccess } from "../lib/command-output.js";
import type { DeleteKeyOptions, HushContext, HushFileDocument, HushFileEntry } from "../types.js";
import { appendAuditEvent } from "../v3/audit.js";
import { createFileDocument } from "../v3/domain.js";
import { MACHINE_LOCAL_FILE_PATH, assertRepositoryFilePath } from "../v3/schema.js";
import { withSuggestion } from "./mutation-feedback.js";
import {
  MACHINE_LOCAL_ALIAS,
  ensureMachineLocalDocument,
  normalizeRequestedFilePath,
  readCurrentIdentity,
  requireMutableIdentity,
  requireV3Repository,
  writeEditableFileDocument,
  writeMachineLocalOverrides,
} from "./v3-command-helpers.js";

function logicalPathKey(logicalPath: string): string {
  return logicalPath.split("/").filter(Boolean).at(-1) ?? logicalPath;
}

export function removeEnvValueFromDocument(
  document: HushFileDocument,
  key: string,
): {
  nextDocument: HushFileDocument;
  logicalPath: string;
  entry: HushFileEntry;
} {
  const matches = Object.entries(document.entries).filter(
    ([logicalPath]) => logicalPathKey(logicalPath) === key,
  );
  if (matches.length === 0) {
    throw new Error(`Key "${key}" was not found in ${document.path}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Key "${key}" matched multiple entries in ${document.path}; use a file with unambiguous leaf keys before deleting`,
    );
  }

  const [logicalPath, entry] = matches[0]!;
  const { [logicalPath]: _removed, ...remainingEntries } = document.entries;
  return {
    nextDocument: createFileDocument({
      ...document,
      entries: remainingEntries,
    }),
    logicalPath,
    entry,
  };
}

async function confirmDeletion(ctx: HushContext, key: string, filePath: string): Promise<boolean> {
  if (!ctx.process.stdin.isTTY) {
    throw new Error("delete-key requires confirmation. Re-run with --yes in non-interactive mode.");
  }

  const rl = createInterface({
    input: ctx.process.stdin,
    output: ctx.process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      `${pc.bold(`Delete ${key} from ${filePath}? Type "yes" to confirm:`)} `,
      (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === "yes");
      },
    );
  });
}

async function deleteMachineLocalKey(
  ctx: HushContext,
  options: DeleteKeyOptions,
  key: string,
  activeIdentity: string,
  command: { name: string; args: string[] },
): Promise<void> {
  const { document } = ensureMachineLocalDocument(ctx, options.store);
  const { nextDocument, logicalPath } = removeEnvValueFromDocument(document, key);

  if (!options.json) {
    ctx.logger.log(
      pc.yellow(`This will delete ${key} from ${MACHINE_LOCAL_FILE_PATH} (this machine only)`),
    );
  }

  if (!options.yes) {
    const confirmed = await confirmDeletion(ctx, key, MACHINE_LOCAL_FILE_PATH);
    if (!confirmed) {
      if (options.json) {
        writeJsonSuccess(ctx, "delete-key", {
          action: "delete",
          changed: false,
          key,
          requestedScope: { from: options.from },
          resolvedScope: { from: MACHINE_LOCAL_FILE_PATH },
          from: MACHINE_LOCAL_FILE_PATH,
          cancelled: true,
        });
      } else {
        ctx.logger.log(pc.yellow("Cancelled"));
      }
      return;
    }
  }

  writeMachineLocalOverrides(ctx, options.store, nextDocument);

  appendAuditEvent(ctx, options.store, {
    type: "write",
    activeIdentity,
    success: true,
    command,
    files: [MACHINE_LOCAL_FILE_PATH],
    logicalPaths: [logicalPath],
    details: { action: "delete", key, from: MACHINE_LOCAL_FILE_PATH },
  });

  const payload = {
    ok: true,
    action: "delete",
    changed: true,
    key,
    requestedScope: { from: options.from },
    resolvedScope: { from: MACHINE_LOCAL_FILE_PATH },
    from: MACHINE_LOCAL_FILE_PATH,
    logicalPath,
  };

  if (options.json) {
    writeJsonSuccess(ctx, "delete-key", payload);
    return;
  }

  ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
}

export async function deleteKeyCommand(ctx: HushContext, options: DeleteKeyOptions): Promise<void> {
  const key = options.key?.trim();
  const from = options.from?.trim();
  if (!key || !from) {
    throw new Error("Usage: hush delete-key <KEY> --from <file-path>");
  }

  const command = { name: "delete-key", args: [key, "--from", from] };

  try {
    const repository = requireV3Repository(options.store, "delete-key");
    const activeIdentity = requireMutableIdentity(ctx, options.store, repository, command);

    // `local` / `user/local` removes from the machine-local store.
    //
    // This used to be refused, leaving `hush edit --file local` — an interactive
    // $EDITOR — as the only way to remove an override. That is unusable from a
    // script or an agent, which matters because the shadow guard's remediation
    // is exactly "remove this override": telling a caller to fix something it
    // has no non-interactive command for is not a remediation. The selector is
    // still never REINTERPRETED — an explicit machine-local selector only ever
    // touches machine-local storage, and every other selector only ever touches
    // committed repository files.
    if (
      from === MACHINE_LOCAL_ALIAS ||
      normalizeRequestedFilePath(from) === MACHINE_LOCAL_FILE_PATH
    ) {
      await deleteMachineLocalKey(ctx, options, key, activeIdentity, command);
      return;
    }

    // Repository files only, fail closed — never reinterpret a machine-local
    // selector as a repository file, or vice versa.
    const filePath = assertRepositoryFilePath(
      from,
      `Machine-local overrides live at "${MACHINE_LOCAL_FILE_PATH}"; pass --from ${MACHINE_LOCAL_ALIAS} ` +
        `(or --from ${MACHINE_LOCAL_FILE_PATH}) to remove one.`,
    );
    const systemPath = repository.fileSystemPaths[filePath];
    if (!systemPath) {
      throw new Error(
        withSuggestion(
          `File "${filePath}" is not declared in this repository. Nothing was deleted.`,
          filePath,
          Object.keys(repository.fileSystemPaths),
        ),
      );
    }
    const document = repository.loadFile(filePath);
    const { nextDocument, logicalPath } = removeEnvValueFromDocument(document, key);
    const preview = `This will delete ${key} from ${filePath}`;

    if (!options.json) {
      ctx.logger.log(pc.yellow(preview));
    }

    if (!options.yes) {
      const confirmed = await confirmDeletion(ctx, key, filePath);
      if (!confirmed) {
        if (options.json) {
          writeJsonSuccess(ctx, "delete-key", {
            action: "delete",
            changed: false,
            key,
            requestedScope: { from: options.from },
            resolvedScope: { from: filePath },
            from: filePath,
            cancelled: true,
          });
        } else {
          ctx.logger.log(pc.yellow("Cancelled"));
        }
        return;
      }
    }

    writeEditableFileDocument(ctx, options.store, repository, systemPath, nextDocument);

    appendAuditEvent(ctx, options.store, {
      type: "write",
      activeIdentity,
      success: true,
      command,
      files: [filePath],
      logicalPaths: [logicalPath],
      details: {
        action: "delete",
        key,
        from: filePath,
      },
    });

    const payload = {
      ok: true,
      action: "delete",
      changed: true,
      key,
      requestedScope: { from: options.from },
      resolvedScope: { from: filePath },
      from: filePath,
      logicalPath,
    };

    if (options.json) {
      writeJsonSuccess(ctx, "delete-key", payload);
      return;
    }

    ctx.logger.log(stringifyYaml(payload, { indent: 2 }).trimEnd());
  } catch (error) {
    const err = error as Error;
    appendAuditEvent(ctx, options.store, {
      type: "write",
      activeIdentity: readCurrentIdentity(ctx, options.store),
      success: false,
      command,
      reason: err.message,
      details: {
        action: "delete",
        key,
        from,
      },
    });
    throw err;
  }
}
