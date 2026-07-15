import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { assertNode24 } from "../../scripts/install-local-helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binDir = mkdtempSync(join(tmpdir(), "hush-local-install-"));
const installer = join(root, "scripts", "install-local.mjs");
const runtimeBase = join(binDir, "runtimes");
const runtimeRoot = join(runtimeBase, "c".repeat(40));
const oldRuntime = join(runtimeBase, "a".repeat(40));
const retainedRuntime = join(runtimeBase, "b".repeat(40));
const env = {
  ...process.env,
  HUSH_INSTALL_BIN_DIR: binDir,
  HUSH_INSTALL_RUNTIME_ROOT: runtimeRoot,
  HUSH_NO_UPDATE_CHECK: "1",
};

try {
  mkdirSync(oldRuntime, { recursive: true });
  mkdirSync(retainedRuntime, { recursive: true });
  utimesSync(oldRuntime, 1, 1);
  utimesSync(retainedRuntime, 2, 2);
  assert.throws(() => assertNode24("23.11.0"), /requires Node 24/);
  assert.doesNotThrow(() => assertNode24(process.version));

  const install = spawnSync(process.execPath, [installer], { cwd: root, env, encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);

  const launcherPath = join(binDir, "hush");
  const launcher = readFileSync(launcherPath, "utf8");
  assert.equal(Number(process.versions.node.split(".", 1)[0]), 24);
  assert.match(launcher, new RegExp(`exec '${realpathSync(process.execPath).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
  assert.match(launcher, new RegExp(`${join(runtimeRoot, "hush-cli", "bin", "hush.js").replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(launcher, /\/src\/ch5\/hush(?:\/|$)/);
  assert.doesNotMatch(launcher, /\bbun\b/);
  assert.ok(readFileSync(join(runtimeRoot, "hush-cli", "dist", "cli.js"), "utf8").length > 0);
  assert.equal(existsSync(oldRuntime), false);
  assert.equal(existsSync(retainedRuntime), true);

  const version = spawnSync(launcherPath, ["--version"], { cwd: root, env, encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/);

  const check = spawnSync(process.execPath, [installer, "--check"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);

  writeFileSync(launcherPath, `${launcher}\n`);
  const drift = spawnSync(process.execPath, [installer, "--check"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.notEqual(drift.status, 0);
} finally {
  rmSync(binDir, { recursive: true, force: true });
}

console.log("local install verified");
