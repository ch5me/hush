#!/usr/bin/env node
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNode24 } from "./install-local-helpers.mjs";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const builtCli = join(root, "hush-cli", "dist", "cli.js");
const runtimeRoot = resolve(process.env.HUSH_INSTALL_RUNTIME_ROOT || root);
const binDir = resolve(process.env.HUSH_INSTALL_BIN_DIR || join(homedir(), ".local", "bin"));
const target = join(binDir, "hush");
const temporary = `${target}.tmp-${process.pid}`;
const nodePath = realpathSync(process.execPath);
const runtimeEntrypoint = join(runtimeRoot, "hush-cli", "bin", "hush.js");
const runtimeCli = join(runtimeRoot, "hush-cli", "dist", "cli.js");

if (!existsSync(builtCli)) {
  throw new Error(`Hush build missing: ${builtCli}. Run \`bun run cli:build\` first.`);
}

assertNode24(process.version);

if (runtimeRoot !== root) {
  const runtimeReady = existsSync(runtimeEntrypoint) && existsSync(runtimeCli);
  if (!runtimeReady) {
    if (existsSync(runtimeRoot)) {
      throw new Error(`Hush runtime incomplete: ${runtimeRoot}. Remove it and reinstall.`);
    }
    const runtimeTemporary = `${runtimeRoot}.tmp-${process.pid}`;
    mkdirSync(dirname(runtimeRoot), { recursive: true });
    try {
      cpSync(root, runtimeTemporary, {
        recursive: true,
        filter: (source) => {
          const path = relative(root, source);
          return path !== ".git" && !path.startsWith(`.git${sep}`);
        },
      });
      if (!existsSync(join(runtimeTemporary, "hush-cli", "bin", "hush.js"))
        || !existsSync(join(runtimeTemporary, "hush-cli", "dist", "cli.js"))) {
        throw new Error(`Hush runtime staging incomplete: ${runtimeTemporary}`);
      }
      renameSync(runtimeTemporary, runtimeRoot);
    } finally {
      rmSync(runtimeTemporary, { recursive: true, force: true });
    }
  }
}

const entrypoint = runtimeEntrypoint;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const launcher = `#!/bin/sh
set -eu

exec ${quote(nodePath)} ${quote(entrypoint)} "$@"
`;

if (process.argv.includes("--check")) {
  if (runtimeRoot !== root && (!existsSync(runtimeEntrypoint) || !existsSync(runtimeCli))) {
    throw new Error(`Hush runtime incomplete: ${runtimeRoot}. Remove it and reinstall.`);
  }
  if (!existsSync(target) || readFileSync(target, "utf8") !== launcher) {
    throw new Error(`Hush launcher drift: ${target}. Re-run \`node scripts/install-local.mjs\`.`);
  }
  console.log(target);
  process.exit(0);
}

mkdirSync(binDir, { recursive: true });
try {
  writeFileSync(temporary, launcher, { mode: 0o755 });
  chmodSync(temporary, 0o755);
  renameSync(temporary, target);
} finally {
  rmSync(temporary, { force: true });
}

if (runtimeRoot !== root) {
  const runtimeParent = dirname(runtimeRoot);
  const activeName = runtimeRoot.slice(runtimeParent.length + 1);
  if (/^[0-9a-f]{40}$/.test(activeName)) {
    const candidates = readdirSync(runtimeParent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()
        && entry.name !== activeName
        && /^[0-9a-f]{40}$/.test(entry.name))
      .map((entry) => ({
        path: join(runtimeParent, entry.name),
        name: entry.name,
        modified: statSync(join(runtimeParent, entry.name)).mtimeMs,
      }))
      .sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name));
    const keep = new Set([activeName, ...candidates.slice(0, 1).map((entry) => entry.name)]);
    for (const candidate of candidates) {
      if (!keep.has(candidate.name)) {
        rmSync(candidate.path, { recursive: true, force: true });
      }
    }
  }
}

console.log(target);
