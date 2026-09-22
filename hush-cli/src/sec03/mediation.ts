export const SEC_03_RECEIPT_RELATIVE_PATH = ".ch5/sec-03-mediation.json";

export const SEC_03_TASK = "SEC-03" as const;
export const SEC_03_IMPL = "SEC-03-IMPL-01" as const;
export const SEC_03_ADAPTER = "secret-mediation" as const;
export const SEC_03_STATUS_DISABLED = "DISABLED" as const;
export const MISS_SEC03_OWNER_UNRESOLVED = "MISS-SEC03-OWNER-UNRESOLVED" as const;
export const CON_06_STATUS_NOT_ACTIVATED = "NOT_ACTIVATED" as const;

export const FX_SEC03_ADVERSARY_NO_SECRET = "FX-SEC03-adversary-no-secret" as const;
export const FX_SEC03_HIDE_NOT_AUTHORIZE = "FX-SEC03-hide-not-authorize" as const;
export const FX_SEC03_UNRESOLVED_OWNER_DISABLED = "FX-SEC03-unresolved-owner-disabled" as const;

export const SEC02_USE_PROJECTION_KIND = "sec02.use_projection" as const;

export const MEDIATION_DENIAL = {
  ADAPTER_DISABLED: "MEDIATION_ADAPTER_DISABLED",
  OWNER_UNRESOLVED: MISS_SEC03_OWNER_UNRESOLVED,
  ADMIT_REQUIRED: "ADMIT_REQUIRED",
  DESTINATION_ACTION_NOT_ADMITTED: "DESTINATION_ACTION_NOT_ADMITTED",
  HIDE_IS_NOT_AUTHORIZE: "HIDE_IS_NOT_AUTHORIZE",
  WORKER_SECRET_REFUSED: "WORKER_SECRET_REFUSED",
  INVENTED_VAULT_REFUSED: "INVENTED_VAULT_REFUSED",
  ADMISSION_MISMATCH: "ADMISSION_MISMATCH",
} as const;

export class MediationBoundaryError extends Error {
  readonly code: string;

  constructor(
    message: string,
    code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MediationBoundaryError";
    this.code = code;
  }
}

export type Sec03DisabledReceipt = {
  schemaVersion: 1;
  program: "ELF-CH5";
  impl: typeof SEC_03_IMPL;
  task: typeof SEC_03_TASK;
  miss: typeof MISS_SEC03_OWNER_UNRESOLVED;
  adapter: typeof SEC_03_ADAPTER;
  status: typeof SEC_03_STATUS_DISABLED;
  experimental: true;
  defaultOff: true;
  enabled: false;
  spend: 0;
  decision: "D08";
  con06Status: typeof CON_06_STATUS_NOT_ACTIVATED;
  ownership: "unresolved";
  blocker: typeof MISS_SEC03_OWNER_UNRESOLVED;
  reason: string;
};

/**
 * Local experimental stand-in for a SEC-02 use-projection receipt.
 * SEC-02 shapes are not present in this repository; this type is self-contained
 * and carries no secret material.
 */
export type Sec02UseProjectionReceipt = {
  schemaVersion: 1;
  kind: typeof SEC02_USE_PROJECTION_KIND;
  destination: string;
  action: string;
  secretRef: string;
  admitted: true;
  materialPresent: false;
  spend: 0;
};

export type MediationGrant = {
  destination: string;
  action: string;
  secretRef: string;
};

export type ResolvedMediationOwnership = {
  status: "resolved";
  owner: string;
};

export type UnresolvedMediationOwnership = {
  status: "unresolved";
  blocker: typeof MISS_SEC03_OWNER_UNRESOLVED;
  reason: string;
};

export type MediationOwnership = ResolvedMediationOwnership | UnresolvedMediationOwnership;

export type MediationAdapterState = {
  experimental: true;
  defaultOff: boolean;
  enabled: boolean;
  ownership: MediationOwnership;
};

export type HiddenCredentialView = {
  secretRef: string;
  hidden: true;
  masked: "********";
};

export type Admission = {
  ok: true;
  destination: string;
  action: string;
  secretRef: string;
};

export type MediationDenial = {
  ok: false;
  code: string;
  reason: string;
  blocker?: typeof MISS_SEC03_OWNER_UNRESOLVED;
  destination?: string;
  action?: string;
  secretRef?: string;
};

export type AdmissionDecision = Admission | MediationDenial;

export type MediationVault = {
  /** Test-only fake tokens keyed by secretRef. Never returned to workers. */
  secrets: Readonly<Record<string, string>>;
};

export type SecretMediationSession = {
  actor: "worker" | "adversary" | "sink";
  secretRef: string;
  adapter: MediationAdapterState;
  policy: readonly MediationGrant[];
  vault: MediationVault;
};

export type MediatedSinkEffect = {
  destination: string;
  action: string;
  secretRef: string;
  applied: true;
  workerVisible: Sec02UseProjectionReceipt;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuseReceipt(claim: unknown, message: string): never {
  throw new MediationBoundaryError(message, "SEC03_RECEIPT_REFUSED", { claim });
}

function expectLiteral<T>(claim: JsonRecord, key: string, expected: T): T {
  if (claim[key] !== expected) {
    refuseReceipt(
      claim,
      `SEC-03 mediation receipt ${key} must be ${JSON.stringify(expected)}; refused ${JSON.stringify(claim[key])}.`,
    );
  }
  return expected;
}

export function refuseEnabledMediationWithoutOwner(claim: unknown): Sec03DisabledReceipt {
  if (!isRecord(claim)) {
    refuseReceipt(claim, "SEC-03 mediation receipt must be an object.");
  }

  if (typeof claim.reason !== "string" || claim.reason.trim() === "") {
    refuseReceipt(claim, "SEC-03 mediation receipt reason must be a non-empty string.");
  }

  return {
    schemaVersion: expectLiteral(claim, "schemaVersion", 1),
    program: expectLiteral(claim, "program", "ELF-CH5"),
    impl: expectLiteral(claim, "impl", SEC_03_IMPL),
    task: expectLiteral(claim, "task", SEC_03_TASK),
    miss: expectLiteral(claim, "miss", MISS_SEC03_OWNER_UNRESOLVED),
    adapter: expectLiteral(claim, "adapter", SEC_03_ADAPTER),
    status: expectLiteral(claim, "status", SEC_03_STATUS_DISABLED),
    experimental: expectLiteral(claim, "experimental", true),
    defaultOff: expectLiteral(claim, "defaultOff", true),
    enabled: expectLiteral(claim, "enabled", false),
    spend: expectLiteral(claim, "spend", 0),
    decision: expectLiteral(claim, "decision", "D08"),
    con06Status: expectLiteral(claim, "con06Status", CON_06_STATUS_NOT_ACTIVATED),
    ownership: expectLiteral(claim, "ownership", "unresolved"),
    blocker: expectLiteral(claim, "blocker", MISS_SEC03_OWNER_UNRESOLVED),
    reason: claim.reason,
  };
}

export function adapterStateFromReceipt(receipt: Sec03DisabledReceipt): MediationAdapterState {
  return {
    experimental: true,
    defaultOff: receipt.defaultOff,
    enabled: receipt.enabled,
    ownership: {
      status: "unresolved",
      blocker: MISS_SEC03_OWNER_UNRESOLVED,
      reason: receipt.reason,
    },
  };
}

export function evaluateMediationAdapter(adapter: MediationAdapterState): MediationDenial | null {
  if (adapter.ownership.status === "unresolved") {
    return {
      ok: false,
      code: MEDIATION_DENIAL.ADAPTER_DISABLED,
      blocker: MISS_SEC03_OWNER_UNRESOLVED,
      reason: adapter.ownership.reason,
    };
  }

  if (!adapter.enabled) {
    return {
      ok: false,
      code: MEDIATION_DENIAL.ADAPTER_DISABLED,
      reason: "Secret-mediation adapter is experimental and default-off.",
    };
  }

  return null;
}

export function refuseInventedVault(): MediationDenial {
  return {
    ok: false,
    code: MEDIATION_DENIAL.INVENTED_VAULT_REFUSED,
    blocker: MISS_SEC03_OWNER_UNRESOLVED,
    reason:
      "Ownership of the secret-mediation adapter is unresolved. Hush remains the existing vault; a substitute vault is refused.",
  };
}

function deny(
  code: string,
  reason: string,
  extras: Omit<MediationDenial, "ok" | "code" | "reason"> = {},
): MediationDenial {
  return { ok: false, code, reason, ...extras };
}

function requireEnabledAdapter(session: SecretMediationSession): MediationDenial | null {
  if (session.adapter.ownership.status === "unresolved") {
    return deny(MEDIATION_DENIAL.ADAPTER_DISABLED, session.adapter.ownership.reason, {
      blocker: MISS_SEC03_OWNER_UNRESOLVED,
    });
  }
  if (!session.adapter.enabled) {
    return deny(
      MEDIATION_DENIAL.ADAPTER_DISABLED,
      "Secret-mediation adapter is experimental and default-off.",
    );
  }
  return null;
}

/**
 * Mediation gate. Destination and action must be admitted before any secret
 * materialization or use projection.
 */
export function admit(
  destination: string,
  action: string,
  session: SecretMediationSession,
): AdmissionDecision {
  const disabled = requireEnabledAdapter(session);
  if (disabled) {
    return { ...disabled, destination, action, secretRef: session.secretRef };
  }

  if (destination.trim() === "" || action.trim() === "") {
    return deny(MEDIATION_DENIAL.ADMIT_REQUIRED, "admit(destination, action) is required.", {
      destination,
      action,
      secretRef: session.secretRef,
    });
  }

  const granted = session.policy.some(
    (grant) =>
      grant.destination === destination &&
      grant.action === action &&
      grant.secretRef === session.secretRef,
  );
  if (!granted) {
    return deny(
      MEDIATION_DENIAL.DESTINATION_ACTION_NOT_ADMITTED,
      "Destination/action is not admitted for this secretRef.",
      { destination, action, secretRef: session.secretRef },
    );
  }

  return {
    ok: true,
    destination,
    action,
    secretRef: session.secretRef,
  };
}

export function isMediationDenial(value: object): value is MediationDenial {
  return "ok" in value && value.ok === false;
}

function requireAdmission(
  admission: AdmissionDecision,
  session: SecretMediationSession,
): MediationDenial | Admission {
  if (!admission.ok) {
    return admission;
  }
  if (admission.secretRef !== session.secretRef) {
    return deny(
      MEDIATION_DENIAL.ADMISSION_MISMATCH,
      "Admission secretRef does not match the mediation session.",
      { secretRef: session.secretRef },
    );
  }
  return admit(admission.destination, admission.action, session);
}

export function projectUse(
  admission: AdmissionDecision | null,
  session: SecretMediationSession,
): Sec02UseProjectionReceipt | MediationDenial {
  const disabled = requireEnabledAdapter(session);
  if (disabled) {
    return disabled;
  }

  if (admission === null) {
    return deny(
      MEDIATION_DENIAL.ADMIT_REQUIRED,
      "admit(destination, action) is required before use projection.",
      { secretRef: session.secretRef },
    );
  }

  const admitted = requireAdmission(admission, session);
  if (!admitted.ok) {
    if (admitted.code === MEDIATION_DENIAL.ADMISSION_MISMATCH) {
      return admitted;
    }
    return deny(
      MEDIATION_DENIAL.ADMIT_REQUIRED,
      "admit(destination, action) is required before use projection.",
      {
        secretRef: session.secretRef,
        destination: admitted.destination,
        action: admitted.action,
      },
    );
  }

  return {
    schemaVersion: 1,
    kind: SEC02_USE_PROJECTION_KIND,
    destination: admitted.destination,
    action: admitted.action,
    secretRef: admitted.secretRef,
    admitted: true,
    materialPresent: false,
    spend: 0,
  };
}

export function materializeUse(
  admission: AdmissionDecision | null,
  session: SecretMediationSession,
): MediatedSinkEffect | MediationDenial {
  const disabled = requireEnabledAdapter(session);
  if (disabled) {
    return disabled;
  }

  if (admission === null) {
    return deny(
      MEDIATION_DENIAL.ADMIT_REQUIRED,
      "admit(destination, action) is required before secret materialization.",
      { secretRef: session.secretRef },
    );
  }

  const admitted = requireAdmission(admission, session);
  if (!admitted.ok) {
    if (admitted.code === MEDIATION_DENIAL.ADMISSION_MISMATCH) {
      return admitted;
    }
    return deny(
      MEDIATION_DENIAL.ADMIT_REQUIRED,
      "admit(destination, action) is required before secret materialization.",
      {
        secretRef: session.secretRef,
        destination: admitted.destination,
        action: admitted.action,
      },
    );
  }

  const vaultMaterial = session.vault.secrets[admitted.secretRef];
  if (typeof vaultMaterial !== "string" || vaultMaterial.length === 0) {
    return deny(
      MEDIATION_DENIAL.DESTINATION_ACTION_NOT_ADMITTED,
      "No vault material exists for this secretRef.",
      { secretRef: admitted.secretRef },
    );
  }

  const projection = projectUse(admitted, session);
  if (isMediationDenial(projection)) {
    return projection;
  }

  return {
    destination: admitted.destination,
    action: admitted.action,
    secretRef: admitted.secretRef,
    applied: true,
    workerVisible: projection,
  };
}

export function requestRawSecret(session: SecretMediationSession): MediationDenial {
  return deny(
    MEDIATION_DENIAL.WORKER_SECRET_REFUSED,
    "Workers and adversaries cannot obtain secret material. Use admit(destination, action) then a use projection.",
    { secretRef: session.secretRef },
  );
}

export function hideCredential(secretRef: string): HiddenCredentialView {
  return {
    secretRef,
    hidden: true,
    masked: "********",
  };
}

export function authorizeFromHiddenCredential(
  view: HiddenCredentialView,
  destination: string,
  action: string,
): MediationDenial {
  return deny(
    MEDIATION_DENIAL.HIDE_IS_NOT_AUTHORIZE,
    "Credential hiding is confidentiality, not authorization of arbitrary service effects.",
    { destination, action, secretRef: view.secretRef },
  );
}

export function workerVisiblePayload(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

export function collectSecretLeaks(visible: unknown, vault: MediationVault): string[] {
  const serialized = JSON.stringify(visible);
  return Object.values(vault.secrets).filter((token) => token !== "" && serialized.includes(token));
}
