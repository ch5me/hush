import { CON_06_STATUS_NOT_ACTIVATED, MISS_SEC03_OWNER_UNRESOLVED } from "../sec03/mediation.js";
import {
  CUSTOMER_RELEASE_BLOCKED,
  ISOLATION_DENIAL,
  MISS_SEC05_ISOLATION_UNPROVED,
  PROOF_LABEL_INTERNAL,
} from "../sec05/isolation.js";
import { MISS_STO05_COMPLETE_WIPE_UNPROVED } from "../sto05/deletion.js";

export const INT_06_RECEIPT_RELATIVE_PATH = ".ch5/int-06-sentinels.json";

export const INT_06_TASK = "INT-06" as const;
export const INT_06_IMPL = "INT-06-IMPL-01" as const;
export const INT_06_GATE = "cross-boundary-failure-security-acceptance" as const;
export const INT_06_STATUS_DISABLED = "DISABLED" as const;

export const MISS_INT06_LIVE = "MISS-INT06-LIVE" as const;

export const INT_06_GAPS = [MISS_INT06_LIVE] as const;

export const FX_INT06_SENTINELS_COMPLETE = "FX-INT06-sentinels-complete" as const;
export const FX_INT06_UNTESTED_BOUNDARY_NARROWS = "FX-INT06-untested-boundary-narrows" as const;
export const FX_INT06_NO_POST_HOC_CRITERIA = "FX-INT06-no-post-hoc-criteria" as const;

export const FAKE_TOKEN_PREFIX = "tok_fx_int06_" as const;
export const FAKE_PATH_PREFIX = "fixture://int06/" as const;
export const NPM_CH5_ME_HOST = "npm.ch5.me" as const;

export const READY_FOR_LIVE_BLOCKED_BY_D06 = "blocked_by_D06" as const;
export const SENTINELS_RUN_COMPLETE = "complete" as const;
export const SENTINELS_RUN_INCOMPLETE = "incomplete" as const;

export const OPAQUE_SENTINEL_REFS = [
  "EXE-02",
  "DEV-07",
  "SEC-05",
  "FF-04",
  "OBS-01",
  "UI-02",
] as const;

export type OpaqueSentinelRef = (typeof OPAQUE_SENTINEL_REFS)[number];
export type SentinelCategory = "security" | "identity" | "no-fallback";
export type SentinelsRun = typeof SENTINELS_RUN_COMPLETE | typeof SENTINELS_RUN_INCOMPLETE;

export type CriticalSentinel = {
  id: string;
  category: SentinelCategory;
  opaqueRef: OpaqueSentinelRef;
  boundary: string;
  critical: true;
};

/**
 * Security / identity / no-fallback sentinels. Peer tasks are opaque refs only;
 * this suite does not import or activate those implementations.
 */
export const CRITICAL_SENTINELS = [
  {
    id: "SEN-INT06-EXE02-NO-FALLBACK",
    category: "no-fallback",
    opaqueRef: "EXE-02",
    boundary: "execution-identity-no-fallback",
    critical: true,
  },
  {
    id: "SEN-INT06-DEV07-IDENTITY",
    category: "identity",
    opaqueRef: "DEV-07",
    boundary: "developer-identity-binding",
    critical: true,
  },
  {
    id: "SEN-INT06-SEC05-NO-FALLBACK",
    category: "no-fallback",
    opaqueRef: "SEC-05",
    boundary: "auth-fail-no-fallback",
    critical: true,
  },
  {
    id: "SEN-INT06-FF04-SECURITY",
    category: "security",
    opaqueRef: "FF-04",
    boundary: "feature-flag-fail-closed",
    critical: true,
  },
  {
    id: "SEN-INT06-OBS01-SECURITY",
    category: "security",
    opaqueRef: "OBS-01",
    boundary: "observability-no-secret-leak",
    critical: true,
  },
  {
    id: "SEN-INT06-UI02-IDENTITY",
    category: "identity",
    opaqueRef: "UI-02",
    boundary: "ui-identity-presentation",
    critical: true,
  },
] as const satisfies readonly CriticalSentinel[];

export const CRITICAL_SENTINEL_IDS = CRITICAL_SENTINELS.map((sentinel) => sentinel.id);

export const CRITICAL_BOUNDARIES = CRITICAL_SENTINELS.map((sentinel) => sentinel.boundary);

export const SENTINEL_DENIAL = {
  LIVE_RUN_REFUSED: "LIVE_RUN_REFUSED",
  UNTESTED_BOUNDARY_NARROWS: "UNTESTED_BOUNDARY_NARROWS",
  ROLLOUT_BLOCKED: "ROLLOUT_BLOCKED",
  POST_HOC_CRITERIA_CHANGE_REFUSED: "POST_HOC_CRITERIA_CHANGE_REFUSED",
  ADAPTER_DISABLED: "INT06_ADAPTER_DISABLED",
  CUSTOMER_RELEASE_BLOCKED: ISOLATION_DENIAL.CUSTOMER_RELEASE_BLOCKED,
  NPM_CH5_ME_REFUSED: "NPM_CH5_ME_REFUSED",
  REAL_TOKEN_REFUSED: "REAL_TOKEN_REFUSED",
  COMBINATION_NOT_ADMITTED: "COMBINATION_NOT_ADMITTED",
  INVENTED_GREEN_REFUSED: "INVENTED_GREEN_REFUSED",
} as const;

export class SentinelBoundaryError extends Error {
  readonly code: string;

  constructor(
    message: string,
    code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SentinelBoundaryError";
    this.code = code;
  }
}

export type Int06DisabledReceipt = {
  schemaVersion: 1;
  program: "ELF-CH5";
  impl: typeof INT_06_IMPL;
  task: typeof INT_06_TASK;
  miss: typeof MISS_INT06_LIVE;
  gaps: typeof INT_06_GAPS;
  sto05Miss: typeof MISS_STO05_COMPLETE_WIPE_UNPROVED;
  sec05Miss: typeof MISS_SEC05_ISOLATION_UNPROVED;
  sec03Miss: typeof MISS_SEC03_OWNER_UNRESOLVED;
  gate: typeof INT_06_GATE;
  status: typeof INT_06_STATUS_DISABLED;
  experimental: true;
  defaultOff: true;
  enabled: false;
  live_run: false;
  spend: 0;
  decision: "D08";
  customer_release: typeof CUSTOMER_RELEASE_BLOCKED;
  ready_for_live: typeof READY_FOR_LIVE_BLOCKED_BY_D06;
  internal_only: true;
  proof_label: typeof PROOF_LABEL_INTERNAL;
  con06Status: typeof CON_06_STATUS_NOT_ACTIVATED;
  sentinelsRun: SentinelsRun;
  opaqueRefs: typeof OPAQUE_SENTINEL_REFS;
  blocker: typeof MISS_INT06_LIVE;
  reason: string;
};

export type SentinelResult = {
  sentinelId: string;
  represented: boolean;
  outcome: "pass" | "fail" | "untested";
};

export type AcceptanceCriteria = {
  requiredSentinelIds: readonly string[];
  requiredBoundaries: readonly string[];
  failClosed: true;
};

export type AdmittedReleaseCombination = {
  id: string;
  admitted: boolean;
  live: boolean;
  opaqueRefs: readonly OpaqueSentinelRef[];
  fakeToken: string;
};

export type SupportedClaim = {
  boundaries: readonly string[];
};

export type UntestedBoundaryPolicy = "narrow" | "block-rollout";

export type SentinelSession = {
  combination: AdmittedReleaseCombination;
  results: readonly SentinelResult[];
  criteria: AcceptanceCriteria;
  supportedClaim: SupportedClaim;
  untestedBoundaryPolicy: UntestedBoundaryPolicy;
  liveRun: boolean;
  enabled: boolean;
  customerReleaseClaim: typeof CUSTOMER_RELEASE_BLOCKED | "ALLOWED" | "PUBLIC";
  hosts: readonly string[];
  spend: number;
};

export type SuitePass = {
  ok: true;
  schemaVersion: 1;
  kind: "int06.sentinel_suite";
  task: typeof INT_06_TASK;
  experimental: true;
  defaultOff: true;
  enabled: false;
  live_run: false;
  spend: 0;
  customer_release: typeof CUSTOMER_RELEASE_BLOCKED;
  ready_for_live: typeof READY_FOR_LIVE_BLOCKED_BY_D06;
  internal_only: true;
  proof_label: typeof PROOF_LABEL_INTERNAL;
  sentinelsRun: typeof SENTINELS_RUN_COMPLETE;
  representedSentinelIds: string[];
  supportedClaim: SupportedClaim;
  sealedCriteria: AcceptanceCriteria;
  miss: typeof MISS_INT06_LIVE;
  gaps: typeof INT_06_GAPS;
};

export type SentinelDenial = {
  ok: false;
  code: string;
  reason: string;
  experimental: true;
  defaultOff: true;
  enabled: false;
  live_run: false;
  spend: 0;
  internal_only: true;
  proof_label: typeof PROOF_LABEL_INTERNAL;
  customer_release: typeof CUSTOMER_RELEASE_BLOCKED;
  ready_for_live: typeof READY_FOR_LIVE_BLOCKED_BY_D06;
  sentinelsRun: SentinelsRun;
  miss: typeof MISS_INT06_LIVE;
  blocker?:
    | typeof MISS_INT06_LIVE
    | typeof MISS_SEC05_ISOLATION_UNPROVED
    | typeof MISS_STO05_COMPLETE_WIPE_UNPROVED;
  untestedBoundaries?: string[];
  narrowedClaim?: SupportedClaim;
  failedSentinelIds?: string[];
  sealedCriteria?: AcceptanceCriteria;
};

export type SuiteDecision = SuitePass | SentinelDenial;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuseReceipt(claim: unknown, message: string): never {
  throw new SentinelBoundaryError(message, "INT06_RECEIPT_REFUSED", { claim });
}

function expectLiteral<T>(claim: JsonRecord, key: string, expected: T): T {
  if (claim[key] !== expected) {
    refuseReceipt(
      claim,
      `INT-06 sentinel receipt ${key} must be ${JSON.stringify(expected)}; refused ${JSON.stringify(claim[key])}.`,
    );
  }
  return expected;
}

function expectGaps(claim: JsonRecord): typeof INT_06_GAPS {
  const value = claim.gaps;
  if (!Array.isArray(value) || value.length !== INT_06_GAPS.length) {
    refuseReceipt(claim, "INT-06 sentinel receipt gaps must list MISS-INT06-LIVE.");
  }
  for (let index = 0; index < INT_06_GAPS.length; index += 1) {
    if (value[index] !== INT_06_GAPS[index]) {
      refuseReceipt(
        claim,
        `INT-06 sentinel receipt gaps[${index}] must be ${JSON.stringify(INT_06_GAPS[index])}; refused ${JSON.stringify(value[index])}.`,
      );
    }
  }
  return INT_06_GAPS;
}

function expectOpaqueRefs(claim: JsonRecord): typeof OPAQUE_SENTINEL_REFS {
  const value = claim.opaqueRefs;
  if (!Array.isArray(value) || value.length !== OPAQUE_SENTINEL_REFS.length) {
    refuseReceipt(
      claim,
      "INT-06 sentinel receipt opaqueRefs must list EXE-02, DEV-07, SEC-05, FF-04, OBS-01, UI-02.",
    );
  }
  for (let index = 0; index < OPAQUE_SENTINEL_REFS.length; index += 1) {
    if (value[index] !== OPAQUE_SENTINEL_REFS[index]) {
      refuseReceipt(
        claim,
        `INT-06 sentinel receipt opaqueRefs[${index}] must be ${JSON.stringify(OPAQUE_SENTINEL_REFS[index])}; refused ${JSON.stringify(value[index])}.`,
      );
    }
  }
  return OPAQUE_SENTINEL_REFS;
}

function expectSentinelsRun(claim: JsonRecord): SentinelsRun {
  const value = claim.sentinelsRun;
  if (value !== SENTINELS_RUN_COMPLETE && value !== SENTINELS_RUN_INCOMPLETE) {
    refuseReceipt(
      claim,
      `INT-06 sentinel receipt sentinelsRun must be "complete" or "incomplete"; refused ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

export function criticalSentinelRegistry(): readonly CriticalSentinel[] {
  return CRITICAL_SENTINELS;
}

export function refuseLiveRun(claim: unknown): Int06DisabledReceipt {
  if (!isRecord(claim)) {
    refuseReceipt(claim, "INT-06 sentinel receipt must be an object.");
  }

  if (typeof claim.reason !== "string" || claim.reason.trim() === "") {
    refuseReceipt(claim, "INT-06 sentinel receipt reason must be a non-empty string.");
  }

  return {
    schemaVersion: expectLiteral(claim, "schemaVersion", 1),
    program: expectLiteral(claim, "program", "ELF-CH5"),
    impl: expectLiteral(claim, "impl", INT_06_IMPL),
    task: expectLiteral(claim, "task", INT_06_TASK),
    miss: expectLiteral(claim, "miss", MISS_INT06_LIVE),
    gaps: expectGaps(claim),
    sto05Miss: expectLiteral(claim, "sto05Miss", MISS_STO05_COMPLETE_WIPE_UNPROVED),
    sec05Miss: expectLiteral(claim, "sec05Miss", MISS_SEC05_ISOLATION_UNPROVED),
    sec03Miss: expectLiteral(claim, "sec03Miss", MISS_SEC03_OWNER_UNRESOLVED),
    gate: expectLiteral(claim, "gate", INT_06_GATE),
    status: expectLiteral(claim, "status", INT_06_STATUS_DISABLED),
    experimental: expectLiteral(claim, "experimental", true),
    defaultOff: expectLiteral(claim, "defaultOff", true),
    enabled: expectLiteral(claim, "enabled", false),
    live_run: expectLiteral(claim, "live_run", false),
    spend: expectLiteral(claim, "spend", 0),
    decision: expectLiteral(claim, "decision", "D08"),
    customer_release: expectLiteral(claim, "customer_release", CUSTOMER_RELEASE_BLOCKED),
    ready_for_live: expectLiteral(claim, "ready_for_live", READY_FOR_LIVE_BLOCKED_BY_D06),
    internal_only: expectLiteral(claim, "internal_only", true),
    proof_label: expectLiteral(claim, "proof_label", PROOF_LABEL_INTERNAL),
    con06Status: expectLiteral(claim, "con06Status", CON_06_STATUS_NOT_ACTIVATED),
    sentinelsRun: expectSentinelsRun(claim),
    opaqueRefs: expectOpaqueRefs(claim),
    blocker: expectLiteral(claim, "blocker", MISS_INT06_LIVE),
    reason: claim.reason,
  };
}

export function sentinelStateFromReceipt(receipt: Int06DisabledReceipt): {
  experimental: true;
  defaultOff: true;
  enabled: false;
  live_run: false;
  spend: 0;
  customer_release: typeof CUSTOMER_RELEASE_BLOCKED;
  ready_for_live: typeof READY_FOR_LIVE_BLOCKED_BY_D06;
  miss: typeof MISS_INT06_LIVE;
} {
  return {
    experimental: true,
    defaultOff: receipt.defaultOff,
    enabled: receipt.enabled,
    live_run: receipt.live_run,
    spend: receipt.spend,
    customer_release: receipt.customer_release,
    ready_for_live: receipt.ready_for_live,
    miss: receipt.miss,
  };
}

function deny(
  code: string,
  reason: string,
  extras: Omit<
    SentinelDenial,
    | "ok"
    | "code"
    | "reason"
    | "experimental"
    | "defaultOff"
    | "enabled"
    | "live_run"
    | "spend"
    | "internal_only"
    | "proof_label"
    | "customer_release"
    | "ready_for_live"
    | "miss"
    | "sentinelsRun"
  > & { sentinelsRun?: SentinelsRun } = {},
): SentinelDenial {
  const { sentinelsRun = SENTINELS_RUN_INCOMPLETE, ...rest } = extras;
  return {
    ok: false,
    code,
    reason,
    experimental: true,
    defaultOff: true,
    enabled: false,
    live_run: false,
    spend: 0,
    internal_only: true,
    proof_label: PROOF_LABEL_INTERNAL,
    customer_release: CUSTOMER_RELEASE_BLOCKED,
    ready_for_live: READY_FOR_LIVE_BLOCKED_BY_D06,
    sentinelsRun,
    miss: MISS_INT06_LIVE,
    ...rest,
  };
}

export function isFakeToken(token: string): boolean {
  return token.startsWith(FAKE_TOKEN_PREFIX) || token.startsWith(FAKE_PATH_PREFIX);
}

export function isNpmCh5MeHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === NPM_CH5_ME_HOST ||
    normalized.endsWith(`.${NPM_CH5_ME_HOST}`) ||
    normalized.includes(`://${NPM_CH5_ME_HOST}`) ||
    normalized.includes(`://${NPM_CH5_ME_HOST}/`)
  );
}

export function isSentinelDenial(value: object): value is SentinelDenial {
  return "ok" in value && value.ok === false;
}

export function defaultAcceptanceCriteria(): AcceptanceCriteria {
  return {
    requiredSentinelIds: [...CRITICAL_SENTINEL_IDS],
    requiredBoundaries: [...CRITICAL_BOUNDARIES],
    failClosed: true,
  };
}

function evaluateGate(session: SentinelSession): SentinelDenial | null {
  if (session.customerReleaseClaim !== CUSTOMER_RELEASE_BLOCKED) {
    return deny(
      SENTINEL_DENIAL.CUSTOMER_RELEASE_BLOCKED,
      "Customer release remains BLOCKED. Fixture sentinel proof is not a public live pass.",
      { blocker: MISS_SEC05_ISOLATION_UNPROVED },
    );
  }

  if (session.enabled) {
    return deny(
      SENTINEL_DENIAL.ADAPTER_DISABLED,
      "The INT-06 sentinel suite is experimental and default-off. Enabling a live suite is refused.",
      { blocker: MISS_INT06_LIVE },
    );
  }

  if (session.liveRun) {
    return deny(
      SENTINEL_DENIAL.LIVE_RUN_REFUSED,
      "INT-06 does not run a live suite against prod or an admitted live release combination. Fixture sentinels only; live is blocked by D06.",
      { blocker: MISS_INT06_LIVE },
    );
  }

  if (session.spend !== 0) {
    return deny(
      SENTINEL_DENIAL.LIVE_RUN_REFUSED,
      "INT-06 is zero-spend. Any non-zero spend claim is refused.",
      { blocker: MISS_INT06_LIVE },
    );
  }

  if (session.combination.live) {
    return deny(
      SENTINEL_DENIAL.LIVE_RUN_REFUSED,
      "An admitted live release combination is out of scope. Fixture combinations only.",
      { blocker: MISS_INT06_LIVE },
    );
  }

  if (!session.combination.admitted) {
    return deny(
      SENTINEL_DENIAL.COMBINATION_NOT_ADMITTED,
      "Sentinels run only against an admitted fixture release combination.",
      { blocker: MISS_INT06_LIVE },
    );
  }

  if (!isFakeToken(session.combination.fakeToken)) {
    return deny(
      SENTINEL_DENIAL.REAL_TOKEN_REFUSED,
      "Only fake tok_fx_int06_ tokens or fixture://int06/ refs are accepted.",
      { blocker: MISS_INT06_LIVE },
    );
  }

  const npmHost = session.hosts.find((host) => isNpmCh5MeHost(host));
  if (npmHost !== undefined) {
    return deny(
      SENTINEL_DENIAL.NPM_CH5_ME_REFUSED,
      "INT-06 is self-contained. npm.ch5.me peer fetch is refused.",
      { blocker: MISS_INT06_LIVE },
    );
  }

  return null;
}

function representedIds(session: SentinelSession): string[] {
  return session.results
    .filter((result) => result.represented && result.outcome !== "untested")
    .map((result) => result.sentinelId);
}

function failedIds(session: SentinelSession): string[] {
  return session.results
    .filter((result) => result.outcome === "fail")
    .map((result) => result.sentinelId);
}

function requiredSentinels(session: SentinelSession): readonly CriticalSentinel[] {
  const required = new Set(session.criteria.requiredSentinelIds);
  return CRITICAL_SENTINELS.filter((sentinel) => required.has(sentinel.id));
}

function untestedBoundaries(session: SentinelSession, represented: ReadonlySet<string>): string[] {
  const requiredBoundaries = new Set(session.criteria.requiredBoundaries);
  const claimed = session.supportedClaim.boundaries.filter((boundary) =>
    requiredBoundaries.has(boundary),
  );
  return claimed.filter((boundary) => {
    const sentinel = CRITICAL_SENTINELS.find((entry) => entry.boundary === boundary);
    return sentinel === undefined || !represented.has(sentinel.id);
  });
}

function inventsGreen(session: SentinelSession): boolean {
  return session.results.some((result) => result.outcome === "pass" && !result.represented);
}

/**
 * Fixture / synthetic sentinel suite. Never a live run. Completeness is
 * representation of critical security/identity/no-fallback sentinels against
 * an admitted fixture combination. Untested boundaries narrow or block.
 * Criteria are sealed with the run.
 */
export function runSentinelSuite(session: SentinelSession): SuiteDecision {
  const refused = evaluateGate(session);
  if (refused) {
    return refused;
  }

  if (session.criteria.failClosed !== true) {
    return deny(
      SENTINEL_DENIAL.POST_HOC_CRITERIA_CHANGE_REFUSED,
      "Acceptance criteria must stay fail-closed. Weakening failClosed is refused.",
      { blocker: MISS_INT06_LIVE },
    );
  }

  const represented = new Set(representedIds(session));
  if (inventsGreen(session)) {
    return deny(
      SENTINEL_DENIAL.INVENTED_GREEN_REFUSED,
      "A pass outcome is refused unless the sentinel was actually represented. INT-06 does not invent green.",
      { blocker: MISS_INT06_LIVE, failedSentinelIds: failedIds(session) },
    );
  }

  const required = requiredSentinels(session);
  const missing = required
    .filter((sentinel) => !represented.has(sentinel.id))
    .map((sentinel) => sentinel.id);
  const failed = failedIds(session).filter((id) =>
    session.criteria.requiredSentinelIds.includes(id),
  );
  const untested = untestedBoundaries(session, represented);
  const complete = missing.length === 0 && failed.length === 0 && untested.length === 0;
  const sentinelsRun: SentinelsRun = complete ? SENTINELS_RUN_COMPLETE : SENTINELS_RUN_INCOMPLETE;
  const sealedCriteria: AcceptanceCriteria = {
    requiredSentinelIds: [...session.criteria.requiredSentinelIds],
    requiredBoundaries: [...session.criteria.requiredBoundaries],
    failClosed: true,
  };

  if (failed.length > 0) {
    return deny(
      SENTINEL_DENIAL.ROLLOUT_BLOCKED,
      "A required sentinel failed. Failures stay visible; rollout is blocked and criteria must not change after the run.",
      {
        sentinelsRun,
        blocker: MISS_INT06_LIVE,
        failedSentinelIds: failed,
        untestedBoundaries: untested,
        sealedCriteria,
      },
    );
  }

  if (untested.length > 0) {
    if (session.untestedBoundaryPolicy === "block-rollout") {
      return deny(
        SENTINEL_DENIAL.ROLLOUT_BLOCKED,
        "An untested required boundary blocks rollout. INT-06 does not invent coverage.",
        {
          sentinelsRun,
          blocker: MISS_INT06_LIVE,
          untestedBoundaries: untested,
          sealedCriteria,
        },
      );
    }

    const narrowedBoundaries = session.supportedClaim.boundaries.filter(
      (boundary) => !untested.includes(boundary),
    );
    return deny(
      SENTINEL_DENIAL.UNTESTED_BOUNDARY_NARROWS,
      "An untested boundary narrows the supported claim. The untested surface is not part of the admitted claim.",
      {
        sentinelsRun,
        blocker: MISS_INT06_LIVE,
        untestedBoundaries: untested,
        narrowedClaim: { boundaries: narrowedBoundaries },
        sealedCriteria,
      },
    );
  }

  if (!complete) {
    return deny(
      SENTINEL_DENIAL.ROLLOUT_BLOCKED,
      "Critical sentinels are incomplete against the admitted fixture combination. Rollout stays blocked.",
      {
        sentinelsRun,
        blocker: MISS_INT06_LIVE,
        untestedBoundaries: untested,
        sealedCriteria,
      },
    );
  }

  return {
    ok: true,
    schemaVersion: 1,
    kind: "int06.sentinel_suite",
    task: INT_06_TASK,
    experimental: true,
    defaultOff: true,
    enabled: false,
    live_run: false,
    spend: 0,
    customer_release: CUSTOMER_RELEASE_BLOCKED,
    ready_for_live: READY_FOR_LIVE_BLOCKED_BY_D06,
    internal_only: true,
    proof_label: PROOF_LABEL_INTERNAL,
    sentinelsRun: SENTINELS_RUN_COMPLETE,
    representedSentinelIds: required.map((sentinel) => sentinel.id),
    supportedClaim: { boundaries: [...session.supportedClaim.boundaries] },
    sealedCriteria: {
      requiredSentinelIds: [...session.criteria.requiredSentinelIds],
      requiredBoundaries: [...session.criteria.requiredBoundaries],
      failClosed: true,
    },
    miss: MISS_INT06_LIVE,
    gaps: INT_06_GAPS,
  };
}

function criteriaEqual(left: AcceptanceCriteria, right: AcceptanceCriteria): boolean {
  if (left.failClosed !== right.failClosed) {
    return false;
  }
  if (left.requiredSentinelIds.length !== right.requiredSentinelIds.length) {
    return false;
  }
  if (left.requiredBoundaries.length !== right.requiredBoundaries.length) {
    return false;
  }
  return (
    left.requiredSentinelIds.every((id, index) => id === right.requiredSentinelIds[index]) &&
    left.requiredBoundaries.every((boundary, index) => boundary === right.requiredBoundaries[index])
  );
}

/**
 * Criteria are sealed with the run. Changing them afterward — including to
 * drop a failed or untested sentinel — is refused.
 */
export function refusePostHocCriteriaChange(
  run: SuiteDecision,
  nextCriteria: AcceptanceCriteria,
): SentinelDenial | SuiteDecision {
  const sealed = run.sealedCriteria;
  if (sealed !== undefined && criteriaEqual(sealed, nextCriteria)) {
    return run;
  }

  return deny(
    SENTINEL_DENIAL.POST_HOC_CRITERIA_CHANGE_REFUSED,
    "Acceptance criteria are sealed with the run. Changing them afterward to hide a failed or untested sentinel is refused.",
    {
      sentinelsRun: run.sentinelsRun,
      blocker: MISS_INT06_LIVE,
      failedSentinelIds: run.ok === false ? run.failedSentinelIds : undefined,
      untestedBoundaries: run.ok === false ? run.untestedBoundaries : undefined,
      sealedCriteria: sealed,
    },
  );
}

export function refuseLiveSuite(): SentinelDenial {
  return deny(
    SENTINEL_DENIAL.LIVE_RUN_REFUSED,
    "INT-06 does not run a live suite. Fixture / synthetic sentinels only; ready_for_live stays blocked_by_D06.",
    { blocker: MISS_INT06_LIVE },
  );
}
