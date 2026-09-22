import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CON_06_RECEIPT_RELATIVE_PATH,
  Con06IntegratedClaimError,
  findForbiddenContractDependencies,
  findForbiddenContractImportSpecifiers,
  refuseIntegratedCon06Claim,
} from "../../src/mig01/con-06-consumer.js";

const hushCliRoot = join(import.meta.dirname, "..", "..");
const repoRoot = join(hushCliRoot, "..");
const sourceRoot = join(hushCliRoot, "src");
const workspacePackageJsonPaths = [
  join(repoRoot, "package.json"),
  join(hushCliRoot, "package.json"),
  join(repoRoot, "docs", "package.json"),
];
const bunLockPath = join(repoRoot, "bun.lock");
const receiptPath = join(repoRoot, CON_06_RECEIPT_RELATIVE_PATH);
const fakeIntegratedClaimPath = join(
  hushCliRoot,
  "tests",
  "fixtures",
  "mig01",
  "fake-integrated-claim.json",
);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const absolutePath = join(dir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(absolutePath));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(extname(entry))) {
      files.push(absolutePath);
    }
  }
  return files;
}

describe("CON-06 hush consumer is NOT_ACTIVATED", () => {
  it("records an honest NOT_ACTIVATED receipt with pin:null and binding:null", () => {
    const receipt = refuseIntegratedCon06Claim(loadJson(receiptPath));

    expect(receipt.status).toBe("NOT_ACTIVATED");
    expect(receipt.pin).toBeNull();
    expect(receipt.binding).toBeNull();
    expect(receipt.spend).toBe(0);
    expect(receipt.decision).toBe("D08");
    expect(receipt.inImportMatrix).toBe(false);
    expect(receipt.experimentalImports).toBe(false);
    expect(receipt.reason).toMatch(/not in the CON-06 import matrix/i);
    expect(receipt.reason).toMatch(/not an experimental agent-runtime-contracts consumer/i);
  });

  it("refuses a fake integrated claim", () => {
    const claim = loadJson(fakeIntegratedClaimPath);

    expect(() => refuseIntegratedCon06Claim(claim)).toThrow(Con06IntegratedClaimError);
    expect(() => refuseIntegratedCon06Claim(claim)).toThrow(/NOT_ACTIVATED/);
  });

  it("refuses a NOT_ACTIVATED row that invents a pin or binding", () => {
    const receipt = loadJson(receiptPath);
    if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) {
      throw new Error("receipt must be a JSON object");
    }
    const row = Object.fromEntries(Object.entries(receipt));

    expect(() => refuseIntegratedCon06Claim({ ...row, pin: "invented-pin" })).toThrow(
      /pin must be null/,
    );
    expect(() => refuseIntegratedCon06Claim({ ...row, binding: "invented-binding" })).toThrow(
      /binding must be null/,
    );
  });

  it("keeps workspace package manifests free of agent-runtime-contracts", () => {
    for (const packageJsonPath of workspacePackageJsonPaths) {
      const pkg = loadJson(packageJsonPath);
      if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
        throw new Error(`${packageJsonPath} must be a JSON object`);
      }
      const forbidden = findForbiddenContractDependencies(pkg);
      expect(forbidden, packageJsonPath).toEqual([]);
    }
  });

  it("does not enable experimental agent-runtime-contracts imports in hush-cli source", () => {
    expect(
      findForbiddenContractImportSpecifiers('import x from "agent-runtime-contracts"'),
    ).toEqual(["agent-runtime-contracts"]);

    const lockfile = readFileSync(bunLockPath, "utf8");
    expect(lockfile).not.toMatch(/agent-runtime-contracts/);

    const importHits: string[] = [];
    for (const file of collectSourceFiles(sourceRoot)) {
      const specifiers = findForbiddenContractImportSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        importHits.push(`${file}: ${specifier}`);
      }
    }
    expect(importHits).toEqual([]);
  });
});
