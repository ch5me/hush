import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { assertNode24 } from "../../scripts/install-local-helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binDir = mkdtempSync(join(tmpdir(), "hush-local-install-"));
const launchCwd = mkdtempSync(join(tmpdir(), "hush-local-install-launch-"));
const installer = join(root, "scripts", "install-local.mjs");
const runtimeBase = join(binDir, "runtimes");
const runtimeRoot = join(runtimeBase, "c".repeat(40));
const oldRuntime = join(runtimeBase, "a".repeat(40));
const retainedRuntime = join(runtimeBase, "b".repeat(40));
const launcherPath = join(binDir, "hush");
const env = {
  ...process.env,
  HUSH_INSTALL_BIN_DIR: binDir,
  HUSH_INSTALL_RUNTIME_ROOT: runtimeRoot,
  HUSH_NO_UPDATE_CHECK: "1",
  HUSH_INSTALL_SKIP_SHADOW_CHECK: "1",
  NODE_PATH: "",
};

function assertInside(path, boundary, label) {
  const escaped = relative(boundary, path);
  assert.notEqual(escaped, "..", `${label} escapes ${boundary}: ${path}`);
  assert.equal(escaped.startsWith(`..${sep}`), false, `${label} escapes ${boundary}: ${path}`);
  assert.equal(isAbsolute(escaped), false, `${label} is absolute: ${path}`);
}

function assertNoEscapingSymlinks(directory, boundary) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      const target = readlinkSync(path);
      assert.equal(isAbsolute(target), false, `absolute dependency symlink: ${path} -> ${target}`);
      assertInside(realpathSync(path), boundary, `dependency symlink: ${path} -> ${target}`);
    } else if (stats.isDirectory()) {
      assertNoEscapingSymlinks(path, boundary);
    }
  }
}

function assertNoEscapingDependencyTrees(directory, boundary) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stats = lstatSync(path);
    if (stats.isDirectory()) {
      if (name === "node_modules") assertNoEscapingSymlinks(path, boundary);
      else assertNoEscapingDependencyTrees(path, boundary);
    }
  }
}

try {
  mkdirSync(oldRuntime, { recursive: true });
  mkdirSync(retainedRuntime, { recursive: true });
  utimesSync(oldRuntime, 1, 1);
  utimesSync(retainedRuntime, 2, 2);
  assert.throws(() => assertNode24("23.11.0"), /requires Node 24/);
  assert.doesNotThrow(() => assertNode24(process.version));

  mkdirSync(join(runtimeRoot, "hush-cli", "bin"), { recursive: true });
  writeFileSync(join(runtimeRoot, "hush-cli", "bin", "hush.js"), "");
  writeFileSync(launcherPath, "prior launcher\n");
  const priorLauncher = readFileSync(launcherPath);
  const unavailableBin = mkdtempSync(join(tmpdir(), "hush-local-install-empty-bin-"));
  const incomplete = spawnSync(process.execPath, [installer], {
    cwd: root,
    env: { ...env, PATH: unavailableBin },
    encoding: "utf8",
  });
  assert.notEqual(incomplete.status, 0);
  assert.deepEqual(readFileSync(launcherPath), priorLauncher, "failed staging changed launcher");
  rmSync(unavailableBin, { recursive: true, force: true });
  rmSync(runtimeRoot, { recursive: true, force: true });
  rmSync(launcherPath);

  const install = spawnSync(process.execPath, [installer], { cwd: root, env, encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);

  const launcher = readFileSync(launcherPath, "utf8");
  assert.equal(Number(process.versions.node.split(".", 1)[0]), 24);
  assert.ok(launcher.includes(`exec '${realpathSync(process.execPath)}'`));
  assert.ok(launcher.includes(join(runtimeRoot, "hush-cli", "bin", "hush.js")));
  assert.doesNotMatch(launcher, /\/src\/ch5\/hush(?:\/|$)/);
  assert.doesNotMatch(launcher, /\bbun\b/);
  assert.ok(readFileSync(join(runtimeRoot, "hush-cli", "dist", "cli.js"), "utf8").length > 0);
  assert.equal(existsSync(oldRuntime), false);
  assert.equal(existsSync(retainedRuntime), true);

  const runtimeCliRoot = join(runtimeRoot, "hush-cli");
  const runtimeRequire = createRequire(join(runtimeCliRoot, "package.json"));
  for (const dependency of ["picocolors", "yaml"]) {
    const resolved = realpathSync(runtimeRequire.resolve(dependency));
    assertInside(resolved, runtimeRoot, `${dependency} resolution`);
    assert.equal(resolved.startsWith(`${root}${sep}`), false, `${dependency} resolves into source workspace`);
  }
  assertNoEscapingDependencyTrees(runtimeRoot, runtimeRoot);

  const version = spawnSync(launcherPath, ["--version"], { cwd: launchCwd, env, encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/);

  writeFileSync(launcherPath, `${launcher}\n`);
  const drift = spawnSync(process.execPath, [installer, "--check"], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(drift.status, 0);
} finally {
  rmSync(binDir, { recursive: true, force: true });
  rmSync(launchCwd, { recursive: true, force: true });
}

console.log("local install verified");
