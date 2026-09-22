import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CON_06_RECEIPT_RELATIVE_PATH,
  refuseIntegratedCon06Claim,
} from "../../src/mig01/con-06-consumer.js";
import {
  MISS_SEC03_OWNER_UNRESOLVED,
  SEC_03_RECEIPT_RELATIVE_PATH,
  refuseEnabledMediationWithoutOwner,
} from "../../src/sec03/mediation.js";
import {
  CUSTOMER_RELEASE_BLOCKED,
  MISS_SEC05_ISOLATION_UNPROVED,
  PROOF_LABEL_INTERNAL,
  SEC_05_RECEIPT_RELATIVE_PATH,
  refuseCustomerRelease,
} from "../../src/sec05/isolation.js";
import {
  DELETION_DENIAL,
  DeletionBoundaryError,
  FX_STO05_BLANKET_DELETE_REFUSED,
  FX_STO05_HONEST_DELETION_RECEIPT,
  FX_STO05_NO_ERASE_EXPORTS_PROMISE,
  MISS_STO05_COMPLETE_WIPE_UNPROVED,
  MISS_STO05_EXTERNAL_EFFECTS_UNERASED,
  MISS_STO05_INDEPENDENT_EXPORTS_UNERASED,
  MISS_STO05_OUTSTANDING_COPIES_UNERASED,
  STO_05_GAPS,
  STO_05_IMPL,
  STO_05_RECEIPT_RELATIVE_PATH,
  STO_05_STATUS_DISABLED,
  STO_05_TASK,
  deletionStateFromReceipt,
  isDeletionDenial,
  issueScopedDeletion,
  issueScopedRecovery,
  refuseBlanketDelete,
  refuseCompleteWipe,
  refuseLegacyMigration,
  refuseLiveDelete,
  type DeletionMode,
  type DeletionSession,
  type ExternalEffectInput,
  type IndependentExportInput,
  type OutstandingCopyInput,
  type StoreCandidate,
} from "../../src/sto05/deletion.js";

const hushCliRoot = join(import.meta.dirname, "..", "..");
const repoRoot = join(hushCliRoot, "..");
const fixtureRoot = join(hushCliRoot, "tests", "fixtures", "sto05");
const receiptPath = join(repoRoot, STO_05_RECEIPT_RELATIVE_PATH);
const sec05ReceiptPath = join(repoRoot, SEC_05_RECEIPT_RELATIVE_PATH);
const sec03ReceiptPath = join(repoRoot, SEC_03_RECEIPT_RELATIVE_PATH);
const con06ReceiptPath = join(repoRoot, CON_06_RECEIPT_RELATIVE_PATH);
const fakeWipePath = join(fixtureRoot, "fake-complete-wipe-allowed.json");

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function parseMode(value: unknown): DeletionMode {
  if (value === "scoped" || value === "blanket" || value === "legacy-migration") {
    return value;
  }
  throw new Error("mode must be scoped, blanket, or legacy-migration");
}

function parseStores(value: unknown): StoreCandidate[] {
  if (!Array.isArray(value)) {
    throw new Error("stores must be an array");
  }
  return value.map((entry, index) => {
    const store = expectRecord(entry, `stores[${index}]`);
    if (typeof store.claimedVerified !== "boolean") {
      throw new Error(`stores[${index}].claimedVerified must be a boolean`);
    }
    return {
      id: expectString(store.id, `stores[${index}].id`),
      path: expectString(store.path, `stores[${index}].path`),
      owner: expectString(store.owner, `stores[${index}].owner`),
      tenant: expectString(store.tenant, `stores[${index}].tenant`),
      claimedVerified: store.claimedVerified,
    };
  });
}

function parseOutstanding(value: unknown): OutstandingCopyInput[] {
  if (!Array.isArray(value)) {
    throw new Error("outstandingCopies must be an array");
  }
  return value.map((entry, index) => {
    const copy = expectRecord(entry, `outstandingCopies[${index}]`);
    return {
      id: expectString(copy.id, `outstandingCopies[${index}].id`),
      path: expectString(copy.path, `outstandingCopies[${index}].path`),
      reason: expectString(copy.reason, `outstandingCopies[${index}].reason`),
    };
  });
}

function parseEffects(value: unknown): ExternalEffectInput[] {
  if (!Array.isArray(value)) {
    throw new Error("externalEffects must be an array");
  }
  return value.map((entry, index) => {
    const effect = expectRecord(entry, `externalEffects[${index}]`);
    if (effect.completed !== true) {
      throw new Error(`externalEffects[${index}].completed must be true`);
    }
    return {
      id: expectString(effect.id, `externalEffects[${index}].id`),
      destination: expectString(effect.destination, `externalEffects[${index}].destination`),
      completed: true,
    };
  });
}

function parseExports(value: unknown): IndependentExportInput[] {
  if (!Array.isArray(value)) {
    throw new Error("independentExports must be an array");
  }
  return value.map((entry, index) => {
    const exported = expectRecord(entry, `independentExports[${index}]`);
    return {
      id: expectString(exported.id, `independentExports[${index}].id`),
      path: expectString(exported.path, `independentExports[${index}].path`),
    };
  });
}

function parseCustomerReleaseClaim(value: unknown): DeletionSession["customerReleaseClaim"] {
  if (value === "BLOCKED" || value === "ALLOWED" || value === "PUBLIC") {
    return value;
  }
  throw new Error("customerReleaseClaim must be BLOCKED, ALLOWED, or PUBLIC");
}

function parseRecoveryTargets(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("recoveryTargets must be an array");
  }
  return value.map((entry, index) => expectString(entry, `recoveryTargets[${index}]`));
}

function sessionFromFixture(
  path: string,
  overlay: Partial<DeletionSession> = {},
): { id: string; session: DeletionSession; fixture: Record<string, unknown> } {
  const fixture = expectRecord(loadJson(path), path);
  if (fixture.experimental !== true || fixture.defaultOff !== true) {
    throw new Error("fixture must be experimental and defaultOff");
  }
  if (typeof fixture.enabled !== "boolean" || typeof fixture.liveDelete !== "boolean") {
    throw new Error("enabled and liveDelete must be booleans");
  }
  const principal = expectRecord(fixture.principal, "principal");
  const session: DeletionSession = {
    mode: parseMode(overlay.mode ?? fixture.mode ?? "scoped"),
    principal: overlay.principal ?? {
      owner: expectString(principal.owner, "principal.owner"),
      tenant: expectString(principal.tenant, "principal.tenant"),
    },
    stores: overlay.stores ?? parseStores(fixture.stores),
    outstandingCopies: overlay.outstandingCopies ?? parseOutstanding(fixture.outstandingCopies),
    externalEffects: overlay.externalEffects ?? parseEffects(fixture.externalEffects),
    independentExports: overlay.independentExports ?? parseExports(fixture.independentExports),
    claimedCompleteWipe: overlay.claimedCompleteWipe ?? fixture.claimedCompleteWipe === true,
    claimedEraseIndependentExports:
      overlay.claimedEraseIndependentExports ?? fixture.claimedEraseIndependentExports === true,
    claimedEraseExternalEffects:
      overlay.claimedEraseExternalEffects ?? fixture.claimedEraseExternalEffects === true,
    liveDelete: overlay.liveDelete ?? fixture.liveDelete,
    enabled: overlay.enabled ?? fixture.enabled,
    customerReleaseClaim:
      overlay.customerReleaseClaim ?? parseCustomerReleaseClaim(fixture.customerReleaseClaim),
    recoveryTargets: overlay.recoveryTargets ?? parseRecoveryTargets(fixture.recoveryTargets),
  };
  return {
    id: expectString(fixture.id, "id"),
    fixture,
    session,
  };
}

describe("STO-05 scoped deletion and recovery", () => {
  it("records a default-off deletion receipt with empty verified stores and honest gaps", () => {
    const receipt = refuseCompleteWipe(loadJson(receiptPath));

    expect(receipt.task).toBe(STO_05_TASK);
    expect(receipt.impl).toBe(STO_05_IMPL);
    expect(receipt.status).toBe(STO_05_STATUS_DISABLED);
    expect(receipt.experimental).toBe(true);
    expect(receipt.defaultOff).toBe(true);
    expect(receipt.enabled).toBe(false);
    expect(receipt.completeWipe).toBe(false);
    expect(receipt.liveDelete).toBe(false);
    expect(receipt.blanketDelete).toBe(false);
    expect(receipt.legacyMigration).toBe(false);
    expect(receipt.spend).toBe(0);
    expect(receipt.con06Status).toBe("NOT_ACTIVATED");
    expect(receipt.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(receipt.internal_only).toBe(true);
    expect(receipt.proof_label).toBe(PROOF_LABEL_INTERNAL);
    expect(receipt.miss).toBe(MISS_STO05_COMPLETE_WIPE_UNPROVED);
    expect(receipt.gaps).toEqual([...STO_05_GAPS]);
    expect(receipt.sec05Miss).toBe(MISS_SEC05_ISOLATION_UNPROVED);
    expect(receipt.sec03Miss).toBe(MISS_SEC03_OWNER_UNRESOLVED);
    expect(receipt.verifiedStores).toEqual([]);
    expect(receipt.outstandingCopies).toEqual([]);
    expect(receipt.externalEffectsNotErased).toEqual([]);
    expect(receipt.independentExportsNotClaimed).toEqual([]);

    const state = deletionStateFromReceipt(receipt);
    expect(state.enabled).toBe(false);
    expect(state.defaultOff).toBe(true);
    expect(state.completeWipe).toBe(false);
    expect(state.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(state.sec05Miss).toBe(MISS_SEC05_ISOLATION_UNPROVED);
  });

  it("leaves CON-06 NOT_ACTIVATED and composes SEC-05 customer_release BLOCKED", () => {
    const con06 = refuseIntegratedCon06Claim(loadJson(con06ReceiptPath));
    expect(con06.status).toBe("NOT_ACTIVATED");
    expect(con06.pin).toBeNull();
    expect(con06.spend).toBe(0);

    const sec03 = refuseEnabledMediationWithoutOwner(loadJson(sec03ReceiptPath));
    expect(sec03.enabled).toBe(false);
    expect(sec03.blocker).toBe(MISS_SEC03_OWNER_UNRESOLVED);

    const sec05 = refuseCustomerRelease(loadJson(sec05ReceiptPath));
    expect(sec05.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(sec05.internal_only).toBe(true);
    expect(sec05.miss).toBe(MISS_SEC05_ISOLATION_UNPROVED);
  });

  it("refuses a fake complete-wipe ENABLED claim", () => {
    const claim = loadJson(fakeWipePath);

    expect(() => refuseCompleteWipe(claim)).toThrow(DeletionBoundaryError);
    expect(() => refuseCompleteWipe(claim)).toThrow(/status must be "DISABLED"/);
  });

  it("FX-STO05-honest-deletion-receipt: lists verified stores and outstanding copies; recovery stays scoped", () => {
    const loaded = sessionFromFixture(
      join(fixtureRoot, `${FX_STO05_HONEST_DELETION_RECEIPT}.json`),
    );
    expect(loaded.id).toBe(FX_STO05_HONEST_DELETION_RECEIPT);

    const deletion = issueScopedDeletion(loaded.session);
    expect(deletion.ok).toBe(true);
    if (isDeletionDenial(deletion)) {
      throw new Error("expected scoped deletion to issue an honest receipt");
    }

    expect(deletion.kind).toBe("sto05.scoped_deletion");
    expect(deletion.enabled).toBe(false);
    expect(deletion.liveDelete).toBe(false);
    expect(deletion.completeWipe).toBe(false);
    expect(deletion.blanketDelete).toBe(false);
    expect(deletion.legacyMigration).toBe(false);
    expect(deletion.spend).toBe(0);
    expect(deletion.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(deletion.internal_only).toBe(true);
    expect(deletion.verifiedStores).toEqual([
      {
        id: "verified-project",
        path: "fixture://sto05/acme/project.hush",
        owner: "alice",
        tenant: "acme",
        verified: true,
      },
    ]);
    expect(deletion.outstandingCopies.map((copy) => copy.id)).toEqual([
      "laptop-cache",
      "unverified-replica",
      "other-tenant-store",
    ]);
    expect(deletion.outstandingCopies.every((copy) => copy.unverified)).toBe(true);
    expect(
      deletion.outstandingCopies.find((copy) => copy.id === "other-tenant-store")?.reason,
    ).toMatch(/tenant/);
    expect(deletion.externalEffectsNotErased).toEqual([
      {
        id: "wrangler-push",
        destination: "https://workers.example.invalid/already-applied",
        completed: true,
        erased: false,
      },
    ]);
    expect(deletion.independentExportsNotClaimed).toEqual([
      {
        id: "user-dotenv-export",
        path: "fixture://sto05/exports/user.env",
        claimedErased: false,
      },
    ]);
    expect(deletion.gaps).toEqual([
      MISS_STO05_COMPLETE_WIPE_UNPROVED,
      MISS_STO05_OUTSTANDING_COPIES_UNERASED,
      MISS_STO05_EXTERNAL_EFFECTS_UNERASED,
      MISS_STO05_INDEPENDENT_EXPORTS_UNERASED,
    ]);

    const recovery = issueScopedRecovery(loaded.session);
    expect(recovery.ok).toBe(true);
    if (isDeletionDenial(recovery)) {
      throw new Error("expected scoped recovery to issue an honest receipt");
    }
    expect(recovery.kind).toBe("sto05.scoped_recovery");
    expect(recovery.completeRestore).toBe(false);
    expect(recovery.verifiedStores.map((store) => store.id)).toEqual(["verified-project"]);
    expect(recovery.recoveredStoreIds).toEqual(["verified-project"]);
    expect(recovery.outstandingCopiesNotRecovered.map((copy) => copy.id)).toEqual([
      "laptop-cache",
      "unverified-replica",
      "other-tenant-store",
    ]);
    expect(recovery.independentExportsNotRecovered.map((exported) => exported.id)).toEqual([
      "user-dotenv-export",
    ]);
    expect(recovery.independentExportsNotRecovered[0]?.claimedErased).toBe(false);
  });

  it("FX-STO05-no-erase-exports-promise: refuses erase promises; honest retry lists exports unclaimed", () => {
    const loaded = sessionFromFixture(
      join(fixtureRoot, `${FX_STO05_NO_ERASE_EXPORTS_PROMISE}.json`),
    );
    expect(loaded.id).toBe(FX_STO05_NO_ERASE_EXPORTS_PROMISE);
    expect(loaded.session.claimedEraseIndependentExports).toBe(true);
    expect(loaded.session.claimedEraseExternalEffects).toBe(true);

    const exportPromise = issueScopedDeletion(loaded.session);
    expect(isDeletionDenial(exportPromise)).toBe(true);
    if (!isDeletionDenial(exportPromise)) {
      throw new Error("expected independent-export erase promise to be refused");
    }
    expect(exportPromise.code).toBe(DELETION_DENIAL.EXPORT_ERASE_PROMISE_REFUSED);
    expect(exportPromise.blocker).toBe(MISS_STO05_INDEPENDENT_EXPORTS_UNERASED);
    expect(exportPromise.completeWipe).toBe(false);
    expect(exportPromise.liveDelete).toBe(false);

    const externalOnly = issueScopedDeletion({
      ...loaded.session,
      claimedEraseIndependentExports: false,
    });
    expect(isDeletionDenial(externalOnly)).toBe(true);
    if (!isDeletionDenial(externalOnly)) {
      throw new Error("expected external-effect erase promise to be refused");
    }
    expect(externalOnly.code).toBe(DELETION_DENIAL.EXTERNAL_EFFECT_ERASE_PROMISE_REFUSED);
    expect(externalOnly.blocker).toBe(MISS_STO05_EXTERNAL_EFFECTS_UNERASED);

    const honestRetry = expectRecord(loaded.fixture.honestRetry, "honestRetry");
    const honest = issueScopedDeletion({
      ...loaded.session,
      claimedEraseIndependentExports: honestRetry.claimedEraseIndependentExports === true,
      claimedEraseExternalEffects: honestRetry.claimedEraseExternalEffects === true,
    });
    expect(honest.ok).toBe(true);
    if (isDeletionDenial(honest)) {
      throw new Error("expected honest retry to issue a deletion receipt");
    }
    expect(honest.independentExportsNotClaimed).toEqual([
      {
        id: "user-taken-copy",
        path: "fixture://sto05/exports/taken.env",
        claimedErased: false,
      },
    ]);
    expect(honest.externalEffectsNotErased).toEqual([
      {
        id: "already-pushed-secret",
        destination: "https://api.example.invalid/completed-effect",
        completed: true,
        erased: false,
      },
    ]);
    expect(JSON.stringify(honest)).not.toMatch(/claimedErased":true/);
    expect(JSON.stringify(honest)).not.toMatch(/erased":true/);
  });

  it("FX-STO05-blanket-delete-refused: blanket delete, legacy migration, live delete, and real paths are refused", () => {
    const loaded = sessionFromFixture(join(fixtureRoot, `${FX_STO05_BLANKET_DELETE_REFUSED}.json`));
    expect(loaded.id).toBe(FX_STO05_BLANKET_DELETE_REFUSED);
    const attempts = expectRecord(loaded.fixture.attempts, "attempts");
    const blanketAttempt = expectRecord(attempts.blanket, "attempts.blanket");
    const legacyAttempt = expectRecord(attempts.legacyMigration, "attempts.legacyMigration");
    const liveAttempt = expectRecord(attempts.liveDelete, "attempts.liveDelete");
    const realPathAttempt = expectRecord(attempts.realPath, "attempts.realPath");

    const blanket = issueScopedDeletion({
      ...loaded.session,
      mode: parseMode(blanketAttempt.mode),
      claimedCompleteWipe: blanketAttempt.claimedCompleteWipe === true,
    });
    expect(isDeletionDenial(blanket)).toBe(true);
    if (!isDeletionDenial(blanket)) {
      throw new Error("expected blanket delete to be refused");
    }
    expect(blanket.code).toBe(DELETION_DENIAL.BLANKET_DELETE_REFUSED);
    expect(blanket.blocker).toBe(MISS_STO05_COMPLETE_WIPE_UNPROVED);

    const legacy = issueScopedDeletion({
      ...loaded.session,
      mode: parseMode(legacyAttempt.mode),
    });
    expect(isDeletionDenial(legacy)).toBe(true);
    if (!isDeletionDenial(legacy)) {
      throw new Error("expected legacy migration to be refused");
    }
    expect(legacy.code).toBe(DELETION_DENIAL.LEGACY_MIGRATION_REFUSED);

    const live = issueScopedDeletion({
      ...loaded.session,
      mode: parseMode(liveAttempt.mode),
      liveDelete: liveAttempt.liveDelete === true,
    });
    expect(isDeletionDenial(live)).toBe(true);
    if (!isDeletionDenial(live)) {
      throw new Error("expected live delete to be refused");
    }
    expect(live.code).toBe(DELETION_DENIAL.LIVE_DELETE_REFUSED);

    const realPath = issueScopedDeletion({
      ...loaded.session,
      stores: parseStores(realPathAttempt.stores),
    });
    expect(isDeletionDenial(realPath)).toBe(true);
    if (!isDeletionDenial(realPath)) {
      throw new Error("expected a real filesystem path to be refused");
    }
    expect(realPath.code).toBe(DELETION_DENIAL.REAL_PATH_REFUSED);

    const explicitBlanket = refuseBlanketDelete(loaded.session);
    expect(explicitBlanket.code).toBe(DELETION_DENIAL.BLANKET_DELETE_REFUSED);
    const explicitLegacy = refuseLegacyMigration(loaded.session);
    expect(explicitLegacy.code).toBe(DELETION_DENIAL.LEGACY_MIGRATION_REFUSED);
    const explicitLive = refuseLiveDelete();
    expect(explicitLive.code).toBe(DELETION_DENIAL.LIVE_DELETE_REFUSED);
    expect(explicitLive.liveDelete).toBe(false);

    const enabled = issueScopedDeletion({ ...loaded.session, enabled: true });
    expect(isDeletionDenial(enabled)).toBe(true);
    if (!isDeletionDenial(enabled)) {
      throw new Error("expected enabling the default-off gate to be refused");
    }
    expect(enabled.code).toBe(DELETION_DENIAL.ADAPTER_DISABLED);

    const customer = issueScopedDeletion({
      ...loaded.session,
      customerReleaseClaim: "ALLOWED",
    });
    expect(isDeletionDenial(customer)).toBe(true);
    if (!isDeletionDenial(customer)) {
      throw new Error("expected customer-release ALLOWED claim to stay BLOCKED");
    }
    expect(customer.code).toBe(DELETION_DENIAL.CUSTOMER_RELEASE_BLOCKED);
    expect(customer.blocker).toBe(MISS_SEC05_ISOLATION_UNPROVED);
  });
});
