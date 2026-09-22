import {
  CON_06_STATUS_NOT_ACTIVATED,
  MEDIATION_DENIAL,
  MISS_SEC03_OWNER_UNRESOLVED,
  admit,
  isMediationDenial,
  projectUse,
  refuseInventedVault,
  type AdmissionDecision,
  type MediationDenial,
  type SecretMediationSession,
} from "../sec03/mediation.js";

export const SEC_05_RECEIPT_RELATIVE_PATH = ".ch5/sec-05-isolation.json";

export const SEC_05_TASK = "SEC-05" as const;
export const SEC_05_IMPL = "SEC-05-IMPL-01" as const;
export const SEC_05_GATE = "tenant-data-disclosure-isolation" as const;
export const SEC_05_STATUS_INTERNAL_ONLY = "INTERNAL_ONLY" as const;
export const MISS_SEC05_ISOLATION_UNPROVED = "MISS-SEC05-ISOLATION-UNPROVED" as const;

export const CUSTOMER_RELEASE_BLOCKED = "BLOCKED" as const;
export const PROOF_LABEL_INTERNAL = "internal" as const;

export const FX_SEC05_TENANT_SCOPE_ENFORCED = "FX-SEC05-tenant-scope-enforced" as const;
export const FX_SEC05_AUTH_FAIL_NO_FALLBACK = "FX-SEC05-auth-fail-no-fallback" as const;
export const FX_SEC05_CUSTOMER_RELEASE_BLOCKED = "FX-SEC05-customer-release-blocked" as const;

export const DECLARED_ACCESS_PATHS = ["mediated.admit.use", "mediated.admit.materialize"] as const;

export type IsolationAccessPath = (typeof DECLARED_ACCESS_PATHS)[number];

export const ISOLATION_DENIAL = {
  CUSTOMER_RELEASE_BLOCKED: "CUSTOMER_RELEASE_BLOCKED",
  AUTH_FAIL_NO_FALLBACK: "AUTH_FAIL_NO_FALLBACK",
  FALLBACK_REFUSED: "FALLBACK_REFUSED",
  ACCESS_PATH_NOT_DECLARED: "ACCESS_PATH_NOT_DECLARED",
  TENANT_SCOPE_DENIED: "TENANT_SCOPE_DENIED",
  OWNER_SCOPE_DENIED: "OWNER_SCOPE_DENIED",
  GRANT_SCOPE_DENIED: "GRANT_SCOPE_DENIED",
  INVENTED_VAULT_REFUSED: MEDIATION_DENIAL.INVENTED_VAULT_REFUSED,
  ADAPTER_DISABLED: MEDIATION_DENIAL.ADAPTER_DISABLED,
} as const;

export type IsolationFallbackKind = "local" | "cloud" | "provider" | "broader";

export class IsolationBoundaryError extends Error {
  readonly code: string;

  constructor(
    message: string,
    code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "IsolationBoundaryError";
    this.code = code;
  }
}

export type Sec05IsolationReceipt = {
  schemaVersion: 1;
  program: "ELF-CH5";
  impl: typeof SEC_05_IMPL;
  task: typeof SEC_05_TASK;
  miss: typeof MISS_SEC05_ISOLATION_UNPROVED;
  sec03Miss: typeof MISS_SEC03_OWNER_UNRESOLVED;
  gate: typeof SEC_05_GATE;
  status: typeof SEC_05_STATUS_INTERNAL_ONLY;
  experimental: true;
  internal_only: true;
  proof_label: typeof PROOF_LABEL_INTERNAL;
  customer_release: typeof CUSTOMER_RELEASE_BLOCKED;
  enabled: false;
  spend: 0;
  decision: "D08";
  con06Status: typeof CON_06_STATUS_NOT_ACTIVATED;
  ownership: "unresolved";
  blocker: typeof MISS_SEC05_ISOLATION_UNPROVED;
  reason: string;
};

export type IsolationGrant = {
  owner: string;
  tenant: string;
  destination: string;
  action: string;
  secretRef: string;
  accessPath: IsolationAccessPath;
};

export type IsolationPrincipal = {
  owner: string;
  tenant: string;
  grants: readonly IsolationGrant[];
};

export type IsolationResource = {
  owner: string;
  tenant: string;
  secretRef: string;
};

export type IsolationAuth = { status: "ok" } | { status: "fail"; reason: string };

export type IsolationFallbackAttempt = {
  kind: "local" | "cloud" | "provider";
  credentialRef: string;
};

export type IsolationSession = {
  mediation: SecretMediationSession;
  principal: IsolationPrincipal;
  resource: IsolationResource;
  accessPath: string;
  auth: IsolationAuth;
  declaredAccessPaths: readonly IsolationAccessPath[];
  fallbackAttempts: readonly IsolationFallbackAttempt[];
  broaderCredentials: Readonly<Record<string, string>>;
  customerReleaseClaim: typeof CUSTOMER_RELEASE_BLOCKED | "ALLOWED" | "PUBLIC";
};

export type IsolationPass = {
  ok: true;
  internal_only: true;
  proof_label: typeof PROOF_LABEL_INTERNAL;
  customer_release: typeof CUSTOMER_RELEASE_BLOCKED;
  destination: string;
  action: string;
  secretRef: string;
  owner: string;
  tenant: string;
  accessPath: IsolationAccessPath;
  admitted: true;
  spend: 0;
};

export type IsolationDenial = {
  ok: false;
  code: string;
  reason: string;
  internal_only: true;
  proof_label: typeof PROOF_LABEL_INTERNAL;
  customer_release: typeof CUSTOMER_RELEASE_BLOCKED;
  spend: 0;
  blocker?: typeof MISS_SEC03_OWNER_UNRESOLVED | typeof MISS_SEC05_ISOLATION_UNPROVED;
  destination?: string;
  action?: string;
  secretRef?: string;
  owner?: string;
  tenant?: string;
  accessPath?: string;
  fallbacksRefused?: readonly IsolationFallbackKind[];
};

export type IsolationDecision = IsolationPass | IsolationDenial;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuseReceipt(claim: unknown, message: string): never {
  throw new IsolationBoundaryError(message, "SEC05_RECEIPT_REFUSED", { claim });
}

function expectLiteral<T>(claim: JsonRecord, key: string, expected: T): T {
  if (claim[key] !== expected) {
    refuseReceipt(
      claim,
      `SEC-05 isolation receipt ${key} must be ${JSON.stringify(expected)}; refused ${JSON.stringify(claim[key])}.`,
    );
  }
  return expected;
}

export function refuseCustomerRelease(claim: unknown): Sec05IsolationReceipt {
  if (!isRecord(claim)) {
    refuseReceipt(claim, "SEC-05 isolation receipt must be an object.");
  }

  if (typeof claim.reason !== "string" || claim.reason.trim() === "") {
    refuseReceipt(claim, "SEC-05 isolation receipt reason must be a non-empty string.");
  }

  return {
    schemaVersion: expectLiteral(claim, "schemaVersion", 1),
    program: expectLiteral(claim, "program", "ELF-CH5"),
    impl: expectLiteral(claim, "impl", SEC_05_IMPL),
    task: expectLiteral(claim, "task", SEC_05_TASK),
    miss: expectLiteral(claim, "miss", MISS_SEC05_ISOLATION_UNPROVED),
    sec03Miss: expectLiteral(claim, "sec03Miss", MISS_SEC03_OWNER_UNRESOLVED),
    gate: expectLiteral(claim, "gate", SEC_05_GATE),
    status: expectLiteral(claim, "status", SEC_05_STATUS_INTERNAL_ONLY),
    experimental: expectLiteral(claim, "experimental", true),
    internal_only: expectLiteral(claim, "internal_only", true),
    proof_label: expectLiteral(claim, "proof_label", PROOF_LABEL_INTERNAL),
    customer_release: expectLiteral(claim, "customer_release", CUSTOMER_RELEASE_BLOCKED),
    enabled: expectLiteral(claim, "enabled", false),
    spend: expectLiteral(claim, "spend", 0),
    decision: expectLiteral(claim, "decision", "D08"),
    con06Status: expectLiteral(claim, "con06Status", CON_06_STATUS_NOT_ACTIVATED),
    ownership: expectLiteral(claim, "ownership", "unresolved"),
    blocker: expectLiteral(claim, "blocker", MISS_SEC05_ISOLATION_UNPROVED),
    reason: claim.reason,
  };
}

export function isolationStateFromReceipt(receipt: Sec05IsolationReceipt): {
  experimental: true;
  internal_only: true;
  proof_label: typeof PROOF_LABEL_INTERNAL;
  customer_release: typeof CUSTOMER_RELEASE_BLOCKED;
  enabled: false;
  ownership: "unresolved";
  sec03Miss: typeof MISS_SEC03_OWNER_UNRESOLVED;
} {
  return {
    experimental: true,
    internal_only: receipt.internal_only,
    proof_label: receipt.proof_label,
    customer_release: receipt.customer_release,
    enabled: receipt.enabled,
    ownership: receipt.ownership,
    sec03Miss: receipt.sec03Miss,
  };
}

function deny(
  code: string,
  reason: string,
  extras: Omit<
    IsolationDenial,
    "ok" | "code" | "reason" | "internal_only" | "proof_label" | "customer_release" | "spend"
  > = {},
): IsolationDenial {
  return {
    ok: false,
    code,
    reason,
    internal_only: true,
    proof_label: PROOF_LABEL_INTERNAL,
    customer_release: CUSTOMER_RELEASE_BLOCKED,
    spend: 0,
    ...extras,
  };
}

function fromMediationDenial(denial: MediationDenial): IsolationDenial {
  return deny(denial.code, denial.reason, {
    blocker: denial.blocker,
    destination: denial.destination,
    action: denial.action,
    secretRef: denial.secretRef,
  });
}

export function isDeclaredAccessPath(
  accessPath: string,
  declared: readonly IsolationAccessPath[] = DECLARED_ACCESS_PATHS,
): accessPath is IsolationAccessPath {
  return declared.some((path) => path === accessPath);
}

export function isIsolationDenial(value: object): value is IsolationDenial {
  return "ok" in value && value.ok === false;
}

function refusedFallbackKinds(session: IsolationSession): IsolationFallbackKind[] {
  const kinds: IsolationFallbackKind[] = session.fallbackAttempts.map((attempt) => attempt.kind);
  if (Object.keys(session.broaderCredentials).length > 0) {
    kinds.push("broader");
  }
  return [...new Set(kinds)];
}

function grantMatches(
  grant: IsolationGrant,
  destination: string,
  action: string,
  session: IsolationSession,
  accessPath: IsolationAccessPath,
): boolean {
  return (
    grant.owner === session.principal.owner &&
    grant.tenant === session.principal.tenant &&
    grant.owner === session.resource.owner &&
    grant.tenant === session.resource.tenant &&
    grant.destination === destination &&
    grant.action === action &&
    grant.secretRef === session.resource.secretRef &&
    grant.secretRef === session.mediation.secretRef &&
    grant.accessPath === accessPath
  );
}

/**
 * Isolation gate. Composes SEC-03 admit(destination, action) with
 * owner/tenant/grant scope. Fixture-only; never a customer-release pass.
 */
export function enforceIsolation(
  destination: string,
  action: string,
  session: IsolationSession,
): IsolationDecision {
  if (session.customerReleaseClaim !== CUSTOMER_RELEASE_BLOCKED) {
    return deny(
      ISOLATION_DENIAL.CUSTOMER_RELEASE_BLOCKED,
      "Customer release remains BLOCKED. Internal fixture proof is not a public isolation pass.",
      {
        blocker: MISS_SEC05_ISOLATION_UNPROVED,
        destination,
        action,
        secretRef: session.resource.secretRef,
      },
    );
  }

  if (session.auth.status === "fail") {
    return deny(
      ISOLATION_DENIAL.AUTH_FAIL_NO_FALLBACK,
      "Authentication failure is fail-closed. Local, cloud, and provider credential fallbacks are refused; broader credentials are not consulted.",
      {
        destination,
        action,
        secretRef: session.resource.secretRef,
        owner: session.principal.owner,
        tenant: session.principal.tenant,
        fallbacksRefused: refusedFallbackKinds(session),
      },
    );
  }

  if (session.fallbackAttempts.length > 0 || Object.keys(session.broaderCredentials).length > 0) {
    return deny(
      ISOLATION_DENIAL.FALLBACK_REFUSED,
      "Declared access paths do not include local, cloud, provider, or broader credential fallback.",
      {
        destination,
        action,
        secretRef: session.resource.secretRef,
        fallbacksRefused: refusedFallbackKinds(session),
      },
    );
  }

  const accessPath = session.accessPath;
  if (!isDeclaredAccessPath(accessPath, session.declaredAccessPaths)) {
    return deny(
      ISOLATION_DENIAL.ACCESS_PATH_NOT_DECLARED,
      "Access path is not in the declared supported set.",
      {
        destination,
        action,
        secretRef: session.resource.secretRef,
        accessPath,
      },
    );
  }

  const admission: AdmissionDecision = admit(destination, action, session.mediation);
  if (!admission.ok) {
    return fromMediationDenial(admission);
  }

  if (session.principal.tenant !== session.resource.tenant) {
    return deny(
      ISOLATION_DENIAL.TENANT_SCOPE_DENIED,
      "Principal tenant does not match resource tenant. Cross-tenant disclosure is refused.",
      {
        destination,
        action,
        secretRef: session.resource.secretRef,
        owner: session.principal.owner,
        tenant: session.principal.tenant,
        accessPath,
      },
    );
  }

  if (session.principal.owner !== session.resource.owner) {
    return deny(
      ISOLATION_DENIAL.OWNER_SCOPE_DENIED,
      "Principal owner does not match resource owner.",
      {
        destination,
        action,
        secretRef: session.resource.secretRef,
        owner: session.principal.owner,
        tenant: session.principal.tenant,
        accessPath,
      },
    );
  }

  const granted = session.principal.grants.some((grant) =>
    grantMatches(grant, destination, action, session, accessPath),
  );
  if (!granted) {
    return deny(
      ISOLATION_DENIAL.GRANT_SCOPE_DENIED,
      "No owner/tenant/grant covers this destination, action, secretRef, and access path.",
      {
        destination,
        action,
        secretRef: session.resource.secretRef,
        owner: session.principal.owner,
        tenant: session.principal.tenant,
        accessPath,
      },
    );
  }

  return {
    ok: true,
    internal_only: true,
    proof_label: PROOF_LABEL_INTERNAL,
    customer_release: CUSTOMER_RELEASE_BLOCKED,
    destination: admission.destination,
    action: admission.action,
    secretRef: admission.secretRef,
    owner: session.principal.owner,
    tenant: session.principal.tenant,
    accessPath,
    admitted: true,
    spend: 0,
  };
}

export function discloseUse(
  destination: string,
  action: string,
  session: IsolationSession,
): IsolationDecision {
  const isolated = enforceIsolation(destination, action, session);
  if (!isolated.ok) {
    return isolated;
  }

  const projection = projectUse(
    {
      ok: true,
      destination: isolated.destination,
      action: isolated.action,
      secretRef: isolated.secretRef,
    },
    session.mediation,
  );
  if (isMediationDenial(projection)) {
    return fromMediationDenial(projection);
  }

  return isolated;
}

export function keepMediationDisabledPathHonest(): IsolationDenial {
  const invented = refuseInventedVault();
  return fromMediationDenial(invented);
}
