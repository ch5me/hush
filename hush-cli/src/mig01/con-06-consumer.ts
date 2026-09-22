export const CON_06_RECEIPT_RELATIVE_PATH = ".ch5/mig-01-con-06-consumer.json";

export const CON_06_STATUS_NOT_ACTIVATED = "NOT_ACTIVATED" as const;

export const CON_06_FORBIDDEN_CONTRACT_PACKAGES = ["agent-runtime-contracts"] as const;

export type Con06NotActivatedReceipt = {
  schemaVersion: 1;
  program: "ELF-CH5";
  impl: "MIG-01-IMPL-04";
  miss: "MISS-MIG01-08";
  consumer: "hush";
  package: "@chriscode/hush";
  matrix: "CON-06";
  status: typeof CON_06_STATUS_NOT_ACTIVATED;
  pin: null;
  binding: null;
  spend: 0;
  decision: "D08";
  inImportMatrix: false;
  experimentalImports: false;
  reason: string;
  lockfileVocabulary: "ch5-company MIG-01 lockfile";
};

export class Con06IntegratedClaimError extends Error {
  readonly code = "CON06_INTEGRATED_CLAIM_REFUSED" as const;

  constructor(
    message: string,
    readonly claim: unknown,
  ) {
    super(message);
    this.name = "Con06IntegratedClaimError";
  }
}

type JsonRecord = Record<string, unknown>;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const IMPORT_SPECIFIER_PATTERN = /(?:from\s+|import\s*\(|require\s*\(|import\s+)['"]([^'"]+)['"]/g;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(claim: unknown, message: string): never {
  throw new Con06IntegratedClaimError(message, claim);
}

function expectLiteral<T>(claim: JsonRecord, key: string, expected: T): T {
  if (claim[key] !== expected) {
    refuse(
      claim,
      `CON-06 hush consumer receipt ${key} must be ${JSON.stringify(expected)}; refused ${JSON.stringify(claim[key])}.`,
    );
  }
  return expected;
}

export function refuseIntegratedCon06Claim(claim: unknown): Con06NotActivatedReceipt {
  if (!isRecord(claim)) {
    refuse(claim, "CON-06 hush consumer receipt must be an object.");
  }

  if (typeof claim.reason !== "string" || claim.reason.trim() === "") {
    refuse(claim, "CON-06 hush consumer receipt reason must be a non-empty string.");
  }

  return {
    schemaVersion: expectLiteral(claim, "schemaVersion", 1),
    program: expectLiteral(claim, "program", "ELF-CH5"),
    impl: expectLiteral(claim, "impl", "MIG-01-IMPL-04"),
    miss: expectLiteral(claim, "miss", "MISS-MIG01-08"),
    consumer: expectLiteral(claim, "consumer", "hush"),
    package: expectLiteral(claim, "package", "@chriscode/hush"),
    matrix: expectLiteral(claim, "matrix", "CON-06"),
    status: expectLiteral(claim, "status", CON_06_STATUS_NOT_ACTIVATED),
    pin: expectLiteral(claim, "pin", null),
    binding: expectLiteral(claim, "binding", null),
    spend: expectLiteral(claim, "spend", 0),
    decision: expectLiteral(claim, "decision", "D08"),
    inImportMatrix: expectLiteral(claim, "inImportMatrix", false),
    experimentalImports: expectLiteral(claim, "experimentalImports", false),
    reason: claim.reason,
    lockfileVocabulary: expectLiteral(claim, "lockfileVocabulary", "ch5-company MIG-01 lockfile"),
  };
}

export function isForbiddenContractsPackage(name: string): boolean {
  return name === "agent-runtime-contracts" || name.endsWith("/agent-runtime-contracts");
}

export function findForbiddenContractDependencies(pkg: unknown): string[] {
  if (!isRecord(pkg)) {
    throw new TypeError("package.json must be an object");
  }

  const names: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const value = pkg[field];
    if (value === undefined) {
      continue;
    }
    if (!isRecord(value)) {
      continue;
    }
    names.push(...Object.keys(value));
  }

  return [...new Set(names.filter(isForbiddenContractsPackage))].sort();
}

export function findForbiddenContractImportSpecifiers(source: string): string[] {
  const matches = source.matchAll(IMPORT_SPECIFIER_PATTERN);
  const specifiers = new Set<string>();
  for (const match of matches) {
    const specifier = match[1];
    if (specifier === undefined) {
      continue;
    }
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    if (packageName !== undefined && isForbiddenContractsPackage(packageName)) {
      specifiers.add(specifier);
    }
  }
  return [...specifiers].sort();
}
