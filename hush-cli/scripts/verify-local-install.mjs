import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNode24 } from "../../scripts/install-local-helpers.mjs";
import {
  createRuntimeManifest,
  sourceIdentity,
  stageRuntime,
  validateRuntimeGraph,
} from "../../scripts/install-local.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binDir = realpathSync(mkdtempSync(join(tmpdir(), "hush-local-install-")));
const installer = join(root, "scripts", "install-local.mjs");
const runtimeBase = join(binDir, "runtimes");
const runtimeRoot = join(runtimeBase, "c".repeat(40));
const oldRuntime = join(runtimeBase, "a".repeat(40));
const retainedRuntime = join(runtimeBase, "b".repeat(40));
const neutralCwd = join(binDir, "neutral-cwd");
const fixtureBase = join(binDir, "fixtures");
const env = {
  ...process.env,
  HUSH_INSTALL_BIN_DIR: binDir,
  HUSH_INSTALL_RUNTIME_ROOT: runtimeRoot,
  HUSH_INSTALL_SKIP_SHADOW_CHECK: "1",
  HUSH_NO_UPDATE_CHECK: "1",
  NODE_PATH: "",
};

function runInstaller(args = [], overrides = {}) {
  return spawnSync(process.execPath, [installer, ...args], {
    cwd: neutralCwd,
    env: { ...env, ...overrides },
    encoding: "utf8",
  });
}

function writePackage(path, document, entrypoint = "export default true;\n") {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), `${JSON.stringify(document, null, 2)}\n`);
  if (document.main && !document.main.startsWith("..")) {
    writeFileSync(join(path, document.main), entrypoint);
  }
}

function writeRuntimeFixture(name, packageDocument = {}) {
  const fixtureRoot = join(fixtureBase, name);
  mkdirSync(join(fixtureRoot, "hush-cli", "bin"), { recursive: true });
  mkdirSync(join(fixtureRoot, "hush-cli", "dist"), { recursive: true });
  writeFileSync(join(fixtureRoot, "hush-cli", "bin", "hush.js"), "");
  writeFileSync(join(fixtureRoot, "hush-cli", "dist", "cli.js"), "");
  writeFileSync(
    join(fixtureRoot, "hush-cli", "package.json"),
    `${JSON.stringify({ name: "@fixture/hush", ...packageDocument }, null, 2)}\n`,
  );
  return fixtureRoot;
}

function assertSourceProvenance() {
  const sourceRoot = writeRuntimeFixture("source-provenance");
  mkdirSync(join(sourceRoot, "docs"), { recursive: true });
  writeFileSync(join(sourceRoot, ".npmrc"), "registry=https://example.invalid/\n");
  writeFileSync(join(sourceRoot, "bun.lock"), "fixture lock\n");
  writeFileSync(join(sourceRoot, "package.json"), '{"name":"fixture-root"}\n');
  writeFileSync(join(sourceRoot, "docs", "package.json"), '{"name":"fixture-docs"}\n');
  writeFileSync(join(sourceRoot, "hush-cli", "schema.json"), "{}\n");
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: sourceRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q");
  git("config", "user.name", "Hush Installer Test");
  git("config", "user.email", "hush-installer-test@example.invalid");
  git("add", ".npmrc", "bun.lock", "docs/package.json", "hush-cli/bin/hush.js",
    "hush-cli/package.json", "hush-cli/schema.json", "package.json");
  git("commit", "-qm", "test fixture");
  const original = sourceIdentity(sourceRoot);
  assert.match(original.tracked.commit, /^[0-9a-f]{40}$/);
  assert.match(original.tracked.tree, /^[0-9a-f]{40}$/);
  assert.match(original.build.sha256, /^[0-9a-f]{64}$/);
  assert.match(original.dependencies.sha256, /^[0-9a-f]{64}$/);

  writeFileSync(join(sourceRoot, "hush-cli", "package.json"), '{"name":"dirty"}\n');
  assert.throws(
    () => sourceIdentity(sourceRoot),
    /Hush tracked shipped input differs from HEAD: hush-cli\/package\.json/,
  );
  git("checkout", "-q", "--", "hush-cli/package.json");

  writeFileSync(join(sourceRoot, "hush-cli", "dist", "cli.js"), "changed build\n");
  mkdirSync(join(sourceRoot, "hush-cli", "node_modules", "ambient"), { recursive: true });
  writeFileSync(join(sourceRoot, "hush-cli", "node_modules", "ambient", "index.js"), "ambient\n");
  const rebuilt = sourceIdentity(sourceRoot);
  assert.deepEqual(rebuilt.tracked, original.tracked);
  assert.notEqual(rebuilt.build.sha256, original.build.sha256);
  assert.deepEqual(rebuilt.dependencies, original.dependencies);

  const stagedRoot = join(fixtureBase, "source-staged");
  mkdirSync(stagedRoot);
  stageRuntime(sourceRoot, stagedRoot);
  assert.equal(existsSync(join(stagedRoot, "hush-cli", "dist", "cli.js")), true);
  assert.equal(existsSync(join(stagedRoot, "hush-cli", "node_modules")), false);

  const outsideInput = join(fixtureBase, "outside-input");
  writeFileSync(outsideInput, "outside\n");
  rmSync(join(sourceRoot, ".npmrc"));
  symlinkSync(outsideInput, join(sourceRoot, ".npmrc"));
  assert.throws(
    () => stageRuntime(sourceRoot, join(fixtureBase, "symlinked-source-staged")),
    /Hush runtime input must be a regular file/,
  );
}

function escapingMain(packageRoot, outsideFile) {
  return relative(packageRoot, outsideFile);
}

function assertRuntimeFixtures() {
  const outsideFile = join(fixtureBase, "outside.js");
  mkdirSync(fixtureBase, { recursive: true });
  writeFileSync(outsideFile, "export default false;\n");

  const internalRoot = writeRuntimeFixture("internal", { dependencies: { "@fixture/internal": "1.0.0" } });
  const internalPackage = join(internalRoot, "hush-cli", "node_modules", "@fixture", "internal");
  writePackage(internalPackage, { name: "@fixture/internal", version: "1.0.0", main: "index.js" });
  assert.doesNotThrow(() => validateRuntimeGraph(internalRoot));

  const nestedRoot = writeRuntimeFixture("nested", { dependencies: { "fixture-parent": "1.0.0" } });
  const parentPackage = join(nestedRoot, "hush-cli", "node_modules", "fixture-parent");
  const childPackage = join(parentPackage, "node_modules", "fixture-child");
  writePackage(parentPackage, {
    name: "fixture-parent",
    version: "1.0.0",
    main: "index.js",
    dependencies: { "fixture-child": "1.0.0" },
  });
  writePackage(childPackage, {
    name: "fixture-child",
    version: "1.0.0",
    main: escapingMain(childPackage, outsideFile),
  });
  assert.throws(
    () => validateRuntimeGraph(nestedRoot),
    /Hush runtime dependency escapes runtime: fixture-child/,
  );

  const optionalRoot = writeRuntimeFixture("optional", {
    optionalDependencies: { "fixture-optional": "1.0.0", "fixture-missing": "1.0.0" },
  });
  const optionalPackage = join(optionalRoot, "hush-cli", "node_modules", "fixture-optional");
  writePackage(optionalPackage, {
    name: "fixture-optional",
    version: "1.0.0",
    main: escapingMain(optionalPackage, outsideFile),
  });
  assert.throws(
    () => validateRuntimeGraph(optionalRoot),
    /Hush runtime optional dependency escapes runtime: fixture-optional/,
  );

  const peerRoot = writeRuntimeFixture("peer", {
    peerDependencies: { "fixture-peer": "1.0.0", "fixture-peer-optional": "1.0.0" },
    peerDependenciesMeta: { "fixture-peer-optional": { optional: true } },
  });
  const peerPackage = join(peerRoot, "hush-cli", "node_modules", "fixture-peer");
  writePackage(peerPackage, {
    name: "fixture-peer",
    version: "1.0.0",
    main: escapingMain(peerPackage, outsideFile),
  });
  assert.throws(
    () => validateRuntimeGraph(peerRoot),
    /Hush runtime peer dependency escapes runtime: fixture-peer/,
  );

  const symlinkRoot = writeRuntimeFixture("symlink-source");
  const symlinkCandidate = join(fixtureBase, "symlink-root");
  symlinkSync(symlinkRoot, symlinkCandidate, "dir");
  assert.throws(
    () => validateRuntimeGraph(symlinkCandidate),
    /Hush runtime root must be a real directory/,
  );

  const linkRoot = writeRuntimeFixture("links");
  const internalTarget = join(linkRoot, "internal-target.js");
  writeFileSync(internalTarget, "");
  symlinkSync(internalTarget, join(linkRoot, "internal-link.js"));
  assert.doesNotThrow(() => validateRuntimeGraph(linkRoot));
  const linkManifest = createRuntimeManifest(linkRoot, { commit: "fixture", tree: "fixture" });
  assert.ok(linkManifest.files.some((entry) =>
    entry.path === "internal-link.js" && entry.type === "symlink" && entry.resolved && entry.sha256));
  symlinkSync(outsideFile, join(linkRoot, "external-link.js"));
  assert.throws(
    () => validateRuntimeGraph(linkRoot),
    /Hush runtime symlink escapes runtime: external-link\.js/,
  );
}

try {
  mkdirSync(neutralCwd);
  mkdirSync(oldRuntime, { recursive: true });
  mkdirSync(retainedRuntime, { recursive: true });
  utimesSync(oldRuntime, 1, 1);
  utimesSync(retainedRuntime, 2, 2);
  assert.throws(() => assertNode24("23.11.0"), /requires Node 24/);
  assert.doesNotThrow(() => assertNode24(process.version));
  assertSourceProvenance();
  assertRuntimeFixtures();

  mkdirSync(join(runtimeRoot, "hush-cli", "bin"), { recursive: true });
  writeFileSync(join(runtimeRoot, "hush-cli", "bin", "hush.js"), "");
  const incomplete = runInstaller();
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /Hush runtime incomplete/);
  rmSync(runtimeRoot, { recursive: true, force: true });

  const install = runInstaller();
  assert.equal(install.status, 0, install.stderr);

  const launcherPath = join(binDir, "hush");
  const launcher = readFileSync(launcherPath, "utf8");
  const manifestPath = join(runtimeRoot, ".hush-runtime-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(Number(process.versions.node.split(".", 1)[0]), 24);
  assert.equal(realpathSync(launcherPath), join(realpathSync(binDir), "hush"));
  assert.equal(lstatSync(launcherPath).isSymbolicLink(), false);
  assert.ok((lstatSync(launcherPath).mode & 0o111) !== 0);
  assert.match(launcher, new RegExp(`exec '${realpathSync(process.execPath).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
  assert.match(launcher, new RegExp(`${join(runtimeRoot, "hush-cli", "bin", "hush.js").replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(launcher, /\/src\/ch5\/hush(?:\/|$)/);
  assert.doesNotMatch(launcher, /\bbun\b/);
  assert.ok(readFileSync(join(runtimeRoot, "hush-cli", "dist", "cli.js"), "utf8").length > 0);
  assert.equal(manifest.version, 2);
  assert.match(manifest.source.tracked.commit, /^[0-9a-f]{40}$/);
  assert.match(manifest.source.tracked.tree, /^[0-9a-f]{40}$/);
  assert.match(manifest.source.build.sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.source.dependencies.sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.files.some((entry) => entry.path === "hush-cli/dist" && entry.type === "directory"));
  assert.ok(manifest.files.some((entry) => entry.path === "hush-cli/dist/cli.js" && entry.sha256));
  assert.equal(lstatSync(manifestPath).mode & 0o777, 0o444);
  assert.equal(existsSync(oldRuntime), false);
  assert.equal(existsSync(retainedRuntime), true);

  const version = spawnSync(launcherPath, ["--version"], { cwd: neutralCwd, env, encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/);
  const preloadMarker = join(binDir, "preload-ran");
  const preload = join(binDir, "ambient-preload.cjs");
  writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "ran");\n`);
  const isolatedVersion = spawnSync(launcherPath, ["--version"], {
    cwd: neutralCwd,
    env: {
      ...env,
      NODE_OPTIONS: `--require ${preload}`,
      NODE_PATH: join(root, "node_modules"),
    },
    encoding: "utf8",
  });
  assert.equal(isolatedVersion.status, 0, isolatedVersion.stderr);
  assert.equal(existsSync(preloadMarker), false);

  const check = runInstaller(["--check"]);
  assert.equal(check.status, 0, check.stderr);
  const reuse = runInstaller();
  assert.equal(reuse.status, 0, reuse.stderr);

  const outsideRuntimeRoot = join(fixtureBase, "outside-runtime-root");
  const runtimeRootLink = join(fixtureBase, "runtime-root-link");
  const safeBinRoot = join(fixtureBase, "safe-bin-root");
  mkdirSync(outsideRuntimeRoot);
  mkdirSync(safeBinRoot);
  symlinkSync(outsideRuntimeRoot, runtimeRootLink, "dir");
  const escapedRuntimeName = "d".repeat(40);
  const linkedRuntimeInstall = runInstaller([], {
    HUSH_INSTALL_RUNTIME_ROOT: join(runtimeRootLink, escapedRuntimeName),
    HUSH_INSTALL_BIN_DIR: safeBinRoot,
  });
  assert.notEqual(linkedRuntimeInstall.status, 0);
  assert.match(linkedRuntimeInstall.stderr, /Hush runtime parent must (?:not traverse symlinked ancestors|be a real directory)/);
  assert.equal(existsSync(join(outsideRuntimeRoot, escapedRuntimeName)), false);

  const outsideBinRoot = join(fixtureBase, "outside-bin-root");
  const binRootLink = join(fixtureBase, "bin-root-link");
  mkdirSync(outsideBinRoot);
  symlinkSync(outsideBinRoot, binRootLink, "dir");
  const linkedBinInstall = runInstaller([], {
    HUSH_INSTALL_RUNTIME_ROOT: runtimeRoot,
    HUSH_INSTALL_BIN_DIR: binRootLink,
  });
  assert.notEqual(linkedBinInstall.status, 0);
  assert.match(linkedBinInstall.stderr, /Hush bin root must (?:not traverse symlinks|be a real directory)/);
  assert.equal(existsSync(join(outsideBinRoot, "hush")), false);

  const installedRuntimeLink = join(fixtureBase, "installed-runtime-link");
  symlinkSync(runtimeRoot, installedRuntimeLink, "dir");
  const linkedRuntimeCheck = runInstaller(["--check"], {
    HUSH_INSTALL_RUNTIME_ROOT: installedRuntimeLink,
  });
  assert.notEqual(linkedRuntimeCheck.status, 0);
  assert.match(linkedRuntimeCheck.stderr, /Hush runtime root must (?:not traverse symlinks|be a real directory)/);

  const runtimeCliPath = join(runtimeRoot, "hush-cli", "dist", "cli.js");
  const runtimeCli = readFileSync(runtimeCliPath);
  const runtimeCliMode = lstatSync(runtimeCliPath).mode & 0o777;
  writeFileSync(runtimeCliPath, Buffer.concat([runtimeCli, Buffer.from("\n")]));
  const runtimeHashDrift = runInstaller(["--check"]);
  assert.notEqual(runtimeHashDrift.status, 0);
  assert.match(runtimeHashDrift.stderr, /Hush runtime manifest drift: changed hush-cli\/dist\/cli\.js/);
  writeFileSync(runtimeCliPath, runtimeCli, { mode: runtimeCliMode });

  chmodSync(runtimeCliPath, runtimeCliMode ^ 0o100);
  const runtimeModeDrift = runInstaller(["--check"]);
  assert.notEqual(runtimeModeDrift.status, 0);
  assert.match(runtimeModeDrift.stderr, /Hush runtime manifest drift: changed hush-cli\/dist\/cli\.js/);
  chmodSync(runtimeCliPath, runtimeCliMode);

  const runtimeDistPath = join(runtimeRoot, "hush-cli", "dist");
  const runtimeDistMode = lstatSync(runtimeDistPath).mode & 0o777;
  chmodSync(runtimeDistPath, runtimeDistMode ^ 0o1000);
  const runtimeDirectoryModeDrift = runInstaller(["--check"]);
  assert.notEqual(runtimeDirectoryModeDrift.status, 0);
  assert.match(runtimeDirectoryModeDrift.stderr, /Hush runtime manifest drift: changed hush-cli\/dist/);
  chmodSync(runtimeDistPath, runtimeDistMode);

  const manifestText = readFileSync(manifestPath, "utf8");
  const driftedManifest = JSON.parse(manifestText);
  driftedManifest.source.build.sha256 = "0".repeat(64);
  chmodSync(manifestPath, 0o644);
  writeFileSync(manifestPath, `${JSON.stringify(driftedManifest, null, 2)}\n`);
  chmodSync(manifestPath, 0o444);
  const sourceDrift = runInstaller(["--check"]);
  assert.notEqual(sourceDrift.status, 0);
  assert.match(sourceDrift.stderr, /Hush runtime source identity drift/);
  chmodSync(manifestPath, 0o644);
  writeFileSync(manifestPath, manifestText);
  chmodSync(manifestPath, 0o444);

  chmodSync(manifestPath, 0o644);
  const manifestModeDrift = runInstaller(["--check"]);
  assert.notEqual(manifestModeDrift.status, 0);
  assert.match(manifestModeDrift.stderr, /Hush runtime manifest mode drift/);
  chmodSync(manifestPath, 0o444);

  const manifestCopy = join(runtimeRoot, ".hush-runtime-manifest-copy.json");
  renameSync(manifestPath, manifestCopy);
  const missingManifest = runInstaller(["--check"]);
  assert.notEqual(missingManifest.status, 0);
  assert.match(missingManifest.stderr, /Hush runtime manifest missing/);
  renameSync(manifestCopy, manifestPath);

  renameSync(manifestPath, manifestCopy);
  symlinkSync(manifestCopy, manifestPath);
  const linkedManifest = runInstaller(["--check"]);
  assert.notEqual(linkedManifest.status, 0);
  assert.match(linkedManifest.stderr, /Hush runtime manifest must be a regular file/);
  rmSync(manifestPath);
  renameSync(manifestCopy, manifestPath);

  chmodSync(launcherPath, 0o644);
  const launcherModeDrift = runInstaller(["--check"]);
  assert.notEqual(launcherModeDrift.status, 0);
  assert.match(launcherModeDrift.stderr, /Hush launcher is not executable/);
  chmodSync(launcherPath, 0o755);

  const launcherCopy = join(binDir, "hush-real");
  renameSync(launcherPath, launcherCopy);
  symlinkSync(launcherCopy, launcherPath);
  const linkedLauncher = runInstaller(["--check"]);
  assert.notEqual(linkedLauncher.status, 0);
  assert.match(linkedLauncher.stderr, /Hush launcher must be a regular non-symlink file/);
  rmSync(launcherPath);
  renameSync(launcherCopy, launcherPath);

  writeFileSync(launcherPath, `${launcher}\n`);
  const launcherDrift = runInstaller(["--check"]);
  assert.notEqual(launcherDrift.status, 0);
  assert.match(launcherDrift.stderr, /Hush launcher drift/);
  writeFileSync(launcherPath, launcher, { mode: 0o755 });

  const runtimeDependencyPackage = join(runtimeRoot, "hush-cli", "node_modules", "picocolors", "package.json");
  const runtimeDependencyPackageText = readFileSync(runtimeDependencyPackage);
  writeFileSync(runtimeDependencyPackage, Buffer.concat([runtimeDependencyPackageText, Buffer.from("\n")]));
  const dependencyTamper = runInstaller(["--check"]);
  assert.notEqual(dependencyTamper.status, 0);
  assert.match(dependencyTamper.stderr, /Hush runtime manifest drift: changed hush-cli\/node_modules\/picocolors/);
  writeFileSync(runtimeDependencyPackage, runtimeDependencyPackageText);

  const unexpectedRuntimeFile = join(runtimeRoot, "hush-cli", "node_modules", "tampered.js");
  writeFileSync(unexpectedRuntimeFile, "tampered\n");
  const unexpectedFile = runInstaller(["--check"]);
  assert.notEqual(unexpectedFile.status, 0);
  assert.match(unexpectedFile.stderr, /Hush runtime manifest drift: unexpected hush-cli\/node_modules\/tampered\.js/);
  rmSync(unexpectedRuntimeFile);

  const runtimeDependency = join(runtimeRoot, "hush-cli", "node_modules", "picocolors");
  const runtimeDependencyCopy = join(runtimeRoot, "picocolors-copy");
  renameSync(runtimeDependency, runtimeDependencyCopy);
  symlinkSync(realpathSync(join(root, "hush-cli", "node_modules", "picocolors")), runtimeDependency, "dir");
  const externalLink = runInstaller(["--check"]);
  assert.notEqual(externalLink.status, 0);
  assert.match(externalLink.stderr, /Hush runtime symlink escapes runtime/);
  rmSync(runtimeDependency);
  renameSync(runtimeDependencyCopy, runtimeDependency);

  const shellFailure = join(binDir, "shell-failure");
  writeFileSync(shellFailure, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
  chmodSync(shellFailure, 0o755);
  const failedResolution = runInstaller(["--check"], {
    HUSH_INSTALL_SKIP_SHADOW_CHECK: "0",
    SHELL: shellFailure,
  });
  assert.notEqual(failedResolution.status, 0);
  assert.match(failedResolution.stderr, /login shell resolution failed/);

  const shellNoResolution = join(binDir, "shell-no-resolution");
  writeFileSync(shellNoResolution, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(shellNoResolution, 0o755);
  const noResolution = runInstaller(["--check"], {
    HUSH_INSTALL_SKIP_SHADOW_CHECK: "0",
    SHELL: shellNoResolution,
  });
  assert.notEqual(noResolution.status, 0);
  assert.match(noResolution.stderr, /resolves no hush at all/);
} finally {
  rmSync(binDir, { recursive: true, force: true });
}

console.log("local install verified");
