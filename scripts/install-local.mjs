#!/usr/bin/env node
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNode24 } from "./install-local-helpers.mjs";

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const root = realpathSync(resolve(dirname(scriptPath), ".."));
const manifestName = ".hush-runtime-manifest.json";
const trackedSourcePaths = [
  ".npmrc",
  "bun.lock",
  "docs/package.json",
  "hush-cli/bin/hush.js",
  "hush-cli/package.json",
  "hush-cli/schema.json",
  "package.json",
];
const stagedSourcePaths = [...trackedSourcePaths, "hush-cli/dist"];

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function configuredDirectory(label, configured, fallback) {
  const value = configured || fallback;
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be absolute: ${value}`);
  }
  const candidate = resolve(value);
  if (candidate === parse(candidate).root) {
    throw new Error(`${label} must not be a filesystem root: ${candidate}`);
  }
  return candidate;
}

function assertCanonicalDirectory(label, candidate, create = false) {
  let ancestor = dirname(candidate);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new Error(`${label} has no existing directory ancestor: ${candidate}`);
    }
    ancestor = parent;
  }

  const ancestorMetadata = lstatSync(ancestor);
  if (ancestorMetadata.isSymbolicLink() || !ancestorMetadata.isDirectory()) {
    throw new Error(`${label} ancestor must be a real directory: ${ancestor}`);
  }
  const canonicalAncestor = realpathSync(ancestor);
  if (canonicalAncestor !== ancestor) {
    throw new Error(`${label} must not traverse symlinked ancestors: ${ancestor} -> ${canonicalAncestor}`);
  }

  if (create) mkdirSync(candidate, { recursive: true });

  let metadata;
  try {
    metadata = lstatSync(candidate);
  } catch {
    throw new Error(`${label} directory is missing: ${candidate}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${candidate}`);
  }
  const canonicalCandidate = realpathSync(candidate);
  if (canonicalCandidate !== candidate || !isInside(canonicalAncestor, canonicalCandidate)) {
    throw new Error(`${label} must not traverse symlinks: ${candidate} -> ${canonicalCandidate}`);
  }
  return canonicalCandidate;
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

function requireRealDirectory(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error(`Hush runtime incomplete: ${path}. Remove it and reinstall.`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Hush runtime root must be a real directory: ${path}`);
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

function collectRuntimeEntries(candidate, hashContents = true) {
  const runtimePath = requireRealDirectory(candidate);
  const entries = [{
    path: ".",
    type: "directory",
    mode: lstatSync(runtimePath).mode & 0o7777,
  }];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
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
        entries.push({
          path: relativePath,
          type: "directory",
          mode,
        });
        walk(path);
      } else if (metadata.isFile()) {
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
  const rootPath = requireRealDirectory(path);
  const entries = [{
    path: ".",
    type: "directory",
    mode: lstatSync(rootPath).mode & 0o7777,
  }];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = join(directory, entry.name);
      const relativePath = relativeManifestPath(rootPath, entryPath);
      const metadata = lstatSync(entryPath);
      const mode = metadata.mode & 0o7777;
      if (metadata.isSymbolicLink()) {
        entries.push({ path: relativePath, type: "symlink", mode, target: readlinkSync(entryPath) });
      } else if (metadata.isDirectory()) {
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
  const packagePath = join(candidate, "hush-cli", "package.json");
  const requiredPaths = [
    join(candidate, "hush-cli", "bin", "hush.js"),
    join(candidate, "hush-cli", "dist", "cli.js"),
    packagePath,
  ];
  if (requiredPaths.some((path) => !existsSync(path))) {
    throw new Error(`Hush runtime incomplete: ${candidate}. Remove it and reinstall.`);
  }

  const collected = collectRuntimeEntries(candidate, hashContents);
  const { runtimePath } = collected;
  for (const path of requiredPaths) {
    const resolvedPath = realpathSync(path);
    if (!isInside(runtimePath, resolvedPath)) {
      throw new Error(`Hush runtime file escapes runtime: ${resolvedPath}`);
    }
  }

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
        if (dependency.optional && !findInstalledDependency(canonicalPackagePath, dependency.name, runtimePath)) continue;
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

function assertRuntimeInputs(inputRoot) {
  for (const path of trackedSourcePaths) {
    const inputPath = join(inputRoot, path);
    const metadata = lstatSync(inputPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Hush runtime input must be a regular file: ${inputPath}`);
    }
  }

  const buildRoot = join(inputRoot, "hush-cli", "dist");
  requireRealDirectory(buildRoot);
  const pending = [buildRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Hush runtime input symlink is forbidden: ${path}`);
      }
      if (metadata.isDirectory()) pending.push(path);
      else if (!metadata.isFile()) throw new Error(`Hush runtime input type is unsupported: ${path}`);
    }
  }
}

function sourceIdentityFromInputs(sourceRoot, inputRoot) {
  const canonicalSourceRoot = realpathSync(sourceRoot);
  const canonicalInputRoot = realpathSync(inputRoot);
  assertRuntimeInputs(canonicalInputRoot);
  const trackedInputs = [];
  for (const path of trackedSourcePaths) {
    const stagedBytes = readFileSync(join(canonicalInputRoot, path));
    const committedBytes = execFileSync("git", ["show", `HEAD:${path}`], {
      cwd: canonicalSourceRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (!stagedBytes.equals(committedBytes)) {
      throw new Error(
        `Hush tracked shipped input differs from HEAD: ${path}\n` +
          "Commit or restore that input before installing a commit-attributed runtime.",
      );
    }
    trackedInputs.push({ path, sha256: sha256(stagedBytes) });
  }
  return {
    tracked: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: canonicalSourceRoot, encoding: "utf8" }).trim(),
      tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: canonicalSourceRoot, encoding: "utf8" }).trim(),
      inputsSha256: sha256(JSON.stringify(trackedInputs)),
    },
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
  writeFileSync(manifestPath, `${JSON.stringify(createRuntimeManifest(candidate, source, entries), null, 2)}\n`, { mode: 0o444 });
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
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Hush runtime manifest must be a regular file: ${manifestPath}`);
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

export function stageRuntime(sourceRoot, destination) {
  const canonicalSourceRoot = realpathSync(sourceRoot);
  assertRuntimeInputs(canonicalSourceRoot);
  for (const path of stagedSourcePaths) {
    const sourcePath = join(canonicalSourceRoot, path);
    if (!existsSync(sourcePath)) continue;
    const destinationPath = join(destination, path);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath, { recursive: true, verbatimSymlinks: true });
  }
  assertRuntimeInputs(destination);
}

function validateLauncher(target, launcher) {
  let metadata;
  try {
    metadata = lstatSync(target);
  } catch {
    throw new Error(`Hush launcher missing: ${target}. Re-run \`node scripts/install-local.mjs\`.`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Hush launcher must be a regular non-symlink file: ${target}`);
  }
  if ((metadata.mode & 0o111) === 0) {
    throw new Error(`Hush launcher is not executable: ${target}`);
  }
  const launcherRealpath = realpathSync(target);
  if (!statSync(launcherRealpath).isFile()) {
    throw new Error(`Hush launcher realpath is not a regular file: ${launcherRealpath}`);
  }
  if (readFileSync(launcherRealpath, "utf8") !== launcher) {
    throw new Error(`Hush launcher drift: ${target}. Re-run \`node scripts/install-local.mjs\`.`);
  }
  return launcherRealpath;
}

function reportShadowedInstall(target, binDir) {
  if (process.env.HUSH_INSTALL_SKIP_SHADOW_CHECK === "1") return false;

  const loginShell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/sh";
  let resolved;
  try {
    resolved = execFileSync(loginShell, ["-lc", "command -v hush"], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    console.error(
      `hush: installed ${target}, but login shell resolution failed (${loginShell} -lc): ` +
        `${error.message}. This install is not delivered.`,
    );
    return true;
  }

  if (!resolved) {
    console.error(
      `hush: installed ${target}, but a login shell (${loginShell} -lc) resolves no hush at all -- ` +
        `${binDir} is missing from the login PATH, so this install is not delivered.`,
    );
    return true;
  }

  let resolvedRealpath;
  try {
    resolvedRealpath = realpathSync(resolved);
  } catch {
    console.error(`hush: login shell resolved unusable hush path: ${resolved}`);
    return true;
  }
  if (resolvedRealpath === realpathSync(target)) return false;

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

function main() {
  const builtCli = join(root, "hush-cli", "dist", "cli.js");
  const runtimeRoot = configuredDirectory("Hush runtime root", process.env.HUSH_INSTALL_RUNTIME_ROOT, root);
  const binDir = configuredDirectory("Hush bin root", process.env.HUSH_INSTALL_BIN_DIR, join(homedir(), ".local", "bin"));
  const target = join(binDir, "hush");
  const temporary = `${target}.tmp-${process.pid}`;
  const nodePath = realpathSync(process.execPath);
  const runtimeEntrypoint = join(runtimeRoot, "hush-cli", "bin", "hush.js");
  const checkOnly = process.argv.includes("--check");

  if (!existsSync(builtCli)) {
    throw new Error(`Hush build missing: ${builtCli}. Run \`bun run cli:build\` first.`);
  }
  assertNode24(process.version);
  const packageManager = readJson(join(root, "package.json")).packageManager;
  const expectedBunVersion = /^bun@(.+)$/.exec(packageManager)?.[1];
  const actualBunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
  if (!expectedBunVersion || actualBunVersion !== expectedBunVersion) {
    throw new Error(`Hush installer requires ${packageManager}; found bun@${actualBunVersion}.`);
  }

  const runtimeParent = dirname(runtimeRoot);
  assertCanonicalDirectory("Hush runtime parent", runtimeParent, !checkOnly);
  assertCanonicalDirectory("Hush bin root", binDir, !checkOnly);

  if (runtimeRoot !== root && !existsSync(runtimeRoot) && !checkOnly) {
    const runtimeTemporary = `${runtimeRoot}.tmp-${process.pid}`;
    try {
      mkdirSync(runtimeTemporary);
      assertCanonicalDirectory("Hush staged runtime", runtimeTemporary);
      stageRuntime(root, runtimeTemporary);
      const source = sourceIdentityFromInputs(root, runtimeTemporary);
      execFileSync("bun", [
        "install",
        "--production",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--backend",
        "copyfile",
        "--filter",
        "@chriscode/hush",
      ], { cwd: runtimeTemporary, stdio: "inherit" });
      const installedSource = sourceIdentityFromInputs(root, runtimeTemporary);
      if (JSON.stringify(installedSource) !== JSON.stringify(source)) {
        throw new Error("Hush runtime inputs changed during dependency installation.");
      }
      const collected = validateRuntimeGraph(runtimeTemporary, true);
      writeRuntimeManifest(runtimeTemporary, source, collected.entries);
      validateRuntimeManifest(runtimeTemporary, source, collected.entries);
      assertCanonicalDirectory("Hush runtime parent", runtimeParent);
      renameSync(runtimeTemporary, runtimeRoot);
      assertCanonicalDirectory("Hush runtime root", runtimeRoot);
    } finally {
      rmSync(runtimeTemporary, { recursive: true, force: true });
    }
  } else {
    assertCanonicalDirectory("Hush runtime root", runtimeRoot);
    const source = sourceIdentity();
    const collected = validateRuntimeGraph(runtimeRoot, runtimeRoot !== root);
    if (runtimeRoot !== root) validateRuntimeManifest(runtimeRoot, source, collected.entries);
  }

  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = `#!/bin/sh
set -eu

unset NODE_PATH NODE_OPTIONS
exec ${quote(nodePath)} ${quote(runtimeEntrypoint)} "$@"
`;

  if (checkOnly) {
    validateLauncher(target, launcher);
    const shadowed = reportShadowedInstall(target, binDir);
    console.log(target);
    process.exit(shadowed ? 1 : 0);
  }

  try {
    assertCanonicalDirectory("Hush bin root", binDir);
    writeFileSync(temporary, launcher, { mode: 0o755, flag: "wx" });
    chmodSync(temporary, 0o755);
    assertCanonicalDirectory("Hush bin root", binDir);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  validateLauncher(target, launcher);

  if (runtimeRoot !== root) {
    const activeName = basename(runtimeRoot);
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
          assertCanonicalDirectory("Hush retained runtime", candidate.path);
          assertCanonicalDirectory("Hush runtime parent", runtimeParent);
          rmSync(candidate.path, { recursive: true, force: true });
        }
      }
    }
  }

  if (reportShadowedInstall(target, binDir)) process.exitCode = 1;
  console.log(target);
}

if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) main();
