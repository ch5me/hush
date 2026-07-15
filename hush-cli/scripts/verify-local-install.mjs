import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binDir = mkdtempSync(join(tmpdir(), "hush-local-install-"));
const installer = join(root, "scripts", "install-local.mjs");
const runtimeRoot = join(binDir, "runtime");
const env = {
  ...process.env,
  HUSH_INSTALL_BIN_DIR: binDir,
  HUSH_INSTALL_RUNTIME_ROOT: runtimeRoot,
  HUSH_NO_UPDATE_CHECK: "1",
};

try {
  const install = spawnSync(process.execPath, [installer], { cwd: root, env, encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);

  const launcherPath = join(binDir, "hush");
  const launcher = readFileSync(launcherPath, "utf8");
  assert.equal(Number(process.versions.node.split(".", 1)[0]), 24);
  assert.match(launcher, new RegExp(`exec '${realpathSync(process.execPath).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
  assert.match(launcher, new RegExp(`${join(runtimeRoot, "hush-cli", "bin", "hush.js").replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(launcher, /\/src\/ch5\/hush(?:\/|$)/);
  assert.doesNotMatch(launcher, /\bbun\b/);

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
