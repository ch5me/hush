#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNode24 } from "./install-local-helpers.mjs";

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const root = realpathSync(resolve(dirname(scriptPath), ".."));
const manifestName = ".hush-runtime-manifest.json";
const stageMarkerName = ".hush-stage-owner";
const trackedSourcePaths = [
  ".npmrc",
  "bun.lock",
  "docs/package.json",
  "hush-cli/bin/hush.js",
  "hush-cli/package.json",
  "hush-cli/schema.json",
  "package.json",
];
const stagedSourcePaths = trackedSourcePaths.map((path) => `f:${path}`);
stagedSourcePaths.push("t:hush-cli/dist");

const guardedFds = {
  source: 10,
  runtimeParent: 11,
  bin: 12,
};
const pinnedBunEnv = "HUSH_INSTALL_PINNED_BUN_PATH";
const pinnedGitEnv = "HUSH_INSTALL_PINNED_GIT_PATH";
const loginPathBlockStart = "# >>> hush managed login PATH >>>";
const loginPathBlockEnd = "# <<< hush managed login PATH <<<";

export class HushInstallError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "HushInstallError";
    this.code = code;
  }
}

export function assertSupportedInstallerPlatform(platform = process.platform) {
  if (platform !== "darwin" && platform !== "linux") {
    throw new HushInstallError(
      "HUSH_INSTALL_UNSUPPORTED_PLATFORM",
      `managed local install supports macOS and Linux; found ${platform}`,
    );
  }
}

export function assertInstallerPrerequisites({
  platform = process.platform,
  nodeVersion = process.version,
  pathExists = existsSync,
} = {}) {
  assertSupportedInstallerPlatform(platform);
  try {
    assertNode24(nodeVersion);
  } catch (error) {
    throw new HushInstallError("HUSH_INSTALL_MISSING_PREREQUISITE", error.message);
  }
  for (const path of ["/usr/bin/cc", "/usr/bin/git"]) {
    if (!pathExists(path)) {
      throw new HushInstallError(
        "HUSH_INSTALL_MISSING_PREREQUISITE",
        `managed local install requires ${path}`,
      );
    }
  }
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function configuredDirectory(label, configured, fallback) {
  const value = configured || fallback;
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute: ${value}`);
  const candidate = resolve(value);
  if (candidate === parse(candidate).root) {
    throw new Error(`${label} must not be a filesystem root: ${candidate}`);
  }
  return candidate;
}

function pathsOverlap(left, right) {
  return isInside(left, right) || isInside(right, left);
}

function requireExecutablePath(label, candidate, allowRootOwnedHardlinks = false) {
  if (!candidate || !isAbsolute(candidate)) {
    throw new Error(`${label} path must be absolute: ${candidate || "(missing)"}`);
  }
  const canonical = realpathSync(candidate);
  const metadata = lstatSync(canonical);
  const linksAreSafe = metadata.nlink === 1 || (allowRootOwnedHardlinks && metadata.uid === 0);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !linksAreSafe || !(metadata.mode & 0o111)) {
    throw new Error(`${label} must be a trusted executable regular file: ${canonical}`);
  }
  return canonical;
}

function gitEnvironment(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  return env;
}

function resolveBunExecutable(expectedVersion) {
  const candidates = [];
  if (process.env.HUSH_INSTALL_BUN_PATH) candidates.push(process.env.HUSH_INSTALL_BUN_PATH);

  const marker = `${sep}installs${sep}node${sep}`;
  const markerIndex = process.execPath.indexOf(marker);
  if (markerIndex >= 0) {
    candidates.push(join(process.execPath.slice(0, markerIndex), "installs", "bun", expectedVersion, "bin", "bun"));
  }

  const accountHome = userInfo().homedir;
  candidates.push(
    join(accountHome, ".local", "share", "mise", "installs", "bun", expectedVersion, "bin", "bun"),
    join(accountHome, ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
    "/usr/bin/bun",
  );

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const executable = requireExecutablePath("Hush installer Bun", candidate);
    const version = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      env: gitEnvironment(),
      timeout: 30_000,
    }).trim();
    if (version === expectedVersion) return executable;
  }
  throw new Error(
    `Hush installer requires bun@${expectedVersion} at a managed absolute path. ` +
      "Set HUSH_INSTALL_BUN_PATH to the Bun executable.",
  );
}

function resolveToolPaths(guarded) {
  if (guarded) {
    return {
      bunPath: requireExecutablePath("Pinned Hush installer Bun", process.env[pinnedBunEnv]),
      gitPath: requireExecutablePath("Pinned Hush installer Git", process.env[pinnedGitEnv], true),
    };
  }
  const packageManager = readJson(join(root, "package.json")).packageManager;
  const expectedBunVersion = /^bun@(.+)$/.exec(packageManager)?.[1];
  if (!expectedBunVersion) throw new Error(`Hush installer requires a pinned Bun packageManager: ${packageManager}`);
  return {
    bunPath: resolveBunExecutable(expectedBunVersion),
    gitPath: requireExecutablePath("Hush installer Git", "/usr/bin/git", true),
  };
}

function currentGitPath() {
  const guarded = process.env.HUSH_INSTALL_NATIVE_GUARDED === "1";
  return requireExecutablePath(
    guarded ? "Pinned Hush installer Git" : "Hush installer Git",
    guarded ? process.env[pinnedGitEnv] : "/usr/bin/git",
    true,
  );
}

function guardedEnvironment(config) {
  const env = gitEnvironment();
  delete env.HUSH_INSTALL_BUN_PATH;
  delete env[pinnedBunEnv];
  delete env[pinnedGitEnv];
  env[pinnedBunEnv] = config.bunPath;
  env[pinnedGitEnv] = config.gitPath;
  env.NODE_OPTIONS = "";
  env.NODE_PATH = "";
  env.PATH = [...new Set([
    dirname(config.bunPath),
    dirname(process.execPath),
    dirname(config.gitPath),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])].join(":");
  return env;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function relativeManifestPath(runtimePath, path) {
  return relative(runtimePath, path).split(sep).join("/");
}

function requireRealDirectory(path, label = "Hush runtime root") {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`Hush runtime incomplete: ${path}. Remove it and reinstall.`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return realpathSync(path);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Hush runtime JSON invalid: ${path}: ${error.message}`);
  }
}

function assertInputPath(inputRoot, relativePath, expectedType) {
  const components = relativePath.split("/");
  let current = inputRoot;
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch {
      throw new Error(`Hush runtime input is missing: ${current}`);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`Hush runtime input symlink is forbidden: ${current}`);
    }
    const leaf = index === components.length - 1;
    if (!leaf && !metadata.isDirectory()) {
      throw new Error(`Hush runtime input ancestor must be a directory: ${current}`);
    }
    if (leaf && expectedType === "file" && !metadata.isFile()) {
      throw new Error(`Hush runtime input must be a regular file: ${current}`);
    }
    if (leaf && expectedType === "directory" && !metadata.isDirectory()) {
      throw new Error(`Hush runtime input must be a real directory: ${current}`);
    }
  }
}

function assertRuntimeInputs(inputRoot) {
  const canonicalInputRoot = requireRealDirectory(inputRoot, "Hush runtime input root");
  for (const path of trackedSourcePaths) assertInputPath(canonicalInputRoot, path, "file");

  const buildRelativePath = join("hush-cli", "dist");
  assertInputPath(canonicalInputRoot, buildRelativePath, "directory");
  const buildRoot = join(canonicalInputRoot, buildRelativePath);
  const pending = [buildRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error(`Hush runtime input symlink is forbidden: ${path}`);
      if (metadata.isDirectory()) pending.push(path);
      else if (!metadata.isFile()) throw new Error(`Hush runtime input type is unsupported: ${path}`);
    }
  }
  return canonicalInputRoot;
}

function collectRuntimeEntries(candidate, hashContents = true) {
  const runtimePath = requireRealDirectory(candidate);
  const entries = [{
    path: ".",
    type: "directory",
    mode: lstatSync(runtimePath).mode & 0o7777,
  }];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relativePath = relativeManifestPath(runtimePath, path);
      if (relativePath === manifestName) continue;

      const metadata = lstatSync(path);
      const mode = metadata.mode & 0o7777;
      if (metadata.isSymbolicLink()) {
        let resolvedPath;
        try {
          resolvedPath = realpathSync(path);
        } catch {
          throw new Error(`Hush runtime symlink is broken: ${relativePath}`);
        }
        if (!isInside(runtimePath, resolvedPath)) {
          throw new Error(`Hush runtime symlink escapes runtime: ${relativePath} -> ${resolvedPath}`);
        }
        entries.push({
          path: relativePath,
          type: "symlink",
          mode,
          target: readlinkSync(path),
          resolved: relativeManifestPath(runtimePath, resolvedPath),
        });
      } else if (metadata.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", mode });
        walk(path);
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1) throw new Error(`Hush runtime hardlink is forbidden: ${relativePath}`);
        entries.push({
          path: relativePath,
          type: "file",
          mode,
          ...(hashContents ? { sha256: fileSha256(path) } : {}),
        });
      } else {
        throw new Error(`Hush runtime contains unsupported file type: ${relativePath}`);
      }
    }
  }

  walk(runtimePath);
  const stableEntries = entries.sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of hashContents ? stableEntries : []) {
    if (entry.type !== "symlink") continue;
    const resolvedMetadata = statSync(join(runtimePath, entry.resolved));
    if (resolvedMetadata.isFile()) {
      if (resolvedMetadata.nlink !== 1) {
        throw new Error(`Hush runtime hardlink is forbidden: ${entry.resolved}`);
      }
      entry.sha256 = fileSha256(join(runtimePath, entry.resolved));
      continue;
    }
    const prefix = `${entry.resolved}/`;
    entry.sha256 = sha256(JSON.stringify(
      stableEntries.filter((candidateEntry) => candidateEntry.path.startsWith(prefix)),
    ));
  }
  return { runtimePath, entries: stableEntries };
}

function directorySha256(path) {
  const rootPath = requireRealDirectory(path, "Hush build root");
  const entries = [{
    path: ".",
    type: "directory",
    mode: lstatSync(rootPath).mode & 0o7777,
  }];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name))) {
      const entryPath = join(directory, entry.name);
      const relativePath = relativeManifestPath(rootPath, entryPath);
      const metadata = lstatSync(entryPath);
      const mode = metadata.mode & 0o7777;
      if (metadata.isSymbolicLink()) {
        throw new Error(`Hush build input symlink is forbidden: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", mode });
        walk(entryPath);
      } else if (metadata.isFile()) {
        entries.push({ path: relativePath, type: "file", mode, sha256: fileSha256(entryPath) });
      } else {
        throw new Error(`Hush build contains unsupported file type: ${relativePath}`);
      }
    }
  }

  walk(rootPath);
  return sha256(JSON.stringify(entries));
}

function dependencyGroups(packageDocument) {
  const optionalPeers = packageDocument.peerDependenciesMeta ?? {};
  const dependencies = new Map();
  for (const name of Object.keys(packageDocument.dependencies ?? {})) {
    dependencies.set(name, { kind: "dependency", name, optional: false });
  }
  for (const name of Object.keys(packageDocument.optionalDependencies ?? {})) {
    dependencies.set(name, { kind: "optional dependency", name, optional: true });
  }
  for (const name of Object.keys(packageDocument.peerDependencies ?? {})) {
    if (!dependencies.has(name)) {
      dependencies.set(name, {
        kind: "peer dependency",
        name,
        optional: optionalPeers[name]?.optional === true,
      });
    }
  }
  return [...dependencies.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function findPackagePath(runtimePath, resolvedPath) {
  let directory = statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath);
  while (isInside(runtimePath, directory)) {
    const packagePath = join(directory, "package.json");
    if (existsSync(packagePath)) return packagePath;
    if (directory === runtimePath) break;
    directory = dirname(directory);
  }
  return undefined;
}

function findInstalledDependency(packagePath, dependencyName, runtimePath) {
  let directory = dirname(packagePath);
  while (isInside(runtimePath, directory)) {
    const dependencyPackagePath = join(directory, "node_modules", ...dependencyName.split("/"), "package.json");
    if (existsSync(dependencyPackagePath)) return dependencyPackagePath;
    if (directory === runtimePath) break;
    directory = dirname(directory);
  }
  return undefined;
}

export function validateRuntimeGraph(candidate, hashContents = false) {
  const collected = collectRuntimeEntries(candidate, hashContents);
  const { runtimePath } = collected;
  const requiredEntries = new Map(collected.entries.map((entry) => [entry.path, entry.type]));
  for (const path of ["hush-cli/bin/hush.js", "hush-cli/dist/cli.js", "hush-cli/package.json"]) {
    if (requiredEntries.get(path) !== "file") {
      throw new Error(`Hush runtime incomplete: ${candidate}. Remove it and reinstall.`);
    }
  }

  const packagePath = join(runtimePath, "hush-cli", "package.json");
  const visited = new Set();
  function validatePackage(currentPackagePath) {
    const canonicalPackagePath = realpathSync(currentPackagePath);
    if (visited.has(canonicalPackagePath)) return;
    visited.add(canonicalPackagePath);

    const packageDocument = readJson(canonicalPackagePath);
    const runtimeRequire = createRequire(canonicalPackagePath);
    for (const dependency of dependencyGroups(packageDocument)) {
      let resolvedPath;
      try {
        resolvedPath = realpathSync(runtimeRequire.resolve(dependency.name));
      } catch {
        if (dependency.optional && !findInstalledDependency(canonicalPackagePath, dependency.name, runtimePath)) {
          continue;
        }
        throw new Error(
          `Hush runtime ${dependency.kind} missing: ${dependency.name} required by ${canonicalPackagePath}`,
        );
      }
      if (!isInside(runtimePath, resolvedPath)) {
        throw new Error(
          `Hush runtime ${dependency.kind} escapes runtime: ${dependency.name} -> ${resolvedPath}`,
        );
      }
      const dependencyPackagePath = findPackagePath(runtimePath, resolvedPath);
      if (!dependencyPackagePath) {
        throw new Error(`Hush runtime dependency package missing package.json: ${dependency.name} -> ${resolvedPath}`);
      }
      validatePackage(dependencyPackagePath);
    }
  }

  validatePackage(packagePath);
  return collected;
}

function inputIdentity(inputRoot) {
  const canonicalInputRoot = assertRuntimeInputs(inputRoot);
  const trackedInputs = trackedSourcePaths.map((path) => ({
    path,
    sha256: fileSha256(join(canonicalInputRoot, path)),
  }));
  return {
    trackedInputs,
    inputsSha256: sha256(JSON.stringify(trackedInputs)),
    build: {
      path: "hush-cli/dist",
      sha256: directorySha256(join(canonicalInputRoot, "hush-cli", "dist")),
    },
    dependencies: {
      lockfile: "bun.lock",
      sha256: fileSha256(join(canonicalInputRoot, "bun.lock")),
    },
  };
}

function sourceIdentityFromInputs(sourceRoot, inputRoot) {
  const sourceWorkingDirectory = sourceRoot === "." ? "." : realpathSync(sourceRoot);
  const input = inputIdentity(inputRoot);
  const gitPath = currentGitPath();
  const env = gitEnvironment();
  const commit = execFileSync(gitPath, ["rev-parse", "HEAD"], {
    cwd: sourceWorkingDirectory,
    encoding: "utf8",
    env,
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Hush source commit is invalid: ${commit}`);
  for (const trackedInput of input.trackedInputs) {
    const committedBytes = execFileSync(gitPath, ["show", `${commit}:${trackedInput.path}`], {
      cwd: sourceWorkingDirectory,
      env,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (trackedInput.sha256 !== sha256(committedBytes)) {
      throw new Error(
        `Hush tracked shipped input differs from HEAD: ${trackedInput.path}\n` +
          "Commit or restore that input before installing a commit-attributed runtime.",
      );
    }
  }
  const currentCommit = execFileSync(gitPath, ["rev-parse", "HEAD"], {
    cwd: sourceWorkingDirectory,
    encoding: "utf8",
    env,
  }).trim();
  if (currentCommit !== commit) throw new Error("Hush source commit changed while reading runtime inputs.");
  return {
    tracked: {
      commit,
      tree: execFileSync(gitPath, ["rev-parse", `${commit}^{tree}`], {
        cwd: sourceWorkingDirectory,
        encoding: "utf8",
        env,
      }).trim(),
      inputsSha256: input.inputsSha256,
    },
    build: input.build,
    dependencies: input.dependencies,
  };
}

function stagedSourceIdentity(inputRoot, expectedSource) {
  const input = inputIdentity(inputRoot);
  const actual = {
    tracked: {
      ...expectedSource.tracked,
      inputsSha256: input.inputsSha256,
    },
    build: input.build,
    dependencies: input.dependencies,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expectedSource)) {
    throw new Error("Hush staged runtime inputs differ from the guarded source checkout.");
  }
  return actual;
}

export function sourceIdentity(sourceRoot = root) {
  return sourceIdentityFromInputs(sourceRoot, sourceRoot);
}

export function createRuntimeManifest(candidate, source, entries = collectRuntimeEntries(candidate).entries) {
  return {
    version: 2,
    source,
    files: entries,
  };
}

function writeRuntimeManifest(candidate, source, entries) {
  const manifestPath = join(candidate, manifestName);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(createRuntimeManifest(candidate, source, entries), null, 2)}\n`,
    { mode: 0o444, flag: "wx" },
  );
  chmodSync(manifestPath, 0o444);
}

function validateRuntimeManifest(candidate, source, currentEntries) {
  const manifestPath = join(candidate, manifestName);
  let metadata;
  try {
    metadata = lstatSync(manifestPath);
  } catch {
    throw new Error(`Hush runtime manifest missing: ${manifestPath}. Remove it and reinstall.`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new Error(`Hush runtime manifest must be a single-link regular file: ${manifestPath}`);
  }
  if ((metadata.mode & 0o777) !== 0o444) {
    throw new Error(`Hush runtime manifest mode drift: ${manifestPath}`);
  }

  const manifest = readJson(manifestPath);
  if (manifest.version !== 2 || !manifest.source || !Array.isArray(manifest.files)) {
    throw new Error(`Hush runtime manifest invalid: ${manifestPath}`);
  }
  if (JSON.stringify(manifest.source) !== JSON.stringify(source)) {
    throw new Error(`Hush runtime source identity drift: ${manifestPath}`);
  }

  const current = createRuntimeManifest(candidate, source, currentEntries);
  const expectedByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  if (expectedByPath.size !== manifest.files.length || manifest.files.some((entry) => typeof entry.path !== "string")) {
    throw new Error(`Hush runtime manifest invalid: ${manifestPath}`);
  }
  const currentByPath = new Map(current.files.map((entry) => [entry.path, entry]));
  for (const [path, expected] of expectedByPath) {
    const actual = currentByPath.get(path);
    if (!actual) throw new Error(`Hush runtime manifest drift: missing ${path}`);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Hush runtime manifest drift: changed ${path}`);
    }
  }
  for (const path of currentByPath.keys()) {
    if (!expectedByPath.has(path)) throw new Error(`Hush runtime manifest drift: unexpected ${path}`);
  }
}

function validateManagedRuntime(candidate, source) {
  const collected = validateRuntimeGraph(candidate, true);
  validateRuntimeManifest(candidate, source, collected.entries);
}

function compileNativeHelper() {
  const compiler = "/usr/bin/cc";
  if (!existsSync(compiler)) {
    throw new HushInstallError(
      "HUSH_INSTALL_MISSING_PREREQUISITE",
      `managed local install requires a C compiler at ${compiler}`,
    );
  }
  const buildDirectory = realpathSync(mkdtempSync(join(tmpdir(), "hush-install-native-")));
  const helperPath = join(buildDirectory, "hush-install-native");
  const source = readFileSync(join(root, "scripts", "install-local-native.c"));
  const result = spawnSync(
    compiler,
    ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-x", "c", "-", "-o", helperPath],
    {
      input: source,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  if (result.error) {
    rmSync(buildDirectory, { recursive: true, force: true });
    throw new HushInstallError(
      "HUSH_INSTALL_NATIVE_COMPILE_FAILED",
      `native helper compilation failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    rmSync(buildDirectory, { recursive: true, force: true });
    throw new HushInstallError(
      "HUSH_INSTALL_NATIVE_COMPILE_FAILED",
      `native helper compilation failed:\n${result.stderr || result.stdout}`,
    );
  }
  chmodSync(helperPath, 0o700);
  const metadata = lstatSync(helperPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    rmSync(buildDirectory, { recursive: true, force: true });
    throw new Error("Hush install helper must be a single-link regular file.");
  }
  return {
    path: helperPath,
    cleanup() {
      rmSync(buildDirectory, { recursive: true, force: true });
    },
  };
}

function assertGuardedDescriptors() {
  if (process.env.HUSH_INSTALL_NATIVE_GUARDED !== "1") {
    throw new Error("Hush installer internal mode requires the native install guard.");
  }
  for (const [label, fd] of Object.entries(guardedFds)) {
    let metadata;
    try {
      metadata = fstatSync(fd);
    } catch {
      throw new Error(`Hush installer native guard descriptor is missing: ${label}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Hush installer native guard descriptor has the wrong type: ${label}`);
    }
  }
  const helperPath = process.env.HUSH_INSTALL_NATIVE_HELPER;
  if (!helperPath || !isAbsolute(helperPath)) {
    throw new Error("Hush installer native helper path is missing.");
  }
  const metadata = lstatSync(helperPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !(metadata.mode & 0o111)) {
    throw new Error("Hush installer native helper is not an executable single-link regular file.");
  }
  return helperPath;
}

function nativeStdio(stdin, stdout, stderr) {
  return [stdin, stdout, stderr, guardedFds.source, guardedFds.runtimeParent, guardedFds.bin];
}

function runNative(args, options = {}) {
  const helperPath = assertGuardedDescriptors();
  const result = spawnSync(helperPath, args, {
    input: options.input,
    encoding: options.encoding ?? "utf8",
    env: process.env,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: nativeStdio(options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || `native helper exited ${result.status}`).trim();
    const error = new Error(message);
    error.status = result.status;
    throw error;
  }
  return result.stdout;
}

function runNativeInherited(args) {
  const helperPath = assertGuardedDescriptors();
  const result = spawnSync(helperPath, args, {
    env: process.env,
    stdio: nativeStdio("inherit", "inherit", "inherit"),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Hush guarded command failed with exit ${result.status}.`);
}

function identityArgs(identity) {
  return identity ? [identity.device, identity.inode] : ["-", "-"];
}

function parseNativeIdentity(output, label) {
  const [device, inode, ...extra] = output.trim().split("\t");
  if (!device || !inode || extra.length > 0 || !/^\d+$/.test(device) || !/^\d+$/.test(inode)) {
    throw new Error(`Invalid native ${label} identity: ${output.trim()}`);
  }
  return { device, inode };
}

function runAtSource(command, args = [], capture = true) {
  const nativeArgs = ["run-at", "source", root, "-", "-", "-", command, ...args];
  return capture ? runNative(nativeArgs) : runNativeInherited(nativeArgs);
}

function runAtRuntime(runtimeParent, name, identity, command, args = [], capture = true) {
  const nativeArgs = ["run-at", "runtime", runtimeParent, name, ...identityArgs(identity), command, ...args];
  return capture ? runNative(nativeArgs) : runNativeInherited(nativeArgs);
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function readSourceIdentity() {
  const output = runAtSource(process.execPath, [scriptPath, "--internal-source-identity"]);
  return JSON.parse(output);
}

function assertSourceCommit(config, expectedCommit) {
  const actualCommit = runAtSource(config.gitPath, ["rev-parse", "HEAD"]).trim();
  if (actualCommit !== expectedCommit) {
    throw new Error(`Hush source commit changed during install: expected ${expectedCommit}, found ${actualCommit}.`);
  }
}

function validateRuntimeThroughGuard(runtimeParent, runtimeName, runtimeIdentity, source) {
  runAtRuntime(runtimeParent, runtimeName, runtimeIdentity, process.execPath, [
    scriptPath,
    "--internal-validate-runtime",
    encodeJson(source),
  ]);
}

function runtimeEntryInfo(runtimeParent, runtimeName) {
  const output = runNative(["entry-kind", runtimeParent, runtimeName]).trim();
  if (output === "missing") return { kind: "missing", identity: undefined };
  const [kind, device, inode, ...extra] = output.split("\t");
  if (
    extra.length > 0
    || !["directory", "symlink", "file", "other"].includes(kind)
    || !/^\d+$/.test(device)
    || !/^\d+$/.test(inode)
  ) {
    throw new Error(`Invalid native runtime entry: ${output}`);
  }
  return { kind, identity: { device, inode } };
}

function listRuntimeEntries(runtimeParent) {
  const output = runNative(["list-runtimes", runtimeParent]).trim();
  if (!output) return [];
  return output.split("\n").map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 6) throw new Error(`Invalid native runtime listing: ${line}`);
    const [kind, secondsText, nanosecondsText, device, inode, name] = fields;
    const seconds = Number(secondsText);
    const nanoseconds = Number(nanosecondsText);
    if (!["R", "S", "P", "X"].includes(kind)
      || !name
      || !Number.isFinite(seconds)
      || !Number.isFinite(nanoseconds)
      || !/^\d+$/.test(device)
      || !/^\d+$/.test(inode)) {
      throw new Error(`Invalid native runtime listing: ${line}`);
    }
    return {
      kind,
      name,
      identity: { device, inode },
      modified: seconds * 1000 + nanoseconds / 1_000_000,
    };
  });
}

function checkRoots(config) {
  runNative(["check-roots", root, config.runtimeParent, config.binDir]);
}

function cleanupStaleArtifacts(config, checkOnly) {
  const entries = listRuntimeEntries(config.runtimeParent);
  const unsafe = entries.find((entry) => entry.kind === "X");
  if (unsafe) throw new Error(`Hush managed runtime entry is symlinked or not a directory: ${unsafe.name}`);
  const stale = entries.filter((entry) => entry.kind === "S" || entry.kind === "P");
  if (checkOnly && stale.length > 0) {
    throw new Error(`Hush install has stale unpublished artifacts: ${stale.map((entry) => entry.name).join(", ")}`);
  }
  for (const entry of stale) {
    runNative(["remove-stale", config.runtimeParent, entry.name, ...identityArgs(entry.identity)]);
  }
  if (!checkOnly) runNative(["cleanup-bin", config.binDir]);
}

function validateLauncher(config, launcher) {
  const actual = runNative(["read-launcher", config.binDir, "hush"]);
  if (actual !== launcher) {
    throw new Error(`Hush launcher drift: ${config.target}. Re-run \`node scripts/install-local.mjs\`.`);
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function loginShellDetails() {
  const account = userInfo();
  const shell = process.env.SHELL && existsSync(process.env.SHELL)
    ? process.env.SHELL
    : account.shell || "/bin/sh";
  return {
    account,
    shell,
    args: basename(shell) === "zsh" ? ["-lic"] : ["-lc"],
  };
}

function coldLoginEnvironment(details) {
  return {
    HOME: homedir(),
    USER: details.account.username,
    LOGNAME: details.account.username,
    SHELL: details.shell,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HUSH_NO_UPDATE_CHECK: "1",
  };
}

function probeLoginShell(config) {
  checkRoots(config);
  const details = loginShellDetails();
  const marker = "__HUSH_LOGIN_RESOLVED__";
  const command = `printf '${marker}%s\\n' "$(command -v hush 2>/dev/null || true)"`;
  const result = spawnSync(details.shell, [...details.args, command], {
    encoding: "utf8",
    env: coldLoginEnvironment(details),
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.signal || result.status !== 0) {
    return {
      kind: "failure",
      shell: details.shell,
      invocation: details.args.join(" "),
      reason: result.error?.message || (result.signal ? `signal ${result.signal}` : `exit ${result.status}`),
    };
  }
  const markerLine = result.stdout
    .split(/\r?\n/)
    .findLast((line) => line.startsWith(marker));
  const resolved = markerLine?.slice(marker.length).trim() || "";
  if (!resolved) {
    return { kind: "missing", shell: details.shell, invocation: details.args.join(" ") };
  }
  if (!isAbsolute(resolved)) {
    return { kind: "relative", resolved, shell: details.shell, invocation: details.args.join(" ") };
  }

  const helperPath = assertGuardedDescriptors();
  const comparison = spawnSync(
    helperPath,
    ["same-launcher", config.binDir, "hush", resolved],
    {
      encoding: "utf8",
      env: process.env,
      stdio: nativeStdio("ignore", "pipe", "pipe"),
    },
  );
  if (comparison.status === 0) {
    checkRoots(config);
    return { kind: "delivered", resolved, shell: details.shell, invocation: details.args.join(" ") };
  }
  if (comparison.status !== 3) {
    return { kind: "unusable", resolved, shell: details.shell, invocation: details.args.join(" ") };
  }
  return { kind: "shadowed", resolved, shell: details.shell, invocation: details.args.join(" ") };
}

function reportLoginShellFailure(config, probe) {
  if (probe.kind === "failure") {
    console.error(
      `hush: installed ${config.target}, but login shell resolution failed ` +
        `(${probe.shell} ${probe.invocation}): ${probe.reason}. This install is not delivered.`,
    );
    return;
  }
  if (probe.kind === "missing") {
    console.error(
      `hush: installed ${config.target}, but a login shell (${probe.shell} ${probe.invocation}) ` +
        `resolves no hush at all -- ${config.binDir} is missing from the login PATH, ` +
        "so this install is not delivered.",
    );
    return;
  }
  if (probe.kind === "relative") {
    console.error(`hush: login shell resolved a non-absolute hush path: ${probe.resolved}`);
    return;
  }
  if (probe.kind === "unusable") {
    console.error(`hush: login shell resolved unusable hush path: ${probe.resolved}`);
    return;
  }
  console.error(
    `hush: SHADOWED INSTALL. Installed ${config.target}, but a login shell resolves ${probe.resolved} first.\n` +
      `hush is the secrets front door: every interactive shell would keep using that other copy, ` +
      `and this installer does not upgrade it.\n` +
      `Fix the shadow (for a global npm copy: npm uninstall -g @chriscode/hush), or put ${config.binDir} ` +
      `ahead of it on the login PATH, then re-run.\n` +
      `Set HUSH_INSTALL_SKIP_SHADOW_CHECK=1 to bypass deliberately.`,
  );
}

function readShellStartupFile(path) {
  let metadata;
  try {
    metadata = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false };
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error(`Hush login startup file must be a single-link regular file: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== BigInt(uid)) {
    throw new Error(`Hush login startup file must be owned by the current user: ${path}`);
  }
  return {
    exists: true,
    content: readFileSync(path, "utf8"),
    mode: Number(metadata.mode & 0o777n),
    identity: {
      dev: metadata.dev,
      ino: metadata.ino,
      size: metadata.size,
      mtimeNs: metadata.mtimeNs,
    },
  };
}

function sameShellStartupFile(left, right) {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino
    && left.identity.size === right.identity.size
    && left.identity.mtimeNs === right.identity.mtimeNs;
}

function renderLoginPathBlock(content, binDir) {
  const start = content.indexOf(loginPathBlockStart);
  const end = content.indexOf(loginPathBlockEnd);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error("Hush managed login PATH block is malformed; repair it before reinstalling.");
  }
  let base = content;
  if (start !== -1) {
    const secondStart = content.indexOf(loginPathBlockStart, start + loginPathBlockStart.length);
    const secondEnd = content.indexOf(loginPathBlockEnd, end + loginPathBlockEnd.length);
    if (secondStart !== -1 || secondEnd !== -1) {
      throw new Error("Hush managed login PATH block appears more than once; repair it before reinstalling.");
    }
    base = `${content.slice(0, start)}${content.slice(end + loginPathBlockEnd.length)}`;
  }
  base = base.replace(/(?:\r?\n)*$/, "");
  const block = [
    loginPathBlockStart,
    "# Managed by Hush scripts/install-local.mjs.",
    `export PATH=${shellQuote(binDir)}:"$PATH"`,
    loginPathBlockEnd,
    "",
  ].join("\n");
  return `${base}${base ? "\n\n" : ""}${block}`;
}

function writeShellStartupFile(path, expected, content, mode) {
  const current = readShellStartupFile(path);
  if (!sameShellStartupFile(current, expected)) {
    throw new Error(`Hush login startup file changed during install: ${path}`);
  }
  const temporary = join(dirname(path), `.hush-login-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    writeFileSync(temporary, content, { flag: "wx", mode });
    chmodSync(temporary, mode);
    const beforePublish = readShellStartupFile(path);
    if (!sameShellStartupFile(beforePublish, expected)) {
      throw new Error(`Hush login startup file changed during install: ${path}`);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function installZshLoginPath(config) {
  const details = loginShellDetails();
  if (basename(details.shell) !== "zsh") return undefined;
  const path = join(homedir(), ".zlogin");
  const original = readShellStartupFile(path);
  const installedContent = renderLoginPathBlock(original.content || "", config.binDir);
  if (original.exists && original.content === installedContent) return () => {};
  writeShellStartupFile(path, original, installedContent, original.mode || 0o644);
  return () => {
    const installed = readShellStartupFile(path);
    if (!installed.exists || installed.content !== installedContent) {
      throw new Error(`Hush login startup file changed before rollback: ${path}`);
    }
    if (original.exists) {
      writeShellStartupFile(path, installed, original.content, original.mode);
    } else {
      rmSync(path);
    }
  };
}

function ensureLoginShellDelivery(config, checkOnly) {
  if (process.env.HUSH_INSTALL_SKIP_SHADOW_CHECK === "1") return false;
  let probe = probeLoginShell(config);
  if (probe.kind === "delivered") return false;
  if (checkOnly) {
    reportLoginShellFailure(config, probe);
    return true;
  }

  const rollback = installZshLoginPath(config);
  if (rollback) {
    probe = probeLoginShell(config);
    if (probe.kind === "delivered") return false;
    rollback();
  }
  reportLoginShellFailure(config, probe);
  return true;
}

function validateToolchain(config) {
  const builtCli = join(root, "hush-cli", "dist", "cli.js");
  if (!existsSync(builtCli)) {
    throw new Error(`Hush build missing: ${builtCli}. Run \`bun run cli:build\` first.`);
  }
  assertNode24(process.version);
  const packageManager = readJson(join(root, "package.json")).packageManager;
  const expectedBunVersion = /^bun@(.+)$/.exec(packageManager)?.[1];
  const actualBunVersion = execFileSync(config.bunPath, ["--version"], {
    encoding: "utf8",
    env: gitEnvironment(),
    timeout: 30_000,
  }).trim();
  if (!expectedBunVersion || actualBunVersion !== expectedBunVersion) {
    throw new Error(`Hush installer requires ${packageManager}; found bun@${actualBunVersion}.`);
  }
}

function pauseForRaceTest(point) {
  if (process.env.HUSH_INSTALL_TEST_PAUSE_AT !== point) return;
  const marker = process.env.HUSH_INSTALL_TEST_PAUSE_MARKER;
  const release = process.env.HUSH_INSTALL_TEST_PAUSE_RELEASE;
  if (!marker || !release) throw new Error("Hush installer test pause requires marker and release paths.");
  writeFileSync(marker, `${process.pid}\n`, { flag: "wx" });
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) Atomics.wait(wait, 0, 0, 20);
}

function resolveManagedConfig(guarded = false) {
  const tools = resolveToolPaths(guarded);
  const commit = execFileSync(tools.gitPath, ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    env: gitEnvironment(),
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Hush source commit is invalid: ${commit}`);
  const defaultRuntimeRoot = join(homedir(), ".local", "state", "hush", "runtimes", commit);
  const configuredRuntimeRoot = process.env.HUSH_INSTALL_RUNTIME_ROOT;
  const runtimeRoot = configuredDirectory(
    "Hush runtime root",
    configuredRuntimeRoot,
    defaultRuntimeRoot,
  );
  if (pathsOverlap(runtimeRoot, root)) {
    throw new Error(
      "Hush managed runtime must not overlap the mutable source checkout. " +
        "Omit HUSH_INSTALL_RUNTIME_ROOT for the immutable default, or use --source-checkout for validation only.",
    );
  }
  const binDir = configuredDirectory(
    "Hush bin root",
    process.env.HUSH_INSTALL_BIN_DIR,
    join(homedir(), ".local", "bin"),
  );
  const runtimeName = basename(runtimeRoot);
  if (
    runtimeName.startsWith(".hush-stage-")
    || runtimeName.startsWith(".hush-prune-")
  ) {
    throw new Error(`Hush runtime root uses a reserved managed name: ${runtimeRoot}`);
  }
  if (runtimeName !== commit) {
    throw new Error(`Hush managed runtime root must end with the source commit ${commit}: ${runtimeRoot}`);
  }
  if (pathsOverlap(binDir, root)) {
    throw new Error(`Hush bin root must not overlap the mutable source checkout: ${binDir}`);
  }
  if (pathsOverlap(binDir, runtimeRoot)) {
    throw new Error(`Hush bin root must not overlap the managed runtime: ${binDir}`);
  }
  return {
    runtimeRoot,
    runtimeParent: dirname(runtimeRoot),
    runtimeName,
    expectedCommit: commit,
    runtimeEntrypoint: join(runtimeRoot, "hush-cli", "bin", "hush.js"),
    binDir,
    target: join(binDir, "hush"),
    ...tools,
  };
}

function parsePublicOptions(args) {
  const allowed = new Set(["--check", "--source-checkout"]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown Hush installer option: ${unknown[0]}`);
  return {
    checkOnly: args.includes("--check"),
    sourceCheckout: args.includes("--source-checkout"),
  };
}

function runSourceCheckoutMode(options) {
  if (process.env.HUSH_INSTALL_RUNTIME_ROOT) {
    throw new Error("--source-checkout cannot be combined with HUSH_INSTALL_RUNTIME_ROOT.");
  }
  validateToolchain(resolveToolPaths(false));
  sourceIdentity();
  const execution = spawnSync(
    process.execPath,
    [join(root, "hush-cli", "bin", "hush.js"), "--version"],
    {
      cwd: root,
      env: {
        ...gitEnvironment(),
        NODE_OPTIONS: "",
        NODE_PATH: "",
      },
      encoding: "utf8",
    },
  );
  if (execution.status !== 0) {
    throw new Error(`Hush source checkout launcher failed:\n${execution.stderr || execution.stdout}`);
  }
  console.log(join(root, "hush-cli", "bin", "hush.js"));
  if (!options.checkOnly) {
    console.error("hush: source-checkout validation complete; managed launcher unchanged.");
  }
}

function runGuardedInstaller(config, publicArgs) {
  const compiled = compileNativeHelper();
  try {
    const result = spawnSync(
      compiled.path,
      [
        "guard",
        publicArgs.includes("--check") ? "check" : "install",
        root,
        config.runtimeParent,
        config.binDir,
        process.execPath,
        scriptPath,
        "--internal-guarded",
        ...publicArgs,
      ],
      {
        env: {
          ...guardedEnvironment(config),
          HUSH_INSTALL_NATIVE_HELPER: compiled.path,
        },
        stdio: "inherit",
      },
    );
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`Hush guarded installer terminated by ${result.signal}.`);
    process.exitCode = result.status ?? 1;
  } finally {
    compiled.cleanup();
  }
}

function installManagedRuntime(config, checkOnly) {
  validateToolchain(config);
  assertGuardedDescriptors();
  checkRoots(config);
  pauseForRaceTest("after-lock");
  cleanupStaleArtifacts(config, checkOnly);
  const source = readSourceIdentity();
  if (config.expectedCommit && source.tracked.commit !== config.expectedCommit) {
    throw new Error(
      `Hush source commit changed before staging: expected ${config.expectedCommit}, found ${source.tracked.commit}.`,
    );
  }
  const runtimeEntry = runtimeEntryInfo(config.runtimeParent, config.runtimeName);
  let stageName;
  let stageIdentity;
  let runtimeIdentity = runtimeEntry.identity;
  let primaryError;

  try {
    if (runtimeEntry.kind === "missing") {
      if (checkOnly) {
        throw new Error(`Hush runtime missing: ${config.runtimeRoot}. Re-run \`node scripts/install-local.mjs\`.`);
      }
      stageName = `.hush-stage-${process.pid}-${randomBytes(8).toString("hex")}`;
      pauseForRaceTest("before-stage");
      stageIdentity = parseNativeIdentity(runNative([
        "stage",
        root,
        config.runtimeParent,
        stageName,
        ...stagedSourcePaths,
      ]), "stage");
      runAtRuntime(config.runtimeParent, stageName, stageIdentity, process.execPath, [
        scriptPath,
        "--internal-staged-identity",
        encodeJson(source),
      ]);
      runAtRuntime(config.runtimeParent, stageName, stageIdentity, config.bunPath, [
        "install",
        "--production",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--backend",
        "copyfile",
        "--filter",
        "@chriscode/hush",
      ], false);
      runAtRuntime(config.runtimeParent, stageName, stageIdentity, process.execPath, [
        scriptPath,
        "--internal-finalize-stage",
        encodeJson(source),
      ]);
      pauseForRaceTest("before-runtime-publish");
      assertSourceCommit(config, source.tracked.commit);
      runNative([
        "publish-runtime",
        config.runtimeParent,
        stageName,
        config.runtimeName,
        ...identityArgs(stageIdentity),
      ]);
      runtimeIdentity = stageIdentity;
      stageName = undefined;
    } else if (runtimeEntry.kind !== "directory") {
      throw new Error(`Hush runtime root must be a real directory: ${config.runtimeRoot}`);
    }
    validateRuntimeThroughGuard(config.runtimeParent, config.runtimeName, runtimeIdentity, source);
    checkRoots(config);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (stageName) {
      try {
        const currentStage = runtimeEntryInfo(config.runtimeParent, stageName);
        if (currentStage.kind === "directory") {
          const expected = stageIdentity ?? currentStage.identity;
          runNative(["remove-stale", config.runtimeParent, stageName, ...identityArgs(expected)]);
        } else if (currentStage.kind !== "missing") {
          throw new Error(`Hush stage changed before cleanup: ${stageName}`);
        }
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
      }
    }
  }

  const launcher = `#!/bin/sh
set -eu

unset NODE_PATH NODE_OPTIONS
exec ${shellQuote(realpathSync(process.execPath))} ${shellQuote(config.runtimeEntrypoint)} "$@"
`;

  if (checkOnly) {
    validateLauncher(config, launcher);
    const shadowed = ensureLoginShellDelivery(config, true);
    console.log(config.target);
    if (shadowed) process.exitCode = 1;
    return;
  }

  pauseForRaceTest("before-launcher-publish");
  assertSourceCommit(config, source.tracked.commit);
  checkRoots(config);
  const launcherTemporary = `.hush-launcher-${process.pid}-${randomBytes(8).toString("hex")}`;
  runNative(
    ["write-launcher", config.binDir, launcherTemporary, "hush", "755"],
    { input: launcher },
  );
  validateLauncher(config, launcher);
  checkRoots(config);

  const activeName = config.runtimeName;
  if (/^[0-9a-f]{40}$/.test(activeName)) {
    const entries = listRuntimeEntries(config.runtimeParent);
    const unsafe = entries.find((entry) => entry.kind === "X");
    if (unsafe) throw new Error(`Hush managed runtime entry is symlinked or not a directory: ${unsafe.name}`);
    const candidates = entries
      .filter((entry) => entry.kind === "R" && entry.name !== activeName)
      .sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name));
    for (const candidate of candidates.slice(1)) {
      pauseForRaceTest("before-prune");
      runNative([
        "prune-runtime",
        config.runtimeParent,
        candidate.name,
        ...identityArgs(candidate.identity),
      ]);
    }
  }

  if (ensureLoginShellDelivery(config, false)) process.exitCode = 1;
  console.log(config.target);
}

function internalSourceIdentity() {
  assertGuardedDescriptors();
  console.log(JSON.stringify(sourceIdentityFromInputs(".", ".")));
}

function internalStagedIdentity(encodedSource) {
  assertGuardedDescriptors();
  console.log(JSON.stringify(stagedSourceIdentity(".", decodeJson(encodedSource))));
}

function internalFinalizeStage(encodedSource) {
  assertGuardedDescriptors();
  const source = stagedSourceIdentity(".", decodeJson(encodedSource));
  const collected = validateRuntimeGraph(".", true);
  writeRuntimeManifest(".", source, collected.entries);
  validateRuntimeManifest(".", source, collected.entries);
}

function internalValidateRuntime(encodedSource) {
  assertGuardedDescriptors();
  validateManagedRuntime(".", decodeJson(encodedSource));
}

function main() {
  const args = process.argv.slice(2);
  assertInstallerPrerequisites();
  if (args[0] === "--internal-source-identity") return internalSourceIdentity();
  if (args[0] === "--internal-staged-identity") return internalStagedIdentity(args[1]);
  if (args[0] === "--internal-finalize-stage") return internalFinalizeStage(args[1]);
  if (args[0] === "--internal-validate-runtime") return internalValidateRuntime(args[1]);

  const guarded = args[0] === "--internal-guarded";
  const publicArgs = guarded ? args.slice(1) : args;
  const options = parsePublicOptions(publicArgs);
  if (options.sourceCheckout) {
    if (guarded) throw new Error("--source-checkout never runs under the managed install guard.");
    return runSourceCheckoutMode(options);
  }

  const config = resolveManagedConfig(guarded);
  if (!guarded) return runGuardedInstaller(config, publicArgs);
  return installManagedRuntime(config, options.checkOnly);
}

if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(`hush: ${error.message}`);
    process.exitCode = 1;
  }
}
