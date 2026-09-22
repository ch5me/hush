import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CON_06_RECEIPT_RELATIVE_PATH,
  refuseIntegratedCon06Claim,
} from "../../src/mig01/con-06-consumer.js";
import {
  MEDIATION_DENIAL,
  MISS_SEC03_OWNER_UNRESOLVED,
  SEC_03_RECEIPT_RELATIVE_PATH,
  adapterStateFromReceipt,
  collectSecretLeaks,
  evaluateMediationAdapter,
  refuseEnabledMediationWithoutOwner,
  type MediationAdapterState,
  type MediationGrant,
  type SecretMediationSession,
} from "../../src/sec03/mediation.js";
import {
  CUSTOMER_RELEASE_BLOCKED,
  DECLARED_ACCESS_PATHS,
  FX_SEC05_AUTH_FAIL_NO_FALLBACK,
  FX_SEC05_CUSTOMER_RELEASE_BLOCKED,
  FX_SEC05_TENANT_SCOPE_ENFORCED,
  ISOLATION_DENIAL,
  IsolationBoundaryError,
  MISS_SEC05_ISOLATION_UNPROVED,
  PROOF_LABEL_INTERNAL,
  SEC_05_IMPL,
  SEC_05_RECEIPT_RELATIVE_PATH,
  SEC_05_STATUS_INTERNAL_ONLY,
  SEC_05_TASK,
  discloseUse,
  enforceIsolation,
  isolationStateFromReceipt,
  isIsolationDenial,
  keepMediationDisabledPathHonest,
  refuseCustomerRelease,
  type IsolationAccessPath,
  type IsolationFallbackAttempt,
  type IsolationGrant,
  type IsolationPrincipal,
  type IsolationSession,
} from "../../src/sec05/isolation.js";

const hushCliRoot = join(import.meta.dirname, "..", "..");
const repoRoot = join(hushCliRoot, "..");
const fixtureRoot = join(hushCliRoot, "tests", "fixtures", "sec05");
const receiptPath = join(repoRoot, SEC_05_RECEIPT_RELATIVE_PATH);
const sec03ReceiptPath = join(repoRoot, SEC_03_RECEIPT_RELATIVE_PATH);
const con06ReceiptPath = join(repoRoot, CON_06_RECEIPT_RELATIVE_PATH);
const fakeAllowedPath = join(fixtureRoot, "fake-customer-release-allowed.json");

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

function parseAdapter(value: unknown): MediationAdapterState {
  const adapter = expectRecord(value, "adapter");
  const ownership = expectRecord(adapter.ownership, "adapter.ownership");
  if (adapter.experimental !== true) {
    throw new Error("adapter.experimental must be true");
  }
  if (typeof adapter.defaultOff !== "boolean" || typeof adapter.enabled !== "boolean") {
    throw new Error("adapter.enabled and adapter.defaultOff must be booleans");
  }
  if (ownership.status === "resolved") {
    return {
      experimental: true,
      defaultOff: adapter.defaultOff,
      enabled: adapter.enabled,
      ownership: {
        status: "resolved",
        owner: expectString(ownership.owner, "ownership.owner"),
      },
    };
  }
  if (ownership.status !== "unresolved") {
    throw new Error("adapter.ownership.status must be resolved or unresolved");
  }
  return {
    experimental: true,
    defaultOff: adapter.defaultOff,
    enabled: adapter.enabled,
    ownership: {
      status: "unresolved",
      blocker: MISS_SEC03_OWNER_UNRESOLVED,
      reason: expectString(ownership.reason, "ownership.reason"),
    },
  };
}

function parsePolicy(value: unknown): MediationGrant[] {
  if (!Array.isArray(value)) {
    throw new Error("policy must be an array");
  }
  return value.map((entry, index) => {
    const grant = expectRecord(entry, `policy[${index}]`);
    return {
      destination: expectString(grant.destination, `policy[${index}].destination`),
      action: expectString(grant.action, `policy[${index}].action`),
      secretRef: expectString(grant.secretRef, `policy[${index}].secretRef`),
    };
  });
}

function parseAccessPath(value: unknown, label: string): IsolationAccessPath {
  const path = expectString(value, label);
  if (path !== "mediated.admit.use" && path !== "mediated.admit.materialize") {
    throw new Error(`${label} must be a declared isolation access path`);
  }
  return path;
}

function parseGrants(value: unknown, label: string): IsolationGrant[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => {
    const grant = expectRecord(entry, `${label}[${index}]`);
    return {
      owner: expectString(grant.owner, `${label}[${index}].owner`),
      tenant: expectString(grant.tenant, `${label}[${index}].tenant`),
      destination: expectString(grant.destination, `${label}[${index}].destination`),
      action: expectString(grant.action, `${label}[${index}].action`),
      secretRef: expectString(grant.secretRef, `${label}[${index}].secretRef`),
      accessPath: parseAccessPath(grant.accessPath, `${label}[${index}].accessPath`),
    };
  });
}

function parsePrincipal(value: unknown): IsolationPrincipal {
  const principal = expectRecord(value, "principal");
  return {
    owner: expectString(principal.owner, "principal.owner"),
    tenant: expectString(principal.tenant, "principal.tenant"),
    grants: parseGrants(principal.grants, "principal.grants"),
  };
}

function parseFallbacks(value: unknown): IsolationFallbackAttempt[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("fallbackAttempts must be an array");
  }
  return value.map((entry, index) => {
    const attempt = expectRecord(entry, `fallbackAttempts[${index}]`);
    const kind = attempt.kind;
    if (kind !== "local" && kind !== "cloud" && kind !== "provider") {
      throw new Error(`fallbackAttempts[${index}].kind must be local, cloud, or provider`);
    }
    return {
      kind,
      credentialRef: expectString(
        attempt.credentialRef,
        `fallbackAttempts[${index}].credentialRef`,
      ),
    };
  });
}

function parseBroader(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  const record = expectRecord(value, "broaderCredentials");
  const out: Record<string, string> = {};
  for (const [key, token] of Object.entries(record)) {
    out[key] = expectString(token, `broaderCredentials.${key}`);
  }
  return out;
}

function parseAuth(value: unknown): IsolationSession["auth"] {
  const auth = expectRecord(value, "auth");
  if (auth.status === "ok") {
    return { status: "ok" };
  }
  if (auth.status !== "fail") {
    throw new Error("auth.status must be ok or fail");
  }
  return { status: "fail", reason: expectString(auth.reason, "auth.reason") };
}

function parseDeclaredPaths(value: unknown): IsolationAccessPath[] {
  if (!Array.isArray(value)) {
    throw new Error("declaredAccessPaths must be an array");
  }
  return value.map((entry, index) => parseAccessPath(entry, `declaredAccessPaths[${index}]`));
}

function parseCustomerReleaseClaim(value: unknown): IsolationSession["customerReleaseClaim"] {
  if (value === "BLOCKED" || value === "ALLOWED" || value === "PUBLIC") {
    return value;
  }
  throw new Error("customerReleaseClaim must be BLOCKED, ALLOWED, or PUBLIC");
}

function sessionFromFixture(path: string): {
  id: string;
  fakeToken: string;
  session: IsolationSession;
  fixture: Record<string, unknown>;
  broaderFake: string[];
} {
  const fixture = expectRecord(loadJson(path), path);
  const secretRef = expectString(fixture.secretRef, "secretRef");
  const fakeToken = expectString(fixture.fakeToken, "fakeToken");
  const actor = fixture.actor;
  if (actor !== "worker" && actor !== "adversary" && actor !== "sink") {
    throw new Error("actor must be worker, adversary, or sink");
  }
  const resource = expectRecord(fixture.resource, "resource");
  const broaderCredentials = parseBroader(fixture.broaderCredentials);
  const mediation: SecretMediationSession = {
    actor,
    secretRef,
    adapter: parseAdapter(fixture.adapter),
    policy: parsePolicy(fixture.policy),
    vault: { secrets: { [secretRef]: fakeToken } },
  };
  return {
    id: expectString(fixture.id, "id"),
    fakeToken,
    fixture,
    broaderFake: Object.values(broaderCredentials),
    session: {
      mediation,
      principal: parsePrincipal(fixture.principal),
      resource: {
        owner: expectString(resource.owner, "resource.owner"),
        tenant: expectString(resource.tenant, "resource.tenant"),
        secretRef: expectString(resource.secretRef, "resource.secretRef"),
      },
      accessPath: expectString(fixture.accessPath, "accessPath"),
      auth: parseAuth(fixture.auth),
      declaredAccessPaths: parseDeclaredPaths(fixture.declaredAccessPaths),
      fallbackAttempts: parseFallbacks(fixture.fallbackAttempts),
      broaderCredentials,
      customerReleaseClaim: parseCustomerReleaseClaim(fixture.customerReleaseClaim),
    },
  };
}

function withPrincipal(
  session: IsolationSession,
  overlay: Partial<IsolationPrincipal>,
): IsolationSession {
  return {
    ...session,
    principal: {
      ...session.principal,
      ...overlay,
      grants: overlay.grants ?? session.principal.grants,
    },
  };
}

describe("SEC-05 tenant and data-disclosure isolation", () => {
  it("records an internal-only isolation receipt with customer_release BLOCKED", () => {
    const receipt = refuseCustomerRelease(loadJson(receiptPath));

    expect(receipt.task).toBe(SEC_05_TASK);
    expect(receipt.impl).toBe(SEC_05_IMPL);
    expect(receipt.status).toBe(SEC_05_STATUS_INTERNAL_ONLY);
    expect(receipt.internal_only).toBe(true);
    expect(receipt.proof_label).toBe(PROOF_LABEL_INTERNAL);
    expect(receipt.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(receipt.enabled).toBe(false);
    expect(receipt.spend).toBe(0);
    expect(receipt.con06Status).toBe("NOT_ACTIVATED");
    expect(receipt.ownership).toBe("unresolved");
    expect(receipt.miss).toBe(MISS_SEC05_ISOLATION_UNPROVED);
    expect(receipt.sec03Miss).toBe(MISS_SEC03_OWNER_UNRESOLVED);
    expect(receipt.blocker).toBe(MISS_SEC05_ISOLATION_UNPROVED);

    const state = isolationStateFromReceipt(receipt);
    expect(state.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(state.internal_only).toBe(true);
    expect(state.enabled).toBe(false);
    expect(state.ownership).toBe("unresolved");
    expect(state.sec03Miss).toBe(MISS_SEC03_OWNER_UNRESOLVED);
  });

  it("leaves CON-06 NOT_ACTIVATED and SEC-03 mediation disabled by unresolved ownership", () => {
    const con06 = refuseIntegratedCon06Claim(loadJson(con06ReceiptPath));
    expect(con06.status).toBe("NOT_ACTIVATED");
    expect(con06.pin).toBeNull();
    expect(con06.binding).toBeNull();
    expect(con06.spend).toBe(0);

    const sec03 = refuseEnabledMediationWithoutOwner(loadJson(sec03ReceiptPath));
    expect(sec03.enabled).toBe(false);
    expect(sec03.ownership).toBe("unresolved");
    expect(sec03.blocker).toBe(MISS_SEC03_OWNER_UNRESOLVED);

    const disabled = evaluateMediationAdapter(adapterStateFromReceipt(sec03));
    expect(disabled).not.toBeNull();
    expect(disabled?.code).toBe(MEDIATION_DENIAL.ADAPTER_DISABLED);
    expect(disabled?.blocker).toBe(MISS_SEC03_OWNER_UNRESOLVED);
  });

  it("refuses a fake customer-release ALLOWED claim", () => {
    const claim = loadJson(fakeAllowedPath);

    expect(() => refuseCustomerRelease(claim)).toThrow(IsolationBoundaryError);
    expect(() => refuseCustomerRelease(claim)).toThrow(/status must be "INTERNAL_ONLY"/);
  });

  it("FX-SEC05-tenant-scope-enforced: declared access paths enforce owner/tenant/grant scope", () => {
    const loaded = sessionFromFixture(join(fixtureRoot, `${FX_SEC05_TENANT_SCOPE_ENFORCED}.json`));
    expect(loaded.id).toBe(FX_SEC05_TENANT_SCOPE_ENFORCED);
    const { session, fakeToken, fixture } = loaded;
    const attempts = expectRecord(fixture.attempts, "attempts");
    const inScope = expectRecord(attempts.inScope, "attempts.inScope");
    const crossTenant = expectRecord(attempts.crossTenant, "attempts.crossTenant");
    const crossOwner = expectRecord(attempts.crossOwner, "attempts.crossOwner");
    const missingGrant = expectRecord(attempts.missingGrant, "attempts.missingGrant");
    const undeclaredPath = expectRecord(attempts.undeclaredPath, "attempts.undeclaredPath");

    expect(session.declaredAccessPaths).toEqual([...DECLARED_ACCESS_PATHS]);
    expect(session.customerReleaseClaim).toBe(CUSTOMER_RELEASE_BLOCKED);

    const allowed = discloseUse(
      expectString(inScope.destination, "inScope.destination"),
      expectString(inScope.action, "inScope.action"),
      session,
    );
    expect(allowed.ok).toBe(true);
    if (isIsolationDenial(allowed)) {
      throw new Error("expected in-scope owner/tenant/grant path to pass internally");
    }
    expect(allowed.internal_only).toBe(true);
    expect(allowed.proof_label).toBe(PROOF_LABEL_INTERNAL);
    expect(allowed.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(allowed.admitted).toBe(true);
    expect(allowed.spend).toBe(0);
    expect(allowed.tenant).toBe("acme");
    expect(allowed.owner).toBe("alice");

    const otherTenant = enforceIsolation(
      expectString(crossTenant.destination, "crossTenant.destination"),
      expectString(crossTenant.action, "crossTenant.action"),
      withPrincipal(session, {
        owner: expectString(crossTenant.owner, "crossTenant.owner"),
        tenant: expectString(crossTenant.tenant, "crossTenant.tenant"),
        grants: [],
      }),
    );
    expect(isIsolationDenial(otherTenant)).toBe(true);
    if (!isIsolationDenial(otherTenant)) {
      throw new Error("expected cross-tenant disclosure to be denied");
    }
    expect(otherTenant.code).toBe(ISOLATION_DENIAL.TENANT_SCOPE_DENIED);
    expect(otherTenant.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(otherTenant.internal_only).toBe(true);

    const otherOwner = enforceIsolation(
      expectString(crossOwner.destination, "crossOwner.destination"),
      expectString(crossOwner.action, "crossOwner.action"),
      withPrincipal(session, {
        owner: expectString(crossOwner.owner, "crossOwner.owner"),
        tenant: expectString(crossOwner.tenant, "crossOwner.tenant"),
        grants: [],
      }),
    );
    expect(isIsolationDenial(otherOwner)).toBe(true);
    if (!isIsolationDenial(otherOwner)) {
      throw new Error("expected cross-owner disclosure to be denied");
    }
    expect(otherOwner.code).toBe(ISOLATION_DENIAL.OWNER_SCOPE_DENIED);

    const noGrant = enforceIsolation(
      expectString(missingGrant.destination, "missingGrant.destination"),
      expectString(missingGrant.action, "missingGrant.action"),
      withPrincipal(session, { grants: [] }),
    );
    expect(isIsolationDenial(noGrant)).toBe(true);
    if (!isIsolationDenial(noGrant)) {
      throw new Error("expected missing grant to be denied");
    }
    expect(noGrant.code).toBe(ISOLATION_DENIAL.GRANT_SCOPE_DENIED);

    const undeclared = enforceIsolation(
      expectString(undeclaredPath.destination, "undeclaredPath.destination"),
      expectString(undeclaredPath.action, "undeclaredPath.action"),
      {
        ...session,
        accessPath: expectString(undeclaredPath.accessPath, "undeclaredPath.accessPath"),
      },
    );
    expect(isIsolationDenial(undeclared)).toBe(true);
    if (!isIsolationDenial(undeclared)) {
      throw new Error("expected undeclared access path to be denied");
    }
    expect(undeclared.code).toBe(ISOLATION_DENIAL.ACCESS_PATH_NOT_DECLARED);

    const visible = {
      allowed,
      otherTenant,
      otherOwner,
      noGrant,
      undeclared,
    };
    expect(collectSecretLeaks(visible, session.mediation.vault)).toEqual([]);
    expect(JSON.stringify(visible)).not.toContain(fakeToken);
  });

  it("FX-SEC05-auth-fail-no-fallback: auth failure cannot trigger local/cloud/provider fallback or broader credentials", () => {
    const loaded = sessionFromFixture(join(fixtureRoot, `${FX_SEC05_AUTH_FAIL_NO_FALLBACK}.json`));
    expect(loaded.id).toBe(FX_SEC05_AUTH_FAIL_NO_FALLBACK);
    const { session, fakeToken, fixture, broaderFake } = loaded;
    const attempts = expectRecord(fixture.attempts, "attempts");
    const admittedPath = expectRecord(attempts.admittedPath, "attempts.admittedPath");

    expect(session.auth.status).toBe("fail");
    expect(session.fallbackAttempts.map((attempt) => attempt.kind)).toEqual([
      "local",
      "cloud",
      "provider",
    ]);
    expect(Object.keys(session.broaderCredentials)).toEqual(["shared-root"]);

    const denied = enforceIsolation(
      expectString(admittedPath.destination, "admittedPath.destination"),
      expectString(admittedPath.action, "admittedPath.action"),
      session,
    );
    expect(isIsolationDenial(denied)).toBe(true);
    if (!isIsolationDenial(denied)) {
      throw new Error("expected auth failure to fail closed");
    }
    expect(denied.code).toBe(ISOLATION_DENIAL.AUTH_FAIL_NO_FALLBACK);
    expect(denied.fallbacksRefused).toEqual(["local", "cloud", "provider", "broader"]);
    expect(denied.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(denied.internal_only).toBe(true);
    expect(denied.spend).toBe(0);

    const disclosed = discloseUse(
      expectString(admittedPath.destination, "admittedPath.destination"),
      expectString(admittedPath.action, "admittedPath.action"),
      session,
    );
    expect(isIsolationDenial(disclosed)).toBe(true);
    if (!isIsolationDenial(disclosed)) {
      throw new Error("expected discloseUse to refuse auth-fail fallback");
    }
    expect(disclosed.code).toBe(ISOLATION_DENIAL.AUTH_FAIL_NO_FALLBACK);

    const visible = { denied, disclosed };
    expect(collectSecretLeaks(visible, session.mediation.vault)).toEqual([]);
    expect(JSON.stringify(visible)).not.toContain(fakeToken);
    for (const token of broaderFake) {
      expect(JSON.stringify(visible)).not.toContain(token);
    }
  });

  it("FX-SEC05-customer-release-blocked: customer release stays BLOCKED; mediation disabled path stays honest", () => {
    const loaded = sessionFromFixture(
      join(fixtureRoot, `${FX_SEC05_CUSTOMER_RELEASE_BLOCKED}.json`),
    );
    expect(loaded.id).toBe(FX_SEC05_CUSTOMER_RELEASE_BLOCKED);
    const { session, fakeToken, fixture } = loaded;
    expect(fixture.attemptCustomerRelease).toBe("ALLOWED");
    expect(fixture.inventVault).toBe(true);
    expect(session.customerReleaseClaim).toBe("ALLOWED");
    expect(session.mediation.adapter.ownership.status).toBe("unresolved");

    const attempts = expectRecord(fixture.attempts, "attempts");
    const activation = expectRecord(attempts.customerActivation, "attempts.customerActivation");
    const destination = expectString(activation.destination, "customerActivation.destination");
    const action = expectString(activation.action, "customerActivation.action");

    const claimed = enforceIsolation(destination, action, session);
    expect(isIsolationDenial(claimed)).toBe(true);
    if (!isIsolationDenial(claimed)) {
      throw new Error("expected customer-release ALLOWED claim to stay BLOCKED");
    }
    expect(claimed.code).toBe(ISOLATION_DENIAL.CUSTOMER_RELEASE_BLOCKED);
    expect(claimed.blocker).toBe(MISS_SEC05_ISOLATION_UNPROVED);
    expect(claimed.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);
    expect(claimed.internal_only).toBe(true);
    expect(claimed.proof_label).toBe(PROOF_LABEL_INTERNAL);

    const honestDisabled = enforceIsolation(destination, action, {
      ...session,
      customerReleaseClaim: CUSTOMER_RELEASE_BLOCKED,
    });
    expect(isIsolationDenial(honestDisabled)).toBe(true);
    if (!isIsolationDenial(honestDisabled)) {
      throw new Error("expected unresolved mediation ownership to keep isolation disabled");
    }
    expect(honestDisabled.code).toBe(ISOLATION_DENIAL.ADAPTER_DISABLED);
    expect(honestDisabled.blocker).toBe(MISS_SEC03_OWNER_UNRESOLVED);
    expect(honestDisabled.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);

    const invented = keepMediationDisabledPathHonest();
    expect(invented.ok).toBe(false);
    expect(invented.code).toBe(ISOLATION_DENIAL.INVENTED_VAULT_REFUSED);
    expect(invented.blocker).toBe(MISS_SEC03_OWNER_UNRESOLVED);
    expect(invented.customer_release).toBe(CUSTOMER_RELEASE_BLOCKED);

    expect(() =>
      refuseCustomerRelease({
        ...expectRecord(loadJson(receiptPath), "receipt"),
        customer_release: "ALLOWED",
        internal_only: false,
        proof_label: "public",
        ownership: "fixture-invented-owner",
        enabled: true,
      }),
    ).toThrow(
      /customer_release must be "BLOCKED"|internal_only must be true|ownership must be "unresolved"|enabled must be false/,
    );

    const visible = { claimed, honestDisabled, invented };
    expect(collectSecretLeaks(visible, session.mediation.vault)).toEqual([]);
    expect(JSON.stringify(visible)).not.toContain(fakeToken);
  });
});
