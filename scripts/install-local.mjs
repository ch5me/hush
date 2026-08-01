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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNode24 } from "./install-local-helpers.mjs";

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const root = realpathSync(resolve(dirname(scriptPath), ".."));
const manifestName = ".hush-runtime-manifest.json";
const shippedSourcePaths = [
  "hush-cli/bin",
  "hush-cli/dist",
  "hush-cli/package.json",
  "hush-cli/schema.json",
];

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
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
  const entries = [];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relativePath = relativeManifestPath(runtimePath, path);
      if (relativePath === manifestName) continue;

      const metadata = lstatSync(path);
      const mode = metadata.mode & 0o777;
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

function collectSourceDependencyRoots(sourcePackagePath, sourceRuntimePath, roots = new Set(), visited = new Set()) {
  const canonicalSourcePackagePath = realpathSync(sourcePackagePath);
  if (visited.has(canonicalSourcePackagePath)) return roots;
  visited.add(canonicalSourcePackagePath);

  const packageDocument = readJson(canonicalSourcePackagePath);
  const packageRequire = createRequire(canonicalSourcePackagePath);
  for (const dependency of dependencyGroups(packageDocument)) {
    let resolvedPath;
    try {
      resolvedPath = realpathSync(packageRequire.resolve(dependency.name));
    } catch {
      if (dependency.optional && !findInstalledDependency(canonicalSourcePackagePath, dependency.name, sourceRuntimePath)) {
        continue;
      }
      throw new Error(`Hush source ${dependency.kind} missing: ${dependency.name} required by ${canonicalSourcePackagePath}`);
    }
    if (!isInside(sourceRuntimePath, resolvedPath)) {
      throw new Error(`Hush source ${dependency.kind} escapes repository: ${dependency.name} -> ${resolvedPath}`);
    }
    const dependencyPackagePath = findPackagePath(sourceRuntimePath, resolvedPath);
    if (!dependencyPackagePath) {
      throw new Error(`Hush source dependency package missing package.json: ${dependency.name} -> ${resolvedPath}`);
    }
    roots.add(dirname(dependencyPackagePath));
    collectSourceDependencyRoots(dependencyPackagePath, sourceRuntimePath, roots, visited);
  }
  return roots;
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

export function sourceIdentity(sourceRoot = root) {
  const canonicalSourceRoot = realpathSync(sourceRoot);
  const trackedPaths = new Set(shippedSourcePaths);
  for (const packageRoot of collectSourceDependencyRoots(
    join(canonicalSourceRoot, "hush-cli", "package.json"),
    canonicalSourceRoot,
  )) {
    trackedPaths.add(relative(canonicalSourceRoot, packageRoot));
  }
  const trackedDrift = execFileSync(
    "git",
    ["diff", "--name-only", "--no-ext-diff", "HEAD", "--", ...[...trackedPaths].sort()],
    { cwd: canonicalSourceRoot, encoding: "utf8" },
  ).trim();
  if (trackedDrift) {
    throw new Error(
      `Hush tracked shipped inputs are dirty:\n${trackedDrift}\n` +
        "Commit or restore those inputs before installing a commit-attributed runtime.",
    );
  }
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: canonicalSourceRoot, encoding: "utf8" }).trim(),
    tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: canonicalSourceRoot, encoding: "utf8" }).trim(),
  };
}

export function createRuntimeManifest(candidate, source, entries = collectRuntimeEntries(candidate).entries) {
  return {
    version: 1,
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
  if (manifest.version !== 1 || !manifest.source || !Array.isArray(manifest.files)) {
    throw new Error(`Hush runtime manifest invalid: ${manifestPath}`);
  }
  if (manifest.source.commit !== source.commit || manifest.source.tree !== source.tree) {
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

function copyPackageWithoutNodeModules(sourcePackageRoot, destinationPackageRoot) {
  cpSync(sourcePackageRoot, destinationPackageRoot, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (sourcePath) => {
      const path = relative(sourcePackageRoot, sourcePath);
      return path !== "node_modules" && !path.startsWith(`node_modules${sep}`);
    },
  });
}

function stagePackageDependencies(sourcePackagePath, destinationPackageRoot, sourceRuntimePath, ancestry = new Set()) {
  const canonicalSourcePackagePath = realpathSync(sourcePackagePath);
  if (ancestry.has(canonicalSourcePackagePath)) return;
  const nextAncestry = new Set(ancestry).add(canonicalSourcePackagePath);
  const packageDocument = readJson(canonicalSourcePackagePath);
  const packageRequire = createRequire(canonicalSourcePackagePath);

  for (const dependency of dependencyGroups(packageDocument)) {
    let resolvedPath;
    try {
      resolvedPath = realpathSync(packageRequire.resolve(dependency.name));
    } catch {
      if (dependency.optional && !findInstalledDependency(canonicalSourcePackagePath, dependency.name, sourceRuntimePath)) {
        continue;
      }
      throw new Error(`Hush source ${dependency.kind} missing: ${dependency.name} required by ${canonicalSourcePackagePath}`);
    }
    if (!isInside(sourceRuntimePath, resolvedPath)) {
      throw new Error(`Hush source ${dependency.kind} escapes repository: ${dependency.name} -> ${resolvedPath}`);
    }
    const dependencyPackagePath = findPackagePath(sourceRuntimePath, resolvedPath);
    if (!dependencyPackagePath) {
      throw new Error(`Hush source dependency package missing package.json: ${dependency.name} -> ${resolvedPath}`);
    }

    const destinationPackagePath = join(destinationPackageRoot, "node_modules", ...dependency.name.split("/"));
    if (!existsSync(destinationPackagePath)) {
      mkdirSync(dirname(destinationPackagePath), { recursive: true });
      copyPackageWithoutNodeModules(dirname(dependencyPackagePath), destinationPackagePath);
    }
    stagePackageDependencies(dependencyPackagePath, destinationPackagePath, sourceRuntimePath, nextAncestry);
  }
}

export function stageRuntime(sourceRoot, destination) {
  const canonicalSourceRoot = realpathSync(sourceRoot);
  const sourceCliRoot = join(canonicalSourceRoot, "hush-cli");
  const destinationCliRoot = join(destination, "hush-cli");
  mkdirSync(destinationCliRoot, { recursive: true });
  for (const name of ["bin", "dist", "package.json", "schema.json"]) {
    const sourcePath = join(sourceCliRoot, name);
    if (existsSync(sourcePath)) {
      cpSync(sourcePath, join(destinationCliRoot, name), { recursive: true, verbatimSymlinks: true });
    }
  }
  stagePackageDependencies(join(sourceCliRoot, "package.json"), destinationCliRoot, canonicalSourceRoot);
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
  const runtimeRoot = resolve(process.env.HUSH_INSTALL_RUNTIME_ROOT || root);
  const binDir = resolve(process.env.HUSH_INSTALL_BIN_DIR || join(homedir(), ".local", "bin"));
  const target = join(binDir, "hush");
  const temporary = `${target}.tmp-${process.pid}`;
  const nodePath = realpathSync(process.execPath);
  const runtimeEntrypoint = join(runtimeRoot, "hush-cli", "bin", "hush.js");
  const checkOnly = process.argv.includes("--check");
  const source = sourceIdentity();

  if (!existsSync(builtCli)) {
    throw new Error(`Hush build missing: ${builtCli}. Run \`bun run cli:build\` first.`);
  }
  assertNode24(process.version);

  if (runtimeRoot !== root && !existsSync(runtimeRoot) && !checkOnly) {
    const runtimeTemporary = `${runtimeRoot}.tmp-${process.pid}`;
    mkdirSync(dirname(runtimeRoot), { recursive: true });
    try {
      mkdirSync(runtimeTemporary);
      stageRuntime(root, runtimeTemporary);
      const collected = validateRuntimeGraph(runtimeTemporary, true);
      writeRuntimeManifest(runtimeTemporary, source, collected.entries);
      validateRuntimeManifest(runtimeTemporary, source, collected.entries);
      renameSync(runtimeTemporary, runtimeRoot);
    } finally {
      rmSync(runtimeTemporary, { recursive: true, force: true });
    }
  } else {
    const collected = validateRuntimeGraph(runtimeRoot, runtimeRoot !== root);
    if (runtimeRoot !== root) validateRuntimeManifest(runtimeRoot, source, collected.entries);
  }

  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = `#!/bin/sh
set -eu

exec ${quote(nodePath)} ${quote(runtimeEntrypoint)} "$@"
`;

  if (checkOnly) {
    validateLauncher(target, launcher);
    const shadowed = reportShadowedInstall(target, binDir);
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
  validateLauncher(target, launcher);

  if (runtimeRoot !== root) {
    const runtimeParent = dirname(runtimeRoot);
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
        if (!keep.has(candidate.name)) rmSync(candidate.path, { recursive: true, force: true });
      }
    }
  }

  if (reportShadowedInstall(target, binDir)) process.exitCode = 1;
  console.log(target);
}

if (process.argv[1] && realpathSync(process.argv[1]) === scriptPath) main();
