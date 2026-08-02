import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNode24 } from "../../scripts/install-local-helpers.mjs";
import {
  assertInstallerPrerequisites,
  createRuntimeManifest,
  sourceIdentity,
  validateRuntimeGraph,
} from "../../scripts/install-local.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "hush-local-install-")));
const installer = join(root, "scripts", "install-local.mjs");
const sourceCommit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
}).trim();
const stageMarkerName = ".hush-stage-owner";
const swappedAncestorError = /(?:path changed during install|directory is missing, symlinked, or not a directory)/i;
const installBin = join(sandbox, "bin");
const runtimeBase = join(sandbox, "runtimes");
const runtimeRoot = join(runtimeBase, sourceCommit);
const oldRuntime = join(runtimeBase, "a".repeat(40));
const retainedRuntime = join(runtimeBase, "b".repeat(40));
const emptyStaleStage = join(runtimeBase, ".hush-stage-crashed-empty");
const neutralCwd = join(sandbox, "neutral-cwd");
const fixtureBase = join(sandbox, "fixtures");
const env = {
  ...process.env,
  HUSH_INSTALL_BIN_DIR: installBin,
  HUSH_INSTALL_RUNTIME_ROOT: runtimeRoot,
  HUSH_INSTALL_SKIP_SHADOW_CHECK: "1",
  HUSH_NO_UPDATE_CHECK: "1",
  NODE_PATH: "",
};
const pausedInstallers = new Set();

function childEnv(base, overrides = {}) {
  const result = { ...base, ...overrides };
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined || value === null) delete result[key];
  }
  return result;
}

function runInstaller(args = [], overrides = {}, base = env, installerPath = installer) {
  return spawnSync(process.execPath, [installerPath, ...args], {
    cwd: neutralCwd,
    env: childEnv(base, overrides),
    encoding: "utf8",
  });
}

function spawnInstaller(args = [], overrides = {}, base = env, installerPath = installer) {
  const child = spawn(process.execPath, [installerPath, ...args], {
    cwd: neutralCwd,
    env: childEnv(base, overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    done: new Promise((resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => resolveResult({ status, signal, stdout, stderr }));
    }),
  };
}

async function waitForFile(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

async function startPausedInstaller(point, overrides = {}, base = env, installerPath = installer) {
  const pauseRoot = join(fixtureBase, `pause-${point}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(pauseRoot, { recursive: true });
  const marker = join(pauseRoot, "marker");
  const release = join(pauseRoot, "release");
  const running = spawnInstaller([], {
    ...overrides,
    HUSH_INSTALL_TEST_PAUSE_AT: point,
    HUSH_INSTALL_TEST_PAUSE_MARKER: marker,
    HUSH_INSTALL_TEST_PAUSE_RELEASE: release,
  }, base, installerPath);
  const paused = {
    ...running,
    marker,
    release,
    internalPid: undefined,
  };
  pausedInstallers.add(paused);
  paused.done.then(
    () => pausedInstallers.delete(paused),
    () => pausedInstallers.delete(paused),
  );
  await waitForFile(marker);
  paused.internalPid = Number(readFileSync(marker, "utf8").trim());
  return paused;
}

function releasePausedInstaller(paused) {
  if (!existsSync(paused.release)) writeFileSync(paused.release, "continue\n", { flag: "wx" });
}

function killIfRunning(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function reapPausedInstaller(paused) {
  killIfRunning(paused.internalPid, "SIGTERM");
  releasePausedInstaller(paused);
  const wait = (milliseconds) => new Promise(
    (resolveTimeout) => setTimeout(() => resolveTimeout(undefined), milliseconds),
  );
  let result = await Promise.race([paused.done, wait(1_000)]);
  if (!result) {
    killIfRunning(paused.child.pid, "SIGTERM");
    result = await Promise.race([paused.done, wait(1_000)]);
  }
  if (!result) {
    killIfRunning(paused.internalPid, "SIGKILL");
    killIfRunning(paused.child.pid, "SIGKILL");
    result = await paused.done;
  }
  return result;
}

async function cleanupPausedInstallers() {
  await Promise.all([...pausedInstallers].map((paused) => reapPausedInstaller(paused)));
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

function writePrunableRuntime(path) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".hush-runtime-manifest.json"), "{}\n", { mode: 0o444 });
  chmodSync(join(path, ".hush-runtime-manifest.json"), 0o444);
}

function writeStageMarker(path) {
  const metadata = lstatSync(path, { bigint: true });
  writeFileSync(
    join(path, stageMarkerName),
    `hush-stage-v2\t${metadata.dev}\t${metadata.ino}\n`,
    { mode: 0o400 },
  );
}

function writeEmptyPruneArtifact(parent) {
  const temporary = join(parent, ".empty-prune-source");
  mkdirSync(temporary);
  const metadata = lstatSync(temporary, { bigint: true });
  const target = join(
    parent,
    `.hush-prune-${metadata.dev.toString(16)}-${metadata.ino.toString(16)}-crashed-empty`,
  );
  renameSync(temporary, target);
  return target;
}

function writeInstallerSourceFixture(name) {
  const fixtureRoot = join(fixtureBase, name);
  const copiedFiles = [
    ".npmrc",
    "bun.lock",
    "docs/package.json",
    "hush-cli/bin/hush.js",
    "hush-cli/package.json",
    "hush-cli/schema.json",
    "package.json",
    "scripts/install-local-helpers.mjs",
    "scripts/install-local-native.c",
    "scripts/install-local.mjs",
  ];
  for (const path of copiedFiles) {
    const destination = join(fixtureRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(join(root, path)));
  }
  mkdirSync(join(fixtureRoot, "hush-cli", "dist"), { recursive: true });
  writeFileSync(join(fixtureRoot, "hush-cli", "dist", "cli.js"), "export default true;\n");

  const git = (...args) => {
    const result = spawnSync("/usr/bin/git", args, { cwd: fixtureRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q");
  git("config", "user.name", "Hush Installer Test");
  git("config", "user.email", "hush-installer-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-qm", "test fixture");
  return {
    root: fixtureRoot,
    installer: join(fixtureRoot, "scripts", "install-local.mjs"),
    commit: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    }).trim(),
  };
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
  const rebuilt = sourceIdentity(sourceRoot);
  assert.deepEqual(rebuilt.tracked, original.tracked);
  assert.notEqual(rebuilt.build.sha256, original.build.sha256);
  assert.deepEqual(rebuilt.dependencies, original.dependencies);

  const hardlinkAlias = join(fixtureBase, "source-input-hardlink");
  linkSync(join(sourceRoot, ".npmrc"), hardlinkAlias);
  assert.doesNotThrow(() => sourceIdentity(sourceRoot));
  rmSync(hardlinkAlias);

  const outsideInput = join(fixtureBase, "outside-input");
  writeFileSync(outsideInput, "outside\n");
  rmSync(join(sourceRoot, ".npmrc"));
  symlinkSync(outsideInput, join(sourceRoot, ".npmrc"));
  assert.throws(
    () => sourceIdentity(sourceRoot),
    /Hush runtime input symlink is forbidden/,
  );
  rmSync(join(sourceRoot, ".npmrc"));
  writeFileSync(join(sourceRoot, ".npmrc"), "registry=https://example.invalid/\n");

  const binPath = join(sourceRoot, "hush-cli", "bin");
  const originalBinPath = join(sourceRoot, "hush-cli", "bin-original");
  const outsideBinPath = join(fixtureBase, "outside-bin-ancestor");
  renameSync(binPath, originalBinPath);
  mkdirSync(outsideBinPath);
  writeFileSync(join(outsideBinPath, "hush.js"), "");
  symlinkSync(outsideBinPath, binPath, "dir");
  assert.throws(
    () => sourceIdentity(sourceRoot),
    /Hush runtime input symlink is forbidden/,
  );
  rmSync(binPath);
  renameSync(originalBinPath, binPath);

  renameSync(binPath, originalBinPath);
  writeFileSync(binPath, "not a directory\n");
  assert.throws(
    () => sourceIdentity(sourceRoot),
    /Hush runtime input ancestor must be a directory/,
  );
  rmSync(binPath);
  renameSync(originalBinPath, binPath);
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

  const hardlinkAlias = join(internalRoot, "hardlink-alias.js");
  linkSync(join(internalPackage, "index.js"), hardlinkAlias);
  assert.throws(
    () => validateRuntimeGraph(internalRoot),
    /Hush runtime hardlink is forbidden/,
  );
  rmSync(hardlinkAlias);

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

function swapDirectory(path, outsidePath) {
  const movedPath = `${path}-original`;
  renameSync(path, movedPath);
  mkdirSync(outsidePath, { recursive: true });
  symlinkSync(outsidePath, path, "dir");
  return () => {
    rmSync(path);
    renameSync(movedPath, path);
  };
}

function assertOutsideEmpty(path) {
  assert.deepEqual(readdirSync(path), []);
}

function caseFoldAlias(path) {
  const canonical = realpathSync(path);
  for (let index = path.length - 1; index >= 0; index--) {
    const character = path[index];
    if (!/[A-Za-z]/.test(character)) continue;
    const replacement = character === character.toLowerCase()
      ? character.toUpperCase()
      : character.toLowerCase();
    const candidate = `${path.slice(0, index)}${replacement}${path.slice(index + 1)}`;
    try {
      if (candidate !== path && realpathSync(candidate) === canonical) return candidate;
    } catch {
      // Case-sensitive filesystems have no physical alias at this spelling.
    }
  }
  return undefined;
}

async function main() {
  mkdirSync(neutralCwd);
  mkdirSync(fixtureBase);
  writePrunableRuntime(oldRuntime);
  writePrunableRuntime(retainedRuntime);
  mkdirSync(emptyStaleStage);
  const emptyStalePrune = writeEmptyPruneArtifact(runtimeBase);
  utimesSync(oldRuntime, 1, 1);
  utimesSync(retainedRuntime, 2, 2);
  assert.throws(() => assertNode24("23.11.0"), /requires Node 24/);
  assert.doesNotThrow(() => assertNode24(process.version));
  assert.throws(
    () => assertInstallerPrerequisites({
      platform: "win32",
      nodeVersion: process.version,
      pathExists: () => true,
    }),
    (error) => error.code === "HUSH_INSTALL_UNSUPPORTED_PLATFORM",
  );
  assert.throws(
    () => assertInstallerPrerequisites({
      platform: "darwin",
      nodeVersion: process.version,
      pathExists: (path) => path !== "/usr/bin/cc",
    }),
    (error) => error.code === "HUSH_INSTALL_MISSING_PREREQUISITE",
  );
  assert.doesNotThrow(() => assertInstallerPrerequisites());
  assertSourceProvenance();
  assertRuntimeFixtures();

  const checkOnlyRuntimeParent = join(sandbox, "check-only-runtime-parent");
  const checkOnlyBin = join(sandbox, "check-only-bin");
  const missingCheck = runInstaller(["--check"], {
    HUSH_INSTALL_RUNTIME_ROOT: join(checkOnlyRuntimeParent, sourceCommit),
    HUSH_INSTALL_BIN_DIR: checkOnlyBin,
  });
  assert.notEqual(missingCheck.status, 0);
  assert.equal(existsSync(checkOnlyRuntimeParent), false);
  assert.equal(existsSync(checkOnlyBin), false);

  const unguardedInternal = runInstaller(
    ["--internal-finalize-stage", "e30"],
    {
      HUSH_INSTALL_NATIVE_GUARDED: undefined,
      HUSH_INSTALL_NATIVE_HELPER: undefined,
    },
  );
  assert.notEqual(unguardedInternal.status, 0);
  assert.match(unguardedInternal.stderr, /requires the native install guard/);
  assert.equal(existsSync(join(neutralCwd, ".hush-runtime-manifest.json")), false);

  mkdirSync(join(runtimeRoot, "hush-cli", "bin"), { recursive: true });
  writeFileSync(join(runtimeRoot, "hush-cli", "bin", "hush.js"), "");
  const incomplete = runInstaller();
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /Hush runtime incomplete/);
  rmSync(runtimeRoot, { recursive: true, force: true });

  const sourceHardlink = join(sandbox, "source-npmrc-hardlink");
  linkSync(join(root, ".npmrc"), sourceHardlink);
  const poisonedTools = join(fixtureBase, "poisoned-tools");
  const poisonedToolMarker = join(fixtureBase, "poisoned-tool-ran");
  mkdirSync(poisonedTools);
  for (const tool of ["bun", "git"]) {
    writeFileSync(
      join(poisonedTools, tool),
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(tool)} >> ${JSON.stringify(poisonedToolMarker)}\nexit 99\n`,
      { mode: 0o755 },
    );
  }
  const install = runInstaller([], {
    PATH: `${poisonedTools}:${env.PATH}`,
    GIT_DIR: join(fixtureBase, "poisoned-git-dir"),
    GIT_WORK_TREE: join(fixtureBase, "poisoned-git-work-tree"),
  });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(existsSync(poisonedToolMarker), false);
  assert.equal(lstatSync(join(root, ".npmrc")).nlink >= 2, true);
  assert.equal(lstatSync(join(runtimeRoot, ".npmrc")).nlink, 1);
  assert.notEqual(statSync(join(root, ".npmrc")).ino, statSync(join(runtimeRoot, ".npmrc")).ino);
  rmSync(sourceHardlink);

  const racedSource = writeInstallerSourceFixture("source-ancestor-race");
  const racedSourceRuntimeParent = join(sandbox, "source-ancestor-race-runtimes");
  const racedSourceBin = join(sandbox, "source-ancestor-race-bin");
  const racedSourceOutside = join(sandbox, "source-ancestor-race-outside");
  const racedSourceOriginal = join(racedSource.root, "hush-cli", "bin-original");
  const racedSourceInstaller = await startPausedInstaller(
    "before-stage",
    {
      HUSH_INSTALL_RUNTIME_ROOT: join(racedSourceRuntimeParent, racedSource.commit),
      HUSH_INSTALL_BIN_DIR: racedSourceBin,
      HUSH_INSTALL_SKIP_SHADOW_CHECK: "1",
      HUSH_NO_UPDATE_CHECK: "1",
      NODE_PATH: "",
    },
    process.env,
    racedSource.installer,
  );
  renameSync(join(racedSource.root, "hush-cli", "bin"), racedSourceOriginal);
  mkdirSync(racedSourceOutside);
  symlinkSync(racedSourceOutside, join(racedSource.root, "hush-cli", "bin"), "dir");
  releasePausedInstaller(racedSourceInstaller);
  const racedSourceResult = await racedSourceInstaller.done;
  assert.notEqual(racedSourceResult.status, 0);
  assert.match(
    racedSourceResult.stderr,
    /source input ancestor is symlinked or not a directory|directory is missing, symlinked, or not a directory/,
  );
  assertOutsideEmpty(racedSourceOutside);
  assert.equal(
    readdirSync(racedSourceRuntimeParent).some((name) => name.startsWith(".hush-stage-")),
    false,
  );

  const launcherPath = join(installBin, "hush");
  const launcher = readFileSync(launcherPath, "utf8");
  const manifestPath = join(runtimeRoot, ".hush-runtime-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(Number(process.versions.node.split(".", 1)[0]), 24);
  assert.equal(realpathSync(launcherPath), join(realpathSync(installBin), "hush"));
  assert.equal(lstatSync(launcherPath).isSymbolicLink(), false);
  assert.equal(lstatSync(launcherPath).nlink, 1);
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
  assert.ok(manifest.files.some((entry) => entry.path === stageMarkerName && entry.type === "file"));
  assert.ok(manifest.files.some((entry) => entry.path === "hush-cli/dist" && entry.type === "directory"));
  assert.ok(manifest.files.some((entry) => entry.path === "hush-cli/dist/cli.js" && entry.sha256));
  assert.equal(lstatSync(manifestPath).mode & 0o777, 0o444);
  assert.equal(lstatSync(manifestPath).nlink, 1);
  assert.equal(existsSync(oldRuntime), false);
  assert.equal(existsSync(retainedRuntime), true);
  assert.equal(existsSync(emptyStaleStage), false);
  assert.equal(existsSync(emptyStalePrune), false);

  const unownedStaleStage = join(runtimeBase, ".hush-stage-missing-marker");
  mkdirSync(unownedStaleStage);
  writeFileSync(join(unownedStaleStage, "unowned"), "must not be removed\n");
  const unownedStale = runInstaller();
  assert.notEqual(unownedStale.status, 0);
  assert.match(unownedStale.stderr, /managed directory marker is missing/);
  assert.equal(readFileSync(join(unownedStaleStage, "unowned"), "utf8"), "must not be removed\n");
  rmSync(unownedStaleStage, { recursive: true });

  const checkPreservedStage = join(runtimeBase, ".hush-stage-check-preserved");
  mkdirSync(checkPreservedStage);
  writeStageMarker(checkPreservedStage);
  const staleCheck = runInstaller(["--check"]);
  assert.notEqual(staleCheck.status, 0);
  assert.match(staleCheck.stderr, /stale unpublished artifacts/);
  assert.equal(existsSync(checkPreservedStage), true);
  const staleRecovery = runInstaller();
  assert.equal(staleRecovery.status, 0, staleRecovery.stderr);
  assert.equal(existsSync(checkPreservedStage), false);

  const version = spawnSync(launcherPath, ["--version"], { cwd: neutralCwd, env, encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/);
  const preloadMarker = join(sandbox, "preload-ran");
  const preload = join(sandbox, "ambient-preload.cjs");
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

  const sourceRootInstall = runInstaller([], { HUSH_INSTALL_RUNTIME_ROOT: root });
  assert.notEqual(sourceRootInstall.status, 0);
  assert.match(sourceRootInstall.stderr, /must not overlap the mutable source checkout/);
  assert.equal(readFileSync(launcherPath, "utf8"), launcher);

  const nonCommitRuntimeInstall = runInstaller([], {
    HUSH_INSTALL_RUNTIME_ROOT: join(fixtureBase, "managed-runtime", "c".repeat(40)),
  });
  assert.notEqual(nonCommitRuntimeInstall.status, 0);
  assert.match(nonCommitRuntimeInstall.stderr, /must end with the source commit/);
  assert.equal(readFileSync(launcherPath, "utf8"), launcher);

  const nestedSourceRuntime = join(root, ".hush-test-runtime", sourceCommit);
  const nestedSourceRuntimeInstall = runInstaller([], {
    HUSH_INSTALL_RUNTIME_ROOT: nestedSourceRuntime,
  });
  assert.notEqual(nestedSourceRuntimeInstall.status, 0);
  assert.match(nestedSourceRuntimeInstall.stderr, /must not overlap the mutable source checkout/);
  assert.equal(existsSync(join(root, ".hush-test-runtime")), false);

  const caseAliasSource = writeInstallerSourceFixture("case-fold-source");
  const sourceAlias = caseFoldAlias(caseAliasSource.root);
  if (sourceAlias) {
    const physicalOverlapRuntimeParent = join(sandbox, "case-fold-runtime-parent");
    const physicalRuntimeOverlap = runInstaller([], {
      HUSH_INSTALL_RUNTIME_ROOT: join(sourceAlias, caseAliasSource.commit),
      HUSH_INSTALL_BIN_DIR: join(sandbox, "case-fold-runtime-bin"),
      HUSH_INSTALL_SKIP_SHADOW_CHECK: "1",
    }, process.env, caseAliasSource.installer);
    assert.notEqual(physicalRuntimeOverlap.status, 0);
    assert.match(physicalRuntimeOverlap.stderr, /HUSH_INSTALL_ROOT_OVERLAP/);
    assert.equal(existsSync(join(caseAliasSource.root, caseAliasSource.commit)), false);

    mkdirSync(physicalOverlapRuntimeParent);
    const runtimeParentAlias = caseFoldAlias(physicalOverlapRuntimeParent);
    assert.ok(runtimeParentAlias);
    const physicalBinOverlap = runInstaller([], {
      HUSH_INSTALL_RUNTIME_ROOT: join(physicalOverlapRuntimeParent, caseAliasSource.commit),
      HUSH_INSTALL_BIN_DIR: runtimeParentAlias,
      HUSH_INSTALL_SKIP_SHADOW_CHECK: "1",
    }, process.env, caseAliasSource.installer);
    assert.notEqual(physicalBinOverlap.status, 0);
    assert.match(physicalBinOverlap.stderr, /HUSH_INSTALL_ROOT_OVERLAP/);
  }

  const sourceBinInstall = runInstaller([], {
    HUSH_INSTALL_BIN_DIR: join(root, ".hush-test-bin"),
  });
  assert.notEqual(sourceBinInstall.status, 0);
  assert.match(sourceBinInstall.stderr, /bin root must not overlap the mutable source checkout/);
  assert.equal(existsSync(join(root, ".hush-test-bin")), false);

  const runtimeBinInstall = runInstaller([], {
    HUSH_INSTALL_BIN_DIR: runtimeBase,
  });
  assert.notEqual(runtimeBinInstall.status, 0);
  assert.match(runtimeBinInstall.stderr, /bin root must not overlap the managed runtime/);
  assert.equal(readFileSync(launcherPath, "utf8"), launcher);

  const reservedRuntimeInstall = runInstaller([], {
    HUSH_INSTALL_RUNTIME_ROOT: join(runtimeBase, ".hush-stage-explicit"),
  });
  assert.notEqual(reservedRuntimeInstall.status, 0);
  assert.match(reservedRuntimeInstall.stderr, /reserved managed name/);
  assert.equal(readFileSync(launcherPath, "utf8"), launcher);

  const outsideRuntimeRoot = join(fixtureBase, "outside-runtime-root");
  const runtimeRootLink = join(fixtureBase, "runtime-root-link");
  const safeBinRoot = join(fixtureBase, "safe-bin-root");
  mkdirSync(outsideRuntimeRoot);
  mkdirSync(safeBinRoot);
  symlinkSync(outsideRuntimeRoot, runtimeRootLink, "dir");
  const linkedRuntimeInstall = runInstaller([], {
    HUSH_INSTALL_RUNTIME_ROOT: join(runtimeRootLink, sourceCommit),
    HUSH_INSTALL_BIN_DIR: safeBinRoot,
  });
  assert.notEqual(linkedRuntimeInstall.status, 0);
  assert.match(linkedRuntimeInstall.stderr, /missing, symlinked, or not a directory/);
  assert.equal(existsSync(join(outsideRuntimeRoot, sourceCommit)), false);

  const outsideBinRoot = join(fixtureBase, "outside-bin-root");
  const binRootLink = join(fixtureBase, "bin-root-link");
  mkdirSync(outsideBinRoot);
  symlinkSync(outsideBinRoot, binRootLink, "dir");
  const linkedBinInstall = runInstaller([], {
    HUSH_INSTALL_RUNTIME_ROOT: runtimeRoot,
    HUSH_INSTALL_BIN_DIR: binRootLink,
  });
  assert.notEqual(linkedBinInstall.status, 0);
  assert.match(linkedBinInstall.stderr, /missing, symlinked, or not a directory/);
  assert.equal(existsSync(join(outsideBinRoot, "hush")), false);

  const installedRuntimeLinkParent = join(fixtureBase, "installed-runtime-link-parent");
  const installedRuntimeLink = join(installedRuntimeLinkParent, sourceCommit);
  mkdirSync(installedRuntimeLinkParent);
  symlinkSync(runtimeRoot, installedRuntimeLink, "dir");
  const linkedRuntimeCheck = runInstaller(["--check"], {
    HUSH_INSTALL_RUNTIME_ROOT: installedRuntimeLink,
  });
  assert.notEqual(linkedRuntimeCheck.status, 0);
  assert.match(linkedRuntimeCheck.stderr, /managed runtime entry is symlinked or not a directory/);

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
  assert.match(linkedManifest.stderr, /manifest must be a single-link regular file/);
  rmSync(manifestPath);
  renameSync(manifestCopy, manifestPath);

  const manifestHardlink = join(sandbox, "manifest-hardlink");
  linkSync(manifestPath, manifestHardlink);
  const linkedManifestCheck = runInstaller(["--check"]);
  assert.notEqual(linkedManifestCheck.status, 0);
  assert.match(linkedManifestCheck.stderr, /manifest must be a single-link regular file/);
  rmSync(manifestHardlink);

  chmodSync(launcherPath, 0o644);
  const launcherModeDrift = runInstaller(["--check"]);
  assert.notEqual(launcherModeDrift.status, 0);
  assert.match(launcherModeDrift.stderr, /launcher is not executable/);
  chmodSync(launcherPath, 0o755);

  const launcherCopy = join(installBin, "hush-real");
  renameSync(launcherPath, launcherCopy);
  symlinkSync(launcherCopy, launcherPath);
  const linkedLauncher = runInstaller(["--check"]);
  assert.notEqual(linkedLauncher.status, 0);
  assert.match(linkedLauncher.stderr, /launcher is missing or symlinked/);
  rmSync(launcherPath);
  renameSync(launcherCopy, launcherPath);

  const launcherHardlink = join(sandbox, "launcher-hardlink");
  linkSync(launcherPath, launcherHardlink);
  const hardlinkedLauncherCheck = runInstaller(["--check"]);
  assert.notEqual(hardlinkedLauncherCheck.status, 0);
  assert.match(hardlinkedLauncherCheck.stderr, /launcher must be a single-link regular file/);
  rmSync(launcherHardlink);

  const victimLauncher = join(sandbox, "launcher-victim");
  writeFileSync(victimLauncher, "victim remains unchanged\n");
  rmSync(launcherPath);
  linkSync(victimLauncher, launcherPath);
  const replaceHardlinkedLauncher = runInstaller();
  assert.equal(replaceHardlinkedLauncher.status, 0, replaceHardlinkedLauncher.stderr);
  assert.equal(readFileSync(victimLauncher, "utf8"), "victim remains unchanged\n");
  assert.equal(readFileSync(launcherPath, "utf8"), launcher);
  assert.notEqual(statSync(victimLauncher).ino, statSync(launcherPath).ino);
  assert.equal(lstatSync(launcherPath).nlink, 1);

  writeFileSync(launcherPath, `${launcher}\n`);
  const launcherDrift = runInstaller(["--check"]);
  assert.notEqual(launcherDrift.status, 0);
  assert.match(launcherDrift.stderr, /Hush launcher drift/);
  writeFileSync(launcherPath, launcher, { mode: 0o755 });

  const runtimeHardlink = join(sandbox, "runtime-hardlink");
  linkSync(runtimeCliPath, runtimeHardlink);
  const hardlinkedRuntimeCheck = runInstaller(["--check"]);
  assert.notEqual(hardlinkedRuntimeCheck.status, 0);
  assert.match(hardlinkedRuntimeCheck.stderr, /Hush runtime hardlink is forbidden/);
  rmSync(runtimeHardlink);

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

  const shellFailure = join(sandbox, "shell-failure");
  writeFileSync(shellFailure, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
  chmodSync(shellFailure, 0o755);
  const failedResolution = runInstaller(["--check"], {
    HUSH_INSTALL_SKIP_SHADOW_CHECK: "0",
    SHELL: shellFailure,
  });
  assert.notEqual(failedResolution.status, 0);
  assert.match(failedResolution.stderr, /login shell resolution failed/);

  const shellNoResolution = join(sandbox, "shell-no-resolution");
  writeFileSync(shellNoResolution, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(shellNoResolution, 0o755);
  const noResolution = runInstaller(["--check"], {
    HUSH_INSTALL_SKIP_SHADOW_CHECK: "0",
    SHELL: shellNoResolution,
  });
  assert.notEqual(noResolution.status, 0);
  assert.match(noResolution.stderr, /resolves no hush at all/);

  const noEnvHome = join(sandbox, "no-env-home");
  const noEnvBin = join(noEnvHome, ".local", "bin");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const noEnvRuntime = join(noEnvHome, ".local", "state", "hush", "runtimes", commit);
  mkdirSync(noEnvHome);
  const bunPath = execFileSync("bun", ["-e", "console.log(process.execPath)"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const loginPath = [
    noEnvBin,
    dirname(bunPath),
    dirname(process.execPath),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  writeFileSync(join(noEnvHome, ".zprofile"), `export PATH=${JSON.stringify(loginPath)}\n`);
  const noEnvOverrides = {
    HOME: noEnvHome,
    PATH: loginPath,
    SHELL: "/bin/zsh",
    HUSH_INSTALL_BIN_DIR: undefined,
    HUSH_INSTALL_RUNTIME_ROOT: undefined,
    HUSH_INSTALL_SKIP_SHADOW_CHECK: undefined,
    NODE_OPTIONS: undefined,
    NODE_PATH: undefined,
  };
  const noEnvInstall = runInstaller([], noEnvOverrides, process.env);
  assert.equal(noEnvInstall.status, 0, noEnvInstall.stderr);
  assert.doesNotMatch(noEnvInstall.stderr, /SHADOWED INSTALL|not delivered/);
  const noEnvLauncher = join(noEnvBin, "hush");
  const noEnvLauncherText = readFileSync(noEnvLauncher, "utf8");
  const noEnvManifest = JSON.parse(readFileSync(join(noEnvRuntime, ".hush-runtime-manifest.json"), "utf8"));
  assert.match(noEnvLauncherText, new RegExp(noEnvRuntime.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(noEnvLauncherText.includes(root), false);
  assert.doesNotMatch(noEnvLauncherText, /\/src\/ch5\/hush(?:\/|$)/);
  assert.equal(noEnvManifest.source.tracked.commit, commit);
  const noEnvCheck = runInstaller(["--check"], noEnvOverrides, process.env);
  assert.equal(noEnvCheck.status, 0, noEnvCheck.stderr);
  assert.doesNotMatch(noEnvCheck.stderr, /SHADOWED INSTALL|not delivered/);
  const detachedConsumer = spawnSync("hush", ["--version"], {
    cwd: neutralCwd,
    env: {
      HOME: noEnvHome,
      PATH: `${noEnvBin}:/usr/bin:/bin`,
      HUSH_NO_UPDATE_CHECK: "1",
    },
    encoding: "utf8",
  });
  assert.equal(detachedConsumer.status, 0, detachedConsumer.stderr);
  assert.match(detachedConsumer.stdout, /^\d+\.\d+\.\d+\s*$/);
  const sourceCheckout = runInstaller(
    ["--source-checkout"],
    noEnvOverrides,
    process.env,
  );
  assert.equal(sourceCheckout.status, 0, sourceCheckout.stderr);
  assert.match(sourceCheckout.stdout, /hush-cli\/bin\/hush\.js/);
  assert.match(sourceCheckout.stderr, /managed launcher unchanged/);
  assert.equal(readFileSync(noEnvLauncher, "utf8"), noEnvLauncherText);

  const lockPause = await startPausedInstaller("after-lock");
  const lockedOut = runInstaller();
  assert.notEqual(lockedOut.status, 0);
  assert.match(lockedOut.stderr, /another Hush install is already in progress/);
  releasePausedInstaller(lockPause);
  const lockFinished = await lockPause.done;
  assert.equal(lockFinished.status, 0, lockFinished.stderr);

  const stageRaceParent = join(sandbox, "stage-race-runtimes");
  const stageRaceRoot = join(stageRaceParent, sourceCommit);
  const stageRaceBin = join(sandbox, "stage-race-bin");
  const stageRaceOutside = join(sandbox, "stage-race-outside");
  const stageRace = await startPausedInstaller("before-stage", {
    HUSH_INSTALL_RUNTIME_ROOT: stageRaceRoot,
    HUSH_INSTALL_BIN_DIR: stageRaceBin,
  });
  const restoreStageParent = swapDirectory(stageRaceParent, stageRaceOutside);
  releasePausedInstaller(stageRace);
  const stageRaceResult = await stageRace.done;
  assert.notEqual(stageRaceResult.status, 0);
  assert.match(stageRaceResult.stderr, swappedAncestorError);
  assertOutsideEmpty(stageRaceOutside);
  restoreStageParent();

  const publishRaceParent = join(sandbox, "publish-race-runtimes");
  const publishRaceRoot = join(publishRaceParent, sourceCommit);
  const publishRaceBin = join(sandbox, "publish-race-bin");
  const publishRaceOutside = join(sandbox, "publish-race-outside");
  const publishRace = await startPausedInstaller("before-runtime-publish", {
    HUSH_INSTALL_RUNTIME_ROOT: publishRaceRoot,
    HUSH_INSTALL_BIN_DIR: publishRaceBin,
  });
  const restorePublishParent = swapDirectory(publishRaceParent, publishRaceOutside);
  releasePausedInstaller(publishRace);
  const publishRaceResult = await publishRace.done;
  assert.notEqual(publishRaceResult.status, 0);
  assert.match(publishRaceResult.stderr, swappedAncestorError);
  assertOutsideEmpty(publishRaceOutside);
  restorePublishParent();
  assert.equal(existsSync(publishRaceRoot), false);
  const recoveredPublish = runInstaller([], {
    HUSH_INSTALL_RUNTIME_ROOT: publishRaceRoot,
    HUSH_INSTALL_BIN_DIR: publishRaceBin,
  });
  assert.equal(recoveredPublish.status, 0, recoveredPublish.stderr);
  assert.equal(readdirSync(publishRaceParent).some((name) => name.startsWith(".hush-stage-")), false);

  const stageEntryRaceParent = join(sandbox, "stage-entry-race-runtimes");
  const stageEntryRaceRoot = join(stageEntryRaceParent, sourceCommit);
  const stageEntryRaceBin = join(sandbox, "stage-entry-race-bin");
  const stageEntryRace = await startPausedInstaller("before-runtime-publish", {
    HUSH_INSTALL_RUNTIME_ROOT: stageEntryRaceRoot,
    HUSH_INSTALL_BIN_DIR: stageEntryRaceBin,
  });
  const stageEntryName = readdirSync(stageEntryRaceParent).find((name) => name.startsWith(".hush-stage-"));
  assert.ok(stageEntryName);
  const stageEntryPath = join(stageEntryRaceParent, stageEntryName);
  const movedStageEntry = join(stageEntryRaceParent, ".moved-stage-entry");
  renameSync(stageEntryPath, movedStageEntry);
  mkdirSync(stageEntryPath);
  writeStageMarker(stageEntryPath);
  releasePausedInstaller(stageEntryRace);
  const stageEntryRaceResult = await stageEntryRace.done;
  assert.notEqual(stageEntryRaceResult.status, 0);
  assert.match(stageEntryRaceResult.stderr, /Hush stage changed during install/);
  assert.equal(existsSync(stageEntryRaceRoot), false);
  assert.equal(existsSync(movedStageEntry), true);
  rmSync(stageEntryPath, { recursive: true });
  renameSync(movedStageEntry, stageEntryPath);
  const recoveredStageEntry = runInstaller([], {
    HUSH_INSTALL_RUNTIME_ROOT: stageEntryRaceRoot,
    HUSH_INSTALL_BIN_DIR: stageEntryRaceBin,
  });
  assert.equal(recoveredStageEntry.status, 0, recoveredStageEntry.stderr);

  const launcherSwapOutside = join(sandbox, "launcher-swap-outside");
  writeFileSync(launcherSwapOutside, "outside launcher target\n");
  const launcherSwap = await startPausedInstaller("before-launcher-publish");
  rmSync(launcherPath);
  symlinkSync(launcherSwapOutside, launcherPath);
  releasePausedInstaller(launcherSwap);
  const launcherSwapResult = await launcherSwap.done;
  assert.equal(launcherSwapResult.status, 0, launcherSwapResult.stderr);
  assert.equal(readFileSync(launcherSwapOutside, "utf8"), "outside launcher target\n");
  assert.equal(lstatSync(launcherPath).isSymbolicLink(), false);
  assert.equal(readFileSync(launcherPath, "utf8"), launcher);

  const launcherRuntimeRaceOutside = join(sandbox, "launcher-runtime-race-outside");
  const launcherSentinel = "#!/bin/sh\nexit 99\n";
  writeFileSync(launcherPath, launcherSentinel, { mode: 0o755 });
  const launcherRuntimeRace = await startPausedInstaller("before-launcher-publish");
  const restoreLauncherRuntime = swapDirectory(runtimeBase, launcherRuntimeRaceOutside);
  releasePausedInstaller(launcherRuntimeRace);
  const launcherRuntimeRaceResult = await launcherRuntimeRace.done;
  assert.notEqual(launcherRuntimeRaceResult.status, 0);
  assert.match(launcherRuntimeRaceResult.stderr, swappedAncestorError);
  assertOutsideEmpty(launcherRuntimeRaceOutside);
  assert.equal(readFileSync(launcherPath, "utf8"), launcherSentinel);
  restoreLauncherRuntime();
  const repairedLauncher = runInstaller();
  assert.equal(repairedLauncher.status, 0, repairedLauncher.stderr);
  assert.equal(readFileSync(launcherPath, "utf8"), launcher);

  const launcherRaceOutside = join(sandbox, "launcher-race-outside");
  const launcherBeforeRace = readFileSync(launcherPath, "utf8");
  const launcherRace = await startPausedInstaller("before-launcher-publish");
  const restoreBin = swapDirectory(installBin, launcherRaceOutside);
  releasePausedInstaller(launcherRace);
  const launcherRaceResult = await launcherRace.done;
  assert.notEqual(launcherRaceResult.status, 0);
  assert.match(launcherRaceResult.stderr, swappedAncestorError);
  assertOutsideEmpty(launcherRaceOutside);
  restoreBin();
  assert.equal(readFileSync(launcherPath, "utf8"), launcherBeforeRace);

  const pruneEntryParent = join(sandbox, "prune-entry-runtimes");
  const pruneEntryRoot = join(pruneEntryParent, sourceCommit);
  const pruneEntryBin = join(sandbox, "prune-entry-bin");
  const pruneEntryOld = join(pruneEntryParent, "a".repeat(40));
  const pruneEntryRetained = join(pruneEntryParent, "b".repeat(40));
  mkdirSync(pruneEntryParent);
  writePrunableRuntime(pruneEntryOld);
  writePrunableRuntime(pruneEntryRetained);
  utimesSync(pruneEntryOld, 1, 1);
  utimesSync(pruneEntryRetained, 2, 2);
  const pruneEntryRace = await startPausedInstaller("before-prune", {
    HUSH_INSTALL_RUNTIME_ROOT: pruneEntryRoot,
    HUSH_INSTALL_BIN_DIR: pruneEntryBin,
  });
  const movedPruneEntry = join(pruneEntryParent, ".moved-prune-entry");
  renameSync(pruneEntryOld, movedPruneEntry);
  writePrunableRuntime(pruneEntryOld);
  releasePausedInstaller(pruneEntryRace);
  const pruneEntryRaceResult = await pruneEntryRace.done;
  assert.notEqual(pruneEntryRaceResult.status, 0);
  assert.match(pruneEntryRaceResult.stderr, /runtime selected for pruning changed during install/);
  assert.equal(existsSync(pruneEntryOld), true);
  assert.equal(existsSync(movedPruneEntry), true);
  rmSync(pruneEntryOld, { recursive: true });
  renameSync(movedPruneEntry, pruneEntryOld);
  const recoveredPruneEntry = runInstaller([], {
    HUSH_INSTALL_RUNTIME_ROOT: pruneEntryRoot,
    HUSH_INSTALL_BIN_DIR: pruneEntryBin,
  });
  assert.equal(recoveredPruneEntry.status, 0, recoveredPruneEntry.stderr);
  assert.equal(existsSync(pruneEntryOld), false);

  const pruneCandidateOne = join(runtimeBase, "d".repeat(40));
  const pruneCandidateTwo = join(runtimeBase, "e".repeat(40));
  writePrunableRuntime(pruneCandidateOne);
  writePrunableRuntime(pruneCandidateTwo);
  utimesSync(pruneCandidateOne, 3, 3);
  utimesSync(pruneCandidateTwo, 4, 4);
  const pruneRaceOutside = join(sandbox, "prune-race-outside");
  const pruneRace = await startPausedInstaller("before-prune");
  const restoreRuntimeParent = swapDirectory(runtimeBase, pruneRaceOutside);
  releasePausedInstaller(pruneRace);
  const pruneRaceResult = await pruneRace.done;
  assert.notEqual(pruneRaceResult.status, 0);
  assert.match(pruneRaceResult.stderr, swappedAncestorError);
  assertOutsideEmpty(pruneRaceOutside);
  restoreRuntimeParent();
  assert.equal(existsSync(pruneCandidateOne), true);
  const recoveredPrune = runInstaller();
  assert.equal(recoveredPrune.status, 0, recoveredPrune.stderr);
  assert.equal(existsSync(pruneCandidateOne), false);

  const unlinkRaceStage = join(runtimeBase, ".hush-stage-unlink-race");
  mkdirSync(unlinkRaceStage);
  writeStageMarker(unlinkRaceStage);
  const unlinkVictim = join(unlinkRaceStage, "victim");
  const unlinkPreserved = join(unlinkRaceStage, "victim-original");
  writeFileSync(unlinkVictim, "original\n");
  const unlinkRace = await startPausedInstaller("before-managed-entry-unlink", {
    HUSH_INSTALL_TEST_PAUSE_ENTRY: "victim",
  });
  renameSync(unlinkVictim, unlinkPreserved);
  writeFileSync(unlinkVictim, "replacement\n");
  releasePausedInstaller(unlinkRace);
  const unlinkRaceResult = await unlinkRace.done;
  assert.notEqual(unlinkRaceResult.status, 0);
  assert.match(unlinkRaceResult.stderr, /managed entry changed before removal/);
  assert.equal(readFileSync(unlinkVictim, "utf8"), "replacement\n");
  assert.equal(readFileSync(unlinkPreserved, "utf8"), "original\n");
  rmSync(unlinkRaceStage, { recursive: true });
  const unlinkRecovery = runInstaller();
  assert.equal(unlinkRecovery.status, 0, unlinkRecovery.stderr);

  const crashParent = join(sandbox, "crash-runtimes");
  const crashRoot = join(crashParent, sourceCommit);
  const crashBin = join(sandbox, "crash-bin");
  const crashed = await startPausedInstaller("before-runtime-publish", {
    HUSH_INSTALL_RUNTIME_ROOT: crashRoot,
    HUSH_INSTALL_BIN_DIR: crashBin,
  });
  process.kill(crashed.internalPid, "SIGTERM");
  const crashResult = await crashed.done;
  assert.notEqual(crashResult.status, 0);
  assert.equal(existsSync(crashRoot), false);
  assert.equal(readdirSync(crashParent).some((name) => name.startsWith(".hush-stage-")), true);
  const recoveredCrash = runInstaller([], {
    HUSH_INSTALL_RUNTIME_ROOT: crashRoot,
    HUSH_INSTALL_BIN_DIR: crashBin,
  });
  assert.equal(recoveredCrash.status, 0, recoveredCrash.stderr);
  assert.equal(readdirSync(crashParent).some((name) => name.startsWith(".hush-stage-")), false);
  assert.equal(existsSync(join(crashBin, "hush")), true);

  const renameCrashParent = join(sandbox, "rename-crash-runtimes");
  const renameCrashRoot = join(renameCrashParent, sourceCommit);
  const renameCrashBin = join(sandbox, "rename-crash-bin");
  const renamedCrash = await startPausedInstaller("after-runtime-rename", {
    HUSH_INSTALL_RUNTIME_ROOT: renameCrashRoot,
    HUSH_INSTALL_BIN_DIR: renameCrashBin,
  });
  assert.equal(existsSync(renameCrashRoot), true);
  process.kill(renamedCrash.internalPid, "SIGKILL");
  const renamedCrashResult = await renamedCrash.done;
  assert.notEqual(renamedCrashResult.status, 0);
  assert.equal(existsSync(renameCrashRoot), true);
  assert.equal(existsSync(join(renameCrashBin, "hush")), false);
  const recoveredRenameCrash = runInstaller([], {
    HUSH_INSTALL_RUNTIME_ROOT: renameCrashRoot,
    HUSH_INSTALL_BIN_DIR: renameCrashBin,
  });
  assert.equal(recoveredRenameCrash.status, 0, recoveredRenameCrash.stderr);
  assert.equal(readdirSync(renameCrashParent).some((name) => name.startsWith(".hush-stage-")), false);
  assert.equal(existsSync(join(renameCrashBin, "hush")), true);

  const cleanupPauseParent = join(sandbox, "cleanup-pause-runtimes");
  const cleanupPause = await startPausedInstaller("after-lock", {
    HUSH_INSTALL_RUNTIME_ROOT: join(cleanupPauseParent, sourceCommit),
    HUSH_INSTALL_BIN_DIR: join(sandbox, "cleanup-pause-bin"),
  });
  const cleanupPauseResult = await reapPausedInstaller(cleanupPause);
  assert.notEqual(cleanupPauseResult.status, 0);
  assert.throws(
    () => process.kill(cleanupPause.internalPid, 0),
    (error) => error.code === "ESRCH",
  );
}

try {
  await main();
  console.log("local install verified");
} finally {
  await cleanupPausedInstallers();
  rmSync(sandbox, { recursive: true, force: true });
}
