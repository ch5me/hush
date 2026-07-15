import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binDir = mkdtempSync(join(tmpdir(), "hush-local-install-"));
const installer = join(root, "scripts", "install-local.mjs");
const env = { ...process.env, HUSH_INSTALL_BIN_DIR: binDir, HUSH_NO_UPDATE_CHECK: "1" };

try {
  const install = spawnSync(process.execPath, [installer], { cwd: root, env, encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);

  const launcherPath = join(binDir, "hush");
  const launcher = readFileSync(launcherPath, "utf8");
  assert.match(launcher, new RegExp(`exec '${process.execPath.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
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
} finally {
  rmSync(binDir, { recursive: true, force: true });
}

console.log("local install verified");
