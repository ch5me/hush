#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const entrypoint = join(root, "hush-cli", "bin", "hush.js");
const builtCli = join(root, "hush-cli", "dist", "cli.js");
const binDir = resolve(process.env.HUSH_INSTALL_BIN_DIR || join(homedir(), ".local", "bin"));
const target = join(binDir, "hush");
const temporary = `${target}.tmp-${process.pid}`;

if (!existsSync(builtCli)) {
  throw new Error(`Hush build missing: ${builtCli}. Run \`bun run cli:build\` first.`);
}

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const launcher = `#!/bin/sh
set -eu

exec ${quote(realpathSync(process.execPath))} ${quote(entrypoint)} "$@"
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
