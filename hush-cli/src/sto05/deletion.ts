import { CON_06_STATUS_NOT_ACTIVATED, MISS_SEC03_OWNER_UNRESOLVED } from "../sec03/mediation.js";
import {
  CUSTOMER_RELEASE_BLOCKED,
  ISOLATION_DENIAL,
  MISS_SEC05_ISOLATION_UNPROVED,
  PROOF_LABEL_INTERNAL,
} from "../sec05/isolation.js";

export const STO_05_RECEIPT_RELATIVE_PATH = ".ch5/sto-05-deletion.json";

export const STO_05_TASK = "STO-05" as const;
export const STO_05_IMPL = "STO-05-IMPL-01" as const;
export const STO_05_GATE = "scoped-deletion-recovery" as const;
export const STO_05_STATUS_DISABLED = "DISABLED" as const;

export const MISS_STO05_COMPLETE_WIPE_UNPROVED = "MISS-STO05-COMPLETE-WIPE-UNPROVED" as const;
export const MISS_STO05_OUTSTANDING_COPIES_UNERASED =
  "MISS-STO05-OUTSTANDING-COPIES-UNERASED" as const;
export const MISS_STO05_EXTERNAL_EFFECTS_UNERASED = "MISS-STO05-EXTERNAL-EFFECTS-UNERASED" as const;
export const MISS_STO05_INDEPENDENT_EXPORTS_UNERASED =
  "MISS-STO05-INDEPENDENT-EXPORTS-UNERASED" as const;

export const STO_05_GAPS = [
  MISS_STO05_COMPLETE_WIPE_UNPROVED,
  MISS_STO05_OUTSTANDING_COPIES_UNERASED,
  MISS_STO05_EXTERNAL_EFFECTS_UNERASED,
  MISS_STO05_INDEPENDENT_EXPORTS_UNERASED,
] as const;

export const FX_STO05_HONEST_DELETION_RECEIPT = "FX-STO05-honest-deletion-receipt" as const;
export const FX_STO05_NO_ERASE_EXPORTS_PROMISE = "FX-STO05-no-erase-exports-promise" as const;
export const FX_STO05_BLANKET_DELETE_REFUSED = "FX-STO05-blanket-delete-refused" as const;

export const FAKE_STORE_PATH_PREFIX = "fixture://sto05/" as const;

export const DELETION_DENIAL = {
  BLANKET_DELETE_REFUSED: "BLANKET_DELETE_REFUSED",
  LEGACY_MIGRATION_REFUSED: "LEGACY_MIGRATION_REFUSED",
  EXPORT_ERASE_PROMISE_REFUSED: "EXPORT_ERASE_PROMISE_REFUSED",
  EXTERNAL_EFFECT_ERASE_PROMISE_REFUSED: "EXTERNAL_EFFECT_ERASE_PROMISE_REFUSED",
  LIVE_DELETE_REFUSED: "LIVE_DELETE_REFUSED",
  REAL_PATH_REFUSED: "REAL_PATH_REFUSED",
  ADAPTER_DISABLED: "STO05_ADAPTER_DISABLED",
  CUSTOMER_RELEASE_BLOCKED: ISOLATION_DENIAL.CUSTOMER_RELEASE_BLOCKED,
  TENANT_SCOPE_DENIED: ISOLATION_DENIAL.TENANT_SCOPE_DENIED,
  OWNER_SCOPE_DENIED: ISOLATION_DENIAL.OWNER_SCOPE_DENIED,
} as const;

export class DeletionBoundaryError extends Error {
  readonly code: string;

  constructor(
    message: string,
    code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DeletionBoundaryError";
    this.code = code;
  }
}

export type VerifiedStore = {
  id: string;
  path: string;
  owner: string;
  tenant: string;
  verified: true;
};

export type OutstandingCopy = {
  id: string;
  path: string;
  reason: string;
  unverified: true;
};

export type ExternalEffectNotErased = {
  id: string;
  destination: string;
  completed: true;
  erased: false;
};

export type IndependentExportNotClaimed = {
  id: string;
  path: string;
  claimedErased: false;
};

export type Sto05DisabledReceipt = {
  schemaVersion: 1;
  program: "ELF-CH5";
  impl: typeof STO_05_IMPL;
  task: typeof STO_05_TASK;
  miss: typeof MISS_STO05_COMPLETE_WIPE_UNPROVED;
  gaps: typeof STO_05_GAPS;
  sec05Miss: typeof MISS_SEC05_ISOLATION_UNPROVED;
  sec03Miss: typeof MISS_SEC03_OWNER_UNRESOLVED;
  gate: typeof STO_05_GATE;
  status: typeof STO_05_STATUS_DISABLED;
  experimental: true;
  defaultOff: true;
  enabled: false;
  internal_only: true;
  proof_label: typeof PROOF_LABEL_INTERNAL;
  customer_release: typeof CUSTOMER_RELEASE_BLOCKED;
  spend: 0;
  decision: "D08";
  con06Status: typeof CON_06_STATUS_NOT_ACTIVATED;
  completeWipe: false;
  liveDelete: false;
  blanketDelete: false;
  legacyMigration: false;
  verifiedStores: [];
  outstandingCopies: [];
  externalEffectsNotErased: [];
  independentExportsNotClaimed: [];
  blocker: typeof MISS_STO05_COMPLETE_WIPE_UNPROVED;
  reason: string;
};

export type ScopedDeletionReceipt = {
  schemaVersion: 1;
  kind: "sto05.scoped_deletion";
  task: typeof STO_05_TASK;
  experimental: true;
  defaultOff: true;
  enabled: false;
  liveDelete: false;
  completeWipe: false;
  blanketDelete: false;
  legacyMigration: false;
  spend: 0;
  owner: string;
  tenant: string;
  verifiedStores: VerifiedStore[];
  outstandingCopies: OutstandingCopy[];
  externalEffectsNotErased: ExternalEffectNotErased[];
  independentExportsNotClaimed: IndependentExportNotClaimed[];
  miss: typeof MISS_STO05_COMPLETE_WIPE_UNPROVED;
  gaps: typeof STO_05_GAPS;
  customer_release: typeof CUSTOMER_RELEASE_BLOCKED;
  internal_only: true;
  proof_label: typeof PROOF_LABEL_INTERNAL;
};

export type ScopedRecoveryReceipt = {
  schemaVersion: 1;
  kind: "sto05.scoped_recovery";
  task: typeof STO_05_TASK;
  experimental: true;
  defaultOff: true;
  enabled: false;
  liveDelete: false;
  completeRestore: false;
  spend: 0;
  owner: string;
  tenant: string;
  verifiedStores: VerifiedStore[];
  recoveredStoreIds: string[];
  outstandingCopiesNotRecovered: OutstandingCopy[];
  independentExportsNotRecovered: IndependentExportNotClaimed[];
  miss: typeof MISS_STO05_COMPLETE_WIPE_UNPROVED;
  gaps: typeof STO_05_GAPS;
  customer_release: typeof CUSTOMER_RELEASE_BLOCKED;
  internal_only: true;
  proof_label: typeof PROOF_LABEL_INTERNAL;
};

export type StoreCandidate = {
  id: string;
  path: string;
  owner: string;
  tenant: string;
  claimedVerified: boolean;
};

export type OutstandingCopyInput = {
  id: string;
  path: string;
  reason: string;
};

export type ExternalEffectInput = {
  id: string;
  destination: string;
  completed: true;
};

export type IndependentExportInput = {
  id: string;
  path: string;
};

export type DeletionPrincipal = {
  owner: string;
  tenant: string;
};

export type DeletionMode = "scoped" | "blanket" | "legacy-migration";

export type DeletionSession = {
  mode: DeletionMode;
  principal: DeletionPrincipal;
  stores: readonly StoreCandidate[];
  outstandingCopies: readonly OutstandingCopyInput[];
  externalEffects: readonly ExternalEffectInput[];
  independentExports: readonly IndependentExportInput[];
  claimedCompleteWipe: boolean;
  claimedEraseIndependentExports: boolean;
  claimedEraseExternalEffects: boolean;
  liveDelete: boolean;
  enabled: boolean;
  customerReleaseClaim: typeof CUSTOMER_RELEASE_BLOCKED | "ALLOWED" | "PUBLIC";
  recoveryTargets?: readonly string[];
};

export type DeletionDenial = {
  ok: false;
  code: string;
  reason: string;
  experimental: true;
  defaultOff: true;
  enabled: false;
  liveDelete: false;
  completeWipe: false;
  spend: 0;
  internal_only: true;
  proof_label: typeof PROOF_LABEL_INTERNAL;
  customer_release: typeof CUSTOMER_RELEASE_BLOCKED;
  blocker?:
    | typeof MISS_STO05_COMPLETE_WIPE_UNPROVED
    | typeof MISS_SEC05_ISOLATION_UNPROVED
    | typeof MISS_STO05_INDEPENDENT_EXPORTS_UNERASED
    | typeof MISS_STO05_EXTERNAL_EFFECTS_UNERASED;
  owner?: string;
  tenant?: string;
};

export type DeletionPass = ScopedDeletionReceipt & { ok: true };
export type RecoveryPass = ScopedRecoveryReceipt & { ok: true };
export type DeletionDecision = DeletionPass | DeletionDenial;
export type RecoveryDecision = RecoveryPass | DeletionDenial;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuseReceipt(claim: unknown, message: string): never {
  throw new DeletionBoundaryError(message, "STO05_RECEIPT_REFUSED", { claim });
}

function expectLiteral<T>(claim: JsonRecord, key: string, expected: T): T {
  if (claim[key] !== expected) {
    refuseReceipt(
      claim,
      `STO-05 deletion receipt ${key} must be ${JSON.stringify(expected)}; refused ${JSON.stringify(claim[key])}.`,
    );
  }
  return expected;
}

function expectEmptyArray(claim: JsonRecord, key: string): [] {
  const value = claim[key];
  if (!Array.isArray(value) || value.length !== 0) {
    refuseReceipt(
      claim,
      `STO-05 deletion receipt ${key} must be an empty array; refused ${JSON.stringify(value)}.`,
    );
  }
  return [];
}

function expectGaps(claim: JsonRecord): typeof STO_05_GAPS {
  const value = claim.gaps;
  if (!Array.isArray(value) || value.length !== STO_05_GAPS.length) {
    refuseReceipt(claim, "STO-05 deletion receipt gaps must list the four MISS-STO05 blockers.");
  }
  for (let index = 0; index < STO_05_GAPS.length; index += 1) {
    if (value[index] !== STO_05_GAPS[index]) {
      refuseReceipt(
        claim,
        `STO-05 deletion receipt gaps[${index}] must be ${JSON.stringify(STO_05_GAPS[index])}; refused ${JSON.stringify(value[index])}.`,
      );
    }
  }
  return STO_05_GAPS;
}

export function refuseCompleteWipe(claim: unknown): Sto05DisabledReceipt {
  if (!isRecord(claim)) {
    refuseReceipt(claim, "STO-05 deletion receipt must be an object.");
  }

  if (typeof claim.reason !== "string" || claim.reason.trim() === "") {
    refuseReceipt(claim, "STO-05 deletion receipt reason must be a non-empty string.");
  }

  return {
    schemaVersion: expectLiteral(claim, "schemaVersion", 1),
    program: expectLiteral(claim, "program", "ELF-CH5"),
    impl: expectLiteral(claim, "impl", STO_05_IMPL),
    task: expectLiteral(claim, "task", STO_05_TASK),
    miss: expectLiteral(claim, "miss", MISS_STO05_COMPLETE_WIPE_UNPROVED),
    gaps: expectGaps(claim),
    sec05Miss: expectLiteral(claim, "sec05Miss", MISS_SEC05_ISOLATION_UNPROVED),
    sec03Miss: expectLiteral(claim, "sec03Miss", MISS_SEC03_OWNER_UNRESOLVED),
    gate: expectLiteral(claim, "gate", STO_05_GATE),
    status: expectLiteral(claim, "status", STO_05_STATUS_DISABLED),
    experimental: expectLiteral(claim, "experimental", true),
    defaultOff: expectLiteral(claim, "defaultOff", true),
    enabled: expectLiteral(claim, "enabled", false),
    internal_only: expectLiteral(claim, "internal_only", true),
    proof_label: expectLiteral(claim, "proof_label", PROOF_LABEL_INTERNAL),
    customer_release: expectLiteral(claim, "customer_release", CUSTOMER_RELEASE_BLOCKED),
    spend: expectLiteral(claim, "spend", 0),
    decision: expectLiteral(claim, "decision", "D08"),
    con06Status: expectLiteral(claim, "con06Status", CON_06_STATUS_NOT_ACTIVATED),
    completeWipe: expectLiteral(claim, "completeWipe", false),
    liveDelete: expectLiteral(claim, "liveDelete", false),
    blanketDelete: expectLiteral(claim, "blanketDelete", false),
    legacyMigration: expectLiteral(claim, "legacyMigration", false),
    verifiedStores: expectEmptyArray(claim, "verifiedStores"),
    outstandingCopies: expectEmptyArray(claim, "outstandingCopies"),
    externalEffectsNotErased: expectEmptyArray(claim, "externalEffectsNotErased"),
    independentExportsNotClaimed: expectEmptyArray(claim, "independentExportsNotClaimed"),
    blocker: expectLiteral(claim, "blocker", MISS_STO05_COMPLETE_WIPE_UNPROVED),
    reason: claim.reason,
  };
}

export function deletionStateFromReceipt(receipt: Sto05DisabledReceipt): {
  experimental: true;
  defaultOff: true;
  enabled: false;
  completeWipe: false;
  liveDelete: false;
  blanketDelete: false;
  legacyMigration: false;
  customer_release: typeof CUSTOMER_RELEASE_BLOCKED;
  sec05Miss: typeof MISS_SEC05_ISOLATION_UNPROVED;
} {
  return {
    experimental: true,
    defaultOff: receipt.defaultOff,
    enabled: receipt.enabled,
    completeWipe: receipt.completeWipe,
    liveDelete: receipt.liveDelete,
    blanketDelete: receipt.blanketDelete,
    legacyMigration: receipt.legacyMigration,
    customer_release: receipt.customer_release,
    sec05Miss: receipt.sec05Miss,
  };
}

function deny(
  code: string,
  reason: string,
  extras: Omit<
    DeletionDenial,
    | "ok"
    | "code"
    | "reason"
    | "experimental"
    | "defaultOff"
    | "enabled"
    | "liveDelete"
    | "completeWipe"
    | "spend"
    | "internal_only"
    | "proof_label"
    | "customer_release"
  > = {},
): DeletionDenial {
  return {
    ok: false,
    code,
    reason,
    experimental: true,
    defaultOff: true,
    enabled: false,
    liveDelete: false,
    completeWipe: false,
    spend: 0,
    internal_only: true,
    proof_label: PROOF_LABEL_INTERNAL,
    customer_release: CUSTOMER_RELEASE_BLOCKED,
    ...extras,
  };
}

export function isFakeStorePath(path: string): boolean {
  return path.startsWith(FAKE_STORE_PATH_PREFIX);
}

export function isDeletionDenial(value: object): value is DeletionDenial {
  return "ok" in value && value.ok === false;
}

function sessionScope(session: DeletionSession): Pick<DeletionDenial, "owner" | "tenant"> {
  return { owner: session.principal.owner, tenant: session.principal.tenant };
}

export function refuseLiveDelete(): DeletionDenial {
  return deny(
    DELETION_DENIAL.LIVE_DELETE_REFUSED,
    "STO-05 does not perform live deletion. Fake fixture paths only; complete wipe is unproved.",
    { blocker: MISS_STO05_COMPLETE_WIPE_UNPROVED },
  );
}

function collectPaths(session: DeletionSession): string[] {
  return [
    ...session.stores.map((store) => store.path),
    ...session.outstandingCopies.map((copy) => copy.path),
    ...session.independentExports.map((exported) => exported.path),
  ];
}

function evaluateMutationClaim(session: DeletionSession): DeletionDenial | null {
  if (session.customerReleaseClaim !== CUSTOMER_RELEASE_BLOCKED) {
    return deny(
      DELETION_DENIAL.CUSTOMER_RELEASE_BLOCKED,
      "Customer release remains BLOCKED. Internal fixture proof is not a public deletion pass.",
      { blocker: MISS_SEC05_ISOLATION_UNPROVED, ...sessionScope(session) },
    );
  }

  if (session.enabled) {
    return deny(
      DELETION_DENIAL.ADAPTER_DISABLED,
      "Scoped deletion/recovery is experimental and default-off. Enabling live mutation is refused.",
      { blocker: MISS_STO05_COMPLETE_WIPE_UNPROVED, ...sessionScope(session) },
    );
  }

  if (session.liveDelete) {
    return {
      ...refuseLiveDelete(),
      ...sessionScope(session),
    };
  }

  if (session.mode === "blanket" || session.claimedCompleteWipe) {
    return deny(
      DELETION_DENIAL.BLANKET_DELETE_REFUSED,
      "Blanket deletion and complete-wipe claims are refused. STO-05 authorizes scoped receipts only.",
      { blocker: MISS_STO05_COMPLETE_WIPE_UNPROVED, ...sessionScope(session) },
    );
  }

  if (session.mode === "legacy-migration") {
    return deny(
      DELETION_DENIAL.LEGACY_MIGRATION_REFUSED,
      "Legacy migration is not authorized by STO-05. No broad data migration is performed.",
      { blocker: MISS_STO05_COMPLETE_WIPE_UNPROVED, ...sessionScope(session) },
    );
  }

  if (session.claimedEraseIndependentExports) {
    return deny(
      DELETION_DENIAL.EXPORT_ERASE_PROMISE_REFUSED,
      "Independent user exports are not claimed erased. STO-05 does not promise to erase them.",
      { blocker: MISS_STO05_INDEPENDENT_EXPORTS_UNERASED, ...sessionScope(session) },
    );
  }

  if (session.claimedEraseExternalEffects) {
    return deny(
      DELETION_DENIAL.EXTERNAL_EFFECT_ERASE_PROMISE_REFUSED,
      "Already-completed external effects are not erased. STO-05 does not promise to reverse them.",
      { blocker: MISS_STO05_EXTERNAL_EFFECTS_UNERASED, ...sessionScope(session) },
    );
  }

  const realPath = collectPaths(session).find((path) => !isFakeStorePath(path));
  if (realPath !== undefined) {
    return deny(
      DELETION_DENIAL.REAL_PATH_REFUSED,
      "Only fixture://sto05/ paths are accepted. Real store paths and live deletes are refused.",
      { blocker: MISS_STO05_COMPLETE_WIPE_UNPROVED, ...sessionScope(session) },
    );
  }

  return null;
}

function verifyStores(session: DeletionSession): {
  verifiedStores: VerifiedStore[];
  outstandingCopies: OutstandingCopy[];
} {
  const verifiedStores: VerifiedStore[] = [];
  const outstandingCopies: OutstandingCopy[] = session.outstandingCopies.map((copy) => ({
    id: copy.id,
    path: copy.path,
    reason: copy.reason,
    unverified: true,
  }));

  for (const store of session.stores) {
    if (!store.claimedVerified) {
      outstandingCopies.push({
        id: store.id,
        path: store.path,
        reason: "Store was not verified; listed as an outstanding copy.",
        unverified: true,
      });
      continue;
    }

    if (store.tenant !== session.principal.tenant) {
      outstandingCopies.push({
        id: store.id,
        path: store.path,
        reason: "Principal tenant does not match store tenant. Cross-tenant deletion is refused.",
        unverified: true,
      });
      continue;
    }

    if (store.owner !== session.principal.owner) {
      outstandingCopies.push({
        id: store.id,
        path: store.path,
        reason: "Principal owner does not match store owner. Cross-owner deletion is refused.",
        unverified: true,
      });
      continue;
    }

    verifiedStores.push({
      id: store.id,
      path: store.path,
      owner: store.owner,
      tenant: store.tenant,
      verified: true,
    });
  }

  return { verifiedStores, outstandingCopies };
}

function mapExternalEffects(session: DeletionSession): ExternalEffectNotErased[] {
  return session.externalEffects.map((effect) => ({
    id: effect.id,
    destination: effect.destination,
    completed: true,
    erased: false,
  }));
}

function mapIndependentExports(session: DeletionSession): IndependentExportNotClaimed[] {
  return session.independentExports.map((exported) => ({
    id: exported.id,
    path: exported.path,
    claimedErased: false,
  }));
}

/**
 * Scoped deletion receipt. Lists verified stores and outstanding copies
 * honestly. Never deletes, never promises a complete wipe, and never claims
 * independent exports or completed external effects were erased.
 */
export function issueScopedDeletion(session: DeletionSession): DeletionDecision {
  const refused = evaluateMutationClaim(session);
  if (refused) {
    return refused;
  }

  const { verifiedStores, outstandingCopies } = verifyStores(session);

  return {
    ok: true,
    schemaVersion: 1,
    kind: "sto05.scoped_deletion",
    task: STO_05_TASK,
    experimental: true,
    defaultOff: true,
    enabled: false,
    liveDelete: false,
    completeWipe: false,
    blanketDelete: false,
    legacyMigration: false,
    spend: 0,
    owner: session.principal.owner,
    tenant: session.principal.tenant,
    verifiedStores,
    outstandingCopies,
    externalEffectsNotErased: mapExternalEffects(session),
    independentExportsNotClaimed: mapIndependentExports(session),
    miss: MISS_STO05_COMPLETE_WIPE_UNPROVED,
    gaps: STO_05_GAPS,
    customer_release: CUSTOMER_RELEASE_BLOCKED,
    internal_only: true,
    proof_label: PROOF_LABEL_INTERNAL,
  };
}

/**
 * Recovery receipt scoped to verified stores only. Outstanding copies and
 * independent exports are listed as not recovered.
 */
export function issueScopedRecovery(session: DeletionSession): RecoveryDecision {
  const refused = evaluateMutationClaim(session);
  if (refused) {
    return refused;
  }

  const { verifiedStores, outstandingCopies } = verifyStores(session);
  const verifiedIds = new Set(verifiedStores.map((store) => store.id));
  const requested = session.recoveryTargets ?? verifiedStores.map((store) => store.id);
  const recoveredStoreIds = requested.filter((id) => verifiedIds.has(id));

  return {
    ok: true,
    schemaVersion: 1,
    kind: "sto05.scoped_recovery",
    task: STO_05_TASK,
    experimental: true,
    defaultOff: true,
    enabled: false,
    liveDelete: false,
    completeRestore: false,
    spend: 0,
    owner: session.principal.owner,
    tenant: session.principal.tenant,
    verifiedStores,
    recoveredStoreIds,
    outstandingCopiesNotRecovered: outstandingCopies,
    independentExportsNotRecovered: mapIndependentExports(session),
    miss: MISS_STO05_COMPLETE_WIPE_UNPROVED,
    gaps: STO_05_GAPS,
    customer_release: CUSTOMER_RELEASE_BLOCKED,
    internal_only: true,
    proof_label: PROOF_LABEL_INTERNAL,
  };
}

export function refuseBlanketDelete(session: DeletionSession): DeletionDenial {
  return deny(
    DELETION_DENIAL.BLANKET_DELETE_REFUSED,
    "Blanket deletion is refused. STO-05 does not authorize wiping stores outside a verified scoped receipt.",
    { blocker: MISS_STO05_COMPLETE_WIPE_UNPROVED, ...sessionScope(session) },
  );
}

export function refuseLegacyMigration(session: DeletionSession): DeletionDenial {
  return deny(
    DELETION_DENIAL.LEGACY_MIGRATION_REFUSED,
    "Legacy migration is refused. STO-05 does not authorize broad data migration.",
    { blocker: MISS_STO05_COMPLETE_WIPE_UNPROVED, ...sessionScope(session) },
  );
}
