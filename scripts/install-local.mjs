#!/usr/bin/env node
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const builtCli = join(root, "hush-cli", "dist", "cli.js");
const runtimeRoot = resolve(process.env.HUSH_INSTALL_RUNTIME_ROOT || root);
const binDir = resolve(process.env.HUSH_INSTALL_BIN_DIR || join(homedir(), ".local", "bin"));
const target = join(binDir, "hush");
const temporary = `${target}.tmp-${process.pid}`;
const nodePath = realpathSync(process.execPath);

if (!existsSync(builtCli)) {
  throw new Error(`Hush build missing: ${builtCli}. Run \`bun run cli:build\` first.`);
}

if (Number(process.versions.node.split(".", 1)[0]) !== 24) {
  throw new Error(`Hush requires Node 24; got ${process.version}. Run through the managed Mise toolchain.`);
}

if (runtimeRoot !== root) {
  const runtimeEntrypoint = join(runtimeRoot, "hush-cli", "bin", "hush.js");
  if (!existsSync(runtimeEntrypoint)) {
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
      renameSync(runtimeTemporary, runtimeRoot);
    } finally {
      rmSync(runtimeTemporary, { recursive: true, force: true });
    }
  }
}

const entrypoint = join(runtimeRoot, "hush-cli", "bin", "hush.js");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const launcher = `#!/bin/sh
set -eu

exec ${quote(nodePath)} ${quote(entrypoint)} "$@"
`;

if (process.argv.includes("--check")) {
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

console.log(target);
