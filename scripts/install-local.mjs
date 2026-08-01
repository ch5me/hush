#!/usr/bin/env node
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function assertRuntime(runtime) {
  const entrypoint = join(runtime, "hush-cli", "bin", "hush.js");
  const cli = join(runtime, "hush-cli", "dist", "cli.js");
  if (!existsSync(entrypoint) || !existsSync(cli)) {
    throw new Error(`Hush runtime incomplete: ${runtime}`);
  }

  const pending = [runtime];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (lstatSync(path).isSymbolicLink()) {
        const target = realpathSync(path);
        if (!isWithin(runtime, target)) {
          throw new Error(`Hush runtime symlink escapes runtime root: ${path} -> ${target}`);
        }
        if (statSync(path).isDirectory()) pending.push(path);
      } else if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }

  const dependencies = Object.keys(JSON.parse(readFileSync(join(runtime, "hush-cli", "package.json"), "utf8")).dependencies ?? {});
  const resolved = JSON.parse(execFileSync(nodePath, [
    "--input-type=module",
    "--eval",
    `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(cli)}); console.log(JSON.stringify(${JSON.stringify(dependencies)}.map((name) => require.resolve(name))));`,
  ], { encoding: "utf8" }));
  for (const dependency of resolved) {
    if (!isWithin(runtime, realpathSync(dependency))) {
      throw new Error(`Hush runtime dependency resolves outside runtime root: ${dependency}`);
    }
  }

  execFileSync(nodePath, [entrypoint, "--version"], {
    env: { ...process.env, HUSH_NO_UPDATE_CHECK: "1" },
    stdio: "ignore",
  });
}

if (runtimeRoot !== root && existsSync(runtimeRoot)) {
  assertRuntime(runtimeRoot);
}

if (runtimeRoot !== root && !existsSync(runtimeRoot)) {
  const runtimeTemporary = `${runtimeRoot}.tmp-${process.pid}`;
  mkdirSync(dirname(runtimeRoot), { recursive: true });
  try {
    cpSync(root, runtimeTemporary, {
      recursive: true,
      filter: (source) => {
        const path = relative(root, source);
        if (path === "") return true;
        if (path === "package.json" || path === "bun.lock" || path === ".npmrc") return true;
        if (path === "docs" || path === `docs${sep}package.json`) return true;
        if (path === "hush-cli") return true;
        if (!path.startsWith(`hush-cli${sep}`)) return false;
        return !path.split(sep).includes("node_modules");
      },
    });
    execFileSync("bun", [
      "install",
      "--production",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--backend",
      "copyfile",
    ], { cwd: runtimeTemporary, stdio: "inherit" });
    assertRuntime(runtimeTemporary);
    renameSync(runtimeTemporary, runtimeRoot);
  } finally {
    rmSync(runtimeTemporary, { recursive: true, force: true });
  }
}

const entrypoint = runtimeEntrypoint;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const launcher = `#!/bin/sh
set -eu

exec ${quote(nodePath)} ${quote(entrypoint)} "$@"
`;

// Installing the managed hush is not the same as DELIVERING it. If another copy
// sits earlier on PATH -- typically a stray `npm install -g @chriscode/hush`
// under a Homebrew npm prefix -- then every login shell, and anything launched
// through one, keeps running that copy. It resolves, it answers, and nothing
// upstream notices: on 2026-07-25 a box ran a two-week-old 7.5.0 secrets front
// door while this installer kept reporting success. hush is the fleet's secrets
// boundary, so a silent shadow is a hazard, not cosmetics. Assert on the
// consuming surface rather than trusting that writing the file was enough.
function reportShadowedInstall() {
  if (process.env.HUSH_INSTALL_SKIP_SHADOW_CHECK === "1") return false;

  const loginShell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/sh";
  let resolved = "";
  try {
    resolved = execFileSync(loginShell, ["-lc", "command -v hush"], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    resolved = "";
  }

  if (!resolved) {
    console.error(
      `hush: installed ${target}, but a login shell (${loginShell} -lc) resolves no hush at all -- ` +
        `${binDir} is missing from the login PATH, so this install is not delivered.`,
    );
    return false;
  }

  let same;
  try {
    same = realpathSync(resolved) === realpathSync(target);
  } catch {
    same = resolved === target;
  }
  if (same) return false;

  console.error(
    `hush: SHADOWED INSTALL. Installed ${target}, but a login shell resolves ${resolved} first.\n` +
      `hush is the secrets front door: every interactive shell would keep using that other copy, ` +
      `and this installer does not upgrade it.\n` +
      `Fix the shadow (for a global npm copy: npm uninstall -g @chriscode/hush), or put ${binDir} ` +
      `ahead of it on the login PATH, then re-run.\n` +
      `Set HUSH_INSTALL_SKIP_SHADOW_CHECK=1 to bypass deliberately.`,
  );
  return true;
}

if (process.argv.includes("--check")) {
  if (runtimeRoot !== root) assertRuntime(runtimeRoot);
  if (!existsSync(target) || readFileSync(target, "utf8") !== launcher) {
    throw new Error(`Hush launcher drift: ${target}. Re-run \`node scripts/install-local.mjs\`.`);
  }
  const shadowed = reportShadowedInstall();
  console.log(target);
  process.exit(shadowed ? 1 : 0);
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

if (reportShadowedInstall()) process.exitCode = 1;

console.log(target);
