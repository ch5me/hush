import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const require = createRequire(import.meta.url);
const pkg = require("../package.json");

function fail(message) {
  throw new Error(message);
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: "utf8",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function assertSuccess(label, command, args, result) {
  if (result.status === 0) {
    return;
  }

  const stderr = result.stderr?.trim();
  const stdout = result.stdout?.trim();
  const details = [stderr, stdout].filter(Boolean).join("\n");
  fail(`${label} failed: ${formatCommand(command, args)}${details ? `\n${details}` : ""}`);
}

function assertIncludes(label, output, needle) {
  if (!output.includes(needle)) {
    fail(`${label} missing ${JSON.stringify(needle)}. Output was:\n${output}`);
  }
}

function verifySourceBin() {
  const versionResult = run(process.execPath, ["./bin/hush.js", "--version"]);
  assertSuccess(
    "source version check",
    process.execPath,
    ["./bin/hush.js", "--version"],
    versionResult,
  );

  if (versionResult.stdout.trim() !== pkg.version) {
    fail(
      `source version output mismatch: expected ${pkg.version}, got ${JSON.stringify(versionResult.stdout.trim())}`,
    );
  }

  const helpResult = run(process.execPath, ["./bin/hush.js", "--help"]);
  assertSuccess("source help check", process.execPath, ["./bin/hush.js", "--help"], helpResult);
  assertIncludes("source help output", helpResult.stdout, "Usage:");
  assertIncludes("source help output", helpResult.stdout, "hush <command> [options]");
}

function packTarball() {
  const packResult = run("npm", ["pack", "--json"]);
  assertSuccess("npm pack", "npm", ["pack", "--json"], packResult);

  let packOutput;
  try {
    packOutput = JSON.parse(packResult.stdout);
  } catch (error) {
    fail(`unable to parse npm pack output: ${String(error)}\n${packResult.stdout}`);
  }

  const filename = packOutput?.[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    fail(`npm pack did not return a tarball filename: ${packResult.stdout}`);
  }

  return join(packageRoot, filename);
}

function verifyTarballContents(tarballPath) {
  const binResult = run("tar", ["-xOf", tarballPath, "package/bin/hush.js"]);
  assertSuccess("tarball bin read", "tar", ["-xOf", tarballPath, "package/bin/hush.js"], binResult);
  assertIncludes("packed bin script", binResult.stdout, "process.env.HUSH_CLI_ENTRYPOINT = '1';");
}

function verifyInstalledTarball(tarballPath) {
  const installRoot = mkdtempSync(join(tmpdir(), "hush-pack-install-"));

  try {
    const initResult = run("npm", ["init", "-y"], { cwd: installRoot });
    assertSuccess("temp npm init", "npm", ["init", "-y"], initResult);

    const installResult = run("npm", ["install", tarballPath], { cwd: installRoot });
    assertSuccess("temp npm install", "npm", ["install", tarballPath], installResult);

    const binPath = join(installRoot, "node_modules", ".bin", "hush");
    const installedPackageBinPath = join(
      installRoot,
      "node_modules",
      "@chriscode",
      "hush",
      "bin",
      "hush.js",
    );
    const installedBin = readFileSync(installedPackageBinPath, "utf8");
    assertIncludes("installed package bin", installedBin, "process.env.HUSH_CLI_ENTRYPOINT = '1';");

    const versionResult = run(binPath, ["--version"], { cwd: installRoot });
    assertSuccess("installed version check", binPath, ["--version"], versionResult);
    if (versionResult.stdout.trim() !== pkg.version) {
      fail(
        `installed version output mismatch: expected ${pkg.version}, got ${JSON.stringify(versionResult.stdout.trim())}`,
      );
    }

    const helpResult = run(binPath, ["--help"], { cwd: installRoot });
    assertSuccess("installed help check", binPath, ["--help"], helpResult);
    assertIncludes("installed help output", helpResult.stdout, "Usage:");
    assertIncludes("installed help output", helpResult.stdout, "hush <command> [options]");
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
}

function main() {
  verifySourceBin();

  const tarballPath = packTarball();
  try {
    verifyTarballContents(tarballPath);
    verifyInstalledTarball(tarballPath);
  } finally {
    rmSync(tarballPath, { force: true });
  }

  console.log(`verified hush package install path (${pkg.version})`);
}

main();
