import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CRITICAL_SENTINELS,
  FX_INT06_NO_POST_HOC_CRITERIA,
  FX_INT06_SENTINELS_COMPLETE,
  FX_INT06_UNTESTED_BOUNDARY_NARROWS,
  INT_06_GAPS,
  INT_06_IMPL,
  INT_06_RECEIPT_RELATIVE_PATH,
  INT_06_STATUS_DISABLED,
  INT_06_TASK,
  MISS_INT06_LIVE,
  OPAQUE_SENTINEL_REFS,
  READY_FOR_LIVE_BLOCKED_BY_D06,
  SENTINEL_DENIAL,
  SENTINELS_RUN_COMPLETE,
  SENTINELS_RUN_INCOMPLETE,
  SentinelBoundaryError,
  criticalSentinelRegistry,
  defaultAcceptanceCriteria,
  isSentinelDenial,
  refuseLiveRun,
  refuseLiveSuite,
  refusePostHocCriteriaChange,
  runSentinelSuite,
  sentinelStateFromReceipt,
  type AcceptanceCriteria,
  type AdmittedReleaseCombination,
  type OpaqueSentinelRef,
  type SentinelResult,
  type SentinelSession,
  type SupportedClaim,
  type UntestedBoundaryPolicy,
} from "../../src/int06/sentinels.js";
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
  MISS_STO05_COMPLETE_WIPE_UNPROVED,
  STO_05_RECEIPT_RELATIVE_PATH,
  refuseCompleteWipe,
} from "../../src/sto05/deletion.js";

const hushCliRoot = join(import.meta.dirname, "..", "..");
const repoRoot = join(hushCliRoot, "..");
const fixtureRoot = join(hushCliRoot, "tests", "fixtures", "int06");
const receiptPath = join(repoRoot, INT_06_RECEIPT_RELATIVE_PATH);
const sto05ReceiptPath = join(repoRoot, STO_05_RECEIPT_RELATIVE_PATH);
const sec05ReceiptPath = join(repoRoot, SEC_05_RECEIPT_RELATIVE_PATH);
const sec03ReceiptPath = join(repoRoot, SEC_03_RECEIPT_RELATIVE_PATH);
const con06ReceiptPath = join(repoRoot, CON_06_RECEIPT_RELATIVE_PATH);
const fakeLivePath = join(fixtureRoot, "fake-live-run-ready.json");

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

function parseOpaqueRefs(value: unknown): OpaqueSentinelRef[] {
  if (!Array.isArray(value)) {
    throw new Error("opaqueRefs must be an array");
  }
  return value.map((entry, index) => {
    const ref = expectString(entry, `opaqueRefs[${index}]`);
    if (
      ref !== "EXE-02" &&
      ref !== "DEV-07" &&
      ref !== "SEC-05" &&
      ref !== "FF-04" &&
      ref !== "OBS-01" &&
      ref !== "UI-02"
    ) {
      throw new Error(`opaqueRefs[${index}] is not a registered opaque sentinel ref`);
    }
    return ref;
  });
}

function parseResults(value: unknown): SentinelResult[] {
  if (!Array.isArray(value)) {
    throw new Error("results must be an array");
  }
  return value.map((entry, index) => {
    const result = expectRecord(entry, `results[${index}]`);
    if (typeof result.represented !== "boolean") {
      throw new Error(`results[${index}].represented must be a boolean`);
    }
    const outcome = result.outcome;
    if (outcome !== "pass" && outcome !== "fail" && outcome !== "untested") {
      throw new Error(`results[${index}].outcome must be pass, fail, or untested`);
    }
    return {
      sentinelId: expectString(result.sentinelId, `results[${index}].sentinelId`),
      represented: result.represented,
      outcome,
    };
  });
}

function parseCriteria(value: unknown, label: string): AcceptanceCriteria {
  const criteria = expectRecord(value, label);
  if (criteria.failClosed !== true) {
    throw new Error(`${label}.failClosed must be true`);
  }
  if (!Array.isArray(criteria.requiredSentinelIds) || !Array.isArray(criteria.requiredBoundaries)) {
    throw new Error(`${label} required lists must be arrays`);
  }
  return {
    requiredSentinelIds: criteria.requiredSentinelIds.map((id, index) =>
      expectString(id, `${label}.requiredSentinelIds[${index}]`),
    ),
    requiredBoundaries: criteria.requiredBoundaries.map((boundary, index) =>
      expectString(boundary, `${label}.requiredBoundaries[${index}]`),
    ),
    failClosed: true,
  };
}

function parseClaim(value: unknown): SupportedClaim {
  const claim = expectRecord(value, "supportedClaim");
  if (!Array.isArray(claim.boundaries)) {
    throw new Error("supportedClaim.boundaries must be an array");
  }
  return {
    boundaries: claim.boundaries.map((boundary, index) =>
      expectString(boundary, `supportedClaim.boundaries[${index}]`),
    ),
  };
}

function parseCombination(value: unknown): AdmittedReleaseCombination {
  const combination = expectRecord(value, "combination");
  if (typeof combination.admitted !== "boolean" || typeof combination.live !== "boolean") {
    throw new Error("combination.admitted and combination.live must be booleans");
  }
  return {
    id: expectString(combination.id, "combination.id"),
    admitted: combination.admitted,
    live: combination.live,
    opaqueRefs: parseOpaqueRefs(combination.opaqueRefs),
    fakeToken: expectString(combination.fakeToken, "combination.fakeToken"),
  };
}

function parsePolicy(value: unknown): UntestedBoundaryPolicy {
  if (value === "narrow" || value === "block-rollout") {
    return value;
  }
  throw new Error("untestedBoundaryPolicy must be narrow or block-rollout");
}

function parseCustomerReleaseClaim(value: unknown): SentinelSession["customerReleaseClaim"] {
  if (value === "BLOCKED" || value === "ALLOWED" || value === "PUBLIC") {
    return value;
  }
  throw new Error("customerReleaseClaim must be BLOCKED, ALLOWED, or PUBLIC");
}

function parseHosts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("hosts must be an array");
  }
  return value.map((entry, index) => expectString(entry, `hosts[${index}]`));
}

function sessionFromFixture(
  path: string,
  overlay: Partial<SentinelSession> = {},
): { id: string; session: SentinelSession; fixture: Record<string, unknown> } {
  const fixture = expectRecord(loadJson(path), path);
  if (fixture.experimental !== true || fixture.defaultOff !== true) {
    throw new Error("fixture must be experimental and defaultOff");
  }
  if (typeof fixture.enabled !== "boolean" || typeof fixture.liveRun !== "boolean") {
    throw new Error("enabled and liveRun must be booleans");
  }
  if (typeof fixture.spend !== "number") {
    throw new Error("spend must be a number");
  }
  const session: SentinelSession = {
    combination: overlay.combination ?? parseCombination(fixture.combination),
    results: overlay.results ?? parseResults(fixture.results),
    criteria: overlay.criteria ?? parseCriteria(fixture.criteria, "criteria"),
    supportedClaim: overlay.supportedClaim ?? parseClaim(fixture.supportedClaim),
    untestedBoundaryPolicy:
      overlay.untestedBoundaryPolicy ?? parsePolicy(fixture.untestedBoundaryPolicy),
    liveRun: overlay.liveRun ?? fixture.liveRun,
    enabled: overlay.enabled ?? fixture.enabled,
    customerReleaseClaim:
      overlay.customerReleaseClaim ?? parseCustomerReleaseClaim(fixture.customerReleaseClaim),
    hosts: overlay.hosts ?? parseHosts(fixture.hosts),
    spend: overlay.spend ?? fixture.spend,
  };
  return {
    id: expectString(fixture.id, "id"),
    fixture,
    session,
  };
}

describe("INT-06 cross-boundary sentinel suite", () => {
  it("records a default-off fixture receipt with live_run false and ready_for_live blocked_by_D06", () => {
    const receipt = refuseLiveRun(loadJson(receiptPath));

    expect(receipt.task).toBe(INT_06_TASK);
    expect(receipt.impl).toBe(INT_06_IMPL);
    expect(receipt.status).toBe(INT_06_STATUS_DISABLED);
    expect(receipt.experimental).toBe(true);
    expect(receipt.defaultOff).toBe(true);
    expect(receipt.enabled).toBe(false);
    expect(receipt.live_run).toBe(false);
    expect(receipt.spend).toBe(0);
    expect(receipt.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(receipt.ready_for_live).toBe(READY_FOR_LIVE_BLOCKED_BY_D06);
    expect(receipt.internal_only).toBe(true);
    expect(receipt.proof_label).toBe(PROOF_LABEL_INTERNAL);
    expect(receipt.con06Status).toBe("NOT_ACTIVATED");
    expect(receipt.miss).toBe(MISS_INT06_LIVE);
    expect(receipt.gaps).toEqual([...INT_06_GAPS]);
    expect(receipt.sto05Miss).toBe(MISS_STO05_COMPLETE_WIPE_UNPROVED);
    expect(receipt.sec05Miss).toBe(MISS_SEC05_ISOLATION_UNPROVED);
    expect(receipt.sec03Miss).toBe(MISS_SEC03_OWNER_UNRESOLVED);
    expect(receipt.sentinelsRun).toBe(SENTINELS_RUN_COMPLETE);
    expect(receipt.opaqueRefs).toEqual([...OPAQUE_SENTINEL_REFS]);
    expect(receipt.blocker).toBe(MISS_INT06_LIVE);

    const state = sentinelStateFromReceipt(receipt);
    expect(state.enabled).toBe(false);
    expect(state.live_run).toBe(false);
    expect(state.spend).toBe(0);
    expect(state.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(state.ready_for_live).toBe(READY_FOR_LIVE_BLOCKED_BY_D06);
    expect(state.miss).toBe(MISS_INT06_LIVE);
  });

  it("registers critical security, identity, and no-fallback sentinels as opaque refs", () => {
    const registry = criticalSentinelRegistry();
    expect(registry).toEqual([...CRITICAL_SENTINELS]);
    expect(new Set(registry.map((sentinel) => sentinel.opaqueRef))).toEqual(
      new Set(OPAQUE_SENTINEL_REFS),
    );
    expect(new Set(registry.map((sentinel) => sentinel.category))).toEqual(
      new Set(["security", "identity", "no-fallback"]),
    );
    expect(registry.every((sentinel) => sentinel.critical)).toBe(true);
    expect(defaultAcceptanceCriteria().requiredSentinelIds).toEqual(
      CRITICAL_SENTINELS.map((sentinel) => sentinel.id),
    );
  });

  it("leaves CON-06 NOT_ACTIVATED and composes STO-05 / SEC-05 customer_release BLOCKED", () => {
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

    const sto05 = refuseCompleteWipe(loadJson(sto05ReceiptPath));
    expect(sto05.enabled).toBe(false);
    expect(sto05.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(sto05.miss).toBe(MISS_STO05_COMPLETE_WIPE_UNPROVED);
  });

  it("refuses a fake live-run ready claim", () => {
    const claim = loadJson(fakeLivePath);

    expect(() => refuseLiveRun(claim)).toThrow(SentinelBoundaryError);
    expect(() => refuseLiveRun(claim)).toThrow(/status must be "DISABLED"/);

    const honest = expectRecord(loadJson(receiptPath), "canonical receipt");
    expect(() => refuseLiveRun({ ...honest, live_run: true })).toThrow(/live_run must be false/);
    expect(() => refuseLiveRun({ ...honest, spend: 12 })).toThrow(/spend must be 0/);
    expect(() => refuseLiveRun({ ...honest, ready_for_live: "ready" })).toThrow(
      /ready_for_live must be "blocked_by_D06"/,
    );
    expect(() => refuseLiveRun({ ...honest, customer_release: "ALLOWED" })).toThrow(
      /customer_release must be "BLOCKED"/,
    );
  });

  it("FX-INT06-sentinels-complete: all critical sentinels are represented; live stays blocked", () => {
    const loaded = sessionFromFixture(join(fixtureRoot, `${FX_INT06_SENTINELS_COMPLETE}.json`));
    expect(loaded.id).toBe(FX_INT06_SENTINELS_COMPLETE);

    const suite = runSentinelSuite(loaded.session);
    expect(suite.ok).toBe(true);
    if (isSentinelDenial(suite)) {
      throw new Error("expected complete fixture sentinels to pass");
    }

    expect(suite.kind).toBe("int06.sentinel_suite");
    expect(suite.sentinelsRun).toBe(SENTINELS_RUN_COMPLETE);
    expect(suite.live_run).toBe(false);
    expect(suite.spend).toBe(0);
    expect(suite.enabled).toBe(false);
    expect(suite.defaultOff).toBe(true);
    expect(suite.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(suite.ready_for_live).toBe(READY_FOR_LIVE_BLOCKED_BY_D06);
    expect(suite.miss).toBe(MISS_INT06_LIVE);
    expect(suite.representedSentinelIds).toEqual(CRITICAL_SENTINELS.map((sentinel) => sentinel.id));
    expect(suite.supportedClaim.boundaries).toEqual(
      CRITICAL_SENTINELS.map((sentinel) => sentinel.boundary),
    );
  });

  it("FX-INT06-untested-boundary-narrows: untested UI-02 identity narrows or blocks rollout", () => {
    const loaded = sessionFromFixture(
      join(fixtureRoot, `${FX_INT06_UNTESTED_BOUNDARY_NARROWS}.json`),
    );
    expect(loaded.id).toBe(FX_INT06_UNTESTED_BOUNDARY_NARROWS);
    const attempts = expectRecord(loaded.fixture.attempts, "attempts");
    const narrowAttempt = expectRecord(attempts.narrow, "attempts.narrow");
    const blockAttempt = expectRecord(attempts.blockRollout, "attempts.blockRollout");

    const narrowed = runSentinelSuite({
      ...loaded.session,
      untestedBoundaryPolicy: parsePolicy(narrowAttempt.untestedBoundaryPolicy),
    });
    expect(isSentinelDenial(narrowed)).toBe(true);
    if (!isSentinelDenial(narrowed)) {
      throw new Error("expected an untested boundary to narrow the supported claim");
    }
    expect(narrowed.code).toBe(SENTINEL_DENIAL.UNTESTED_BOUNDARY_NARROWS);
    expect(narrowed.sentinelsRun).toBe(SENTINELS_RUN_INCOMPLETE);
    expect(narrowed.untestedBoundaries).toEqual(["ui-identity-presentation"]);
    expect(narrowed.narrowedClaim?.boundaries).toEqual([
      "execution-identity-no-fallback",
      "developer-identity-binding",
      "auth-fail-no-fallback",
      "feature-flag-fail-closed",
      "observability-no-secret-leak",
    ]);
    expect(narrowed.narrowedClaim?.boundaries).not.toContain("ui-identity-presentation");
    expect(narrowed.ready_for_live).toBe(READY_FOR_LIVE_BLOCKED_BY_D06);
    expect(narrowed.live_run).toBe(false);

    const blocked = runSentinelSuite({
      ...loaded.session,
      untestedBoundaryPolicy: parsePolicy(blockAttempt.untestedBoundaryPolicy),
    });
    expect(isSentinelDenial(blocked)).toBe(true);
    if (!isSentinelDenial(blocked)) {
      throw new Error("expected an untested required boundary to block rollout");
    }
    expect(blocked.code).toBe(SENTINEL_DENIAL.ROLLOUT_BLOCKED);
    expect(blocked.sentinelsRun).toBe(SENTINELS_RUN_INCOMPLETE);
    expect(blocked.untestedBoundaries).toEqual(["ui-identity-presentation"]);
    expect(blocked.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
  });

  it("FX-INT06-no-post-hoc-criteria: dropping a failed sentinel after the run is refused", () => {
    const loaded = sessionFromFixture(join(fixtureRoot, `${FX_INT06_NO_POST_HOC_CRITERIA}.json`));
    expect(loaded.id).toBe(FX_INT06_NO_POST_HOC_CRITERIA);

    const failed = runSentinelSuite(loaded.session);
    expect(isSentinelDenial(failed)).toBe(true);
    if (!isSentinelDenial(failed)) {
      throw new Error("expected the failed SEC-05 no-fallback sentinel to stay visible");
    }
    expect(failed.code).toBe(SENTINEL_DENIAL.ROLLOUT_BLOCKED);
    expect(failed.failedSentinelIds).toEqual(["SEN-INT06-SEC05-NO-FALLBACK"]);
    expect(failed.sentinelsRun).toBe(SENTINELS_RUN_INCOMPLETE);

    const postHoc = refusePostHocCriteriaChange(
      failed,
      parseCriteria(loaded.fixture.postHocCriteria, "postHocCriteria"),
    );
    expect(isSentinelDenial(postHoc)).toBe(true);
    if (!isSentinelDenial(postHoc)) {
      throw new Error("expected post-hoc criteria change to be refused");
    }
    expect(postHoc.code).toBe(SENTINEL_DENIAL.POST_HOC_CRITERIA_CHANGE_REFUSED);
    expect(postHoc.failedSentinelIds).toEqual(["SEN-INT06-SEC05-NO-FALLBACK"]);
    expect(postHoc.ready_for_live).toBe(READY_FOR_LIVE_BLOCKED_BY_D06);

    const unchanged = refusePostHocCriteriaChange(failed, loaded.session.criteria);
    expect(unchanged).toBe(failed);
  });

  it("refuses live suite, npm.ch5.me, real tokens, invented green, and customer release", () => {
    const loaded = sessionFromFixture(join(fixtureRoot, `${FX_INT06_SENTINELS_COMPLETE}.json`));

    const live = runSentinelSuite({ ...loaded.session, liveRun: true });
    expect(isSentinelDenial(live)).toBe(true);
    if (!isSentinelDenial(live)) {
      throw new Error("expected a live run to be refused");
    }
    expect(live.code).toBe(SENTINEL_DENIAL.LIVE_RUN_REFUSED);
    expect(live.blocker).toBe(MISS_INT06_LIVE);

    const enabled = runSentinelSuite({ ...loaded.session, enabled: true });
    expect(isSentinelDenial(enabled)).toBe(true);
    if (!isSentinelDenial(enabled)) {
      throw new Error("expected enabling the default-off suite to be refused");
    }
    expect(enabled.code).toBe(SENTINEL_DENIAL.ADAPTER_DISABLED);

    const npm = runSentinelSuite({
      ...loaded.session,
      hosts: ["https://npm.ch5.me/@chriscode/hush"],
    });
    expect(isSentinelDenial(npm)).toBe(true);
    if (!isSentinelDenial(npm)) {
      throw new Error("expected npm.ch5.me to be refused");
    }
    expect(npm.code).toBe(SENTINEL_DENIAL.NPM_CH5_ME_REFUSED);

    const realToken = runSentinelSuite({
      ...loaded.session,
      combination: { ...loaded.session.combination, fakeToken: "live-secret-token" },
    });
    expect(isSentinelDenial(realToken)).toBe(true);
    if (!isSentinelDenial(realToken)) {
      throw new Error("expected a real token to be refused");
    }
    expect(realToken.code).toBe(SENTINEL_DENIAL.REAL_TOKEN_REFUSED);

    const invented = runSentinelSuite({
      ...loaded.session,
      results: [
        ...loaded.session.results,
        {
          sentinelId: "SEN-INT06-INVENTED",
          represented: false,
          outcome: "pass",
        },
      ],
    });
    expect(isSentinelDenial(invented)).toBe(true);
    if (!isSentinelDenial(invented)) {
      throw new Error("expected invented green to be refused");
    }
    expect(invented.code).toBe(SENTINEL_DENIAL.INVENTED_GREEN_REFUSED);

    const customer = runSentinelSuite({
      ...loaded.session,
      customerReleaseClaim: "ALLOWED",
    });
    expect(isSentinelDenial(customer)).toBe(true);
    if (!isSentinelDenial(customer)) {
      throw new Error("expected customer-release ALLOWED to stay BLOCKED");
    }
    expect(customer.code).toBe(SENTINEL_DENIAL.CUSTOMER_RELEASE_BLOCKED);
    expect(customer.blocker).toBe(MISS_SEC05_ISOLATION_UNPROVED);

    const explicitLive = refuseLiveSuite();
    expect(explicitLive.code).toBe(SENTINEL_DENIAL.LIVE_RUN_REFUSED);
    expect(explicitLive.live_run).toBe(false);
    expect(explicitLive.ready_for_live).toBe(READY_FOR_LIVE_BLOCKED_BY_D06);
    expect(explicitLive.spend).toBe(0);
  });
});
