import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CON_06_RECEIPT_RELATIVE_PATH,
  refuseIntegratedCon06Claim,
} from "../../src/mig01/con-06-consumer.js";
import {
  FX_SEC03_ADVERSARY_NO_SECRET,
  FX_SEC03_HIDE_NOT_AUTHORIZE,
  FX_SEC03_UNRESOLVED_OWNER_DISABLED,
  MEDIATION_DENIAL,
  MISS_SEC03_OWNER_UNRESOLVED,
  SEC02_USE_PROJECTION_KIND,
  SEC_03_IMPL,
  SEC_03_RECEIPT_RELATIVE_PATH,
  SEC_03_STATUS_DISABLED,
  SEC_03_TASK,
  adapterStateFromReceipt,
  admit,
  authorizeFromHiddenCredential,
  collectSecretLeaks,
  evaluateMediationAdapter,
  hideCredential,
  isMediationDenial,
  materializeUse,
  projectUse,
  refuseEnabledMediationWithoutOwner,
  refuseInventedVault,
  requestRawSecret,
  workerVisiblePayload,
  type HiddenCredentialView,
  type MediationAdapterState,
  type MediationGrant,
  type SecretMediationSession,
} from "../../src/sec03/mediation.js";

const hushCliRoot = join(import.meta.dirname, "..", "..");
const repoRoot = join(hushCliRoot, "..");
const fixtureRoot = join(hushCliRoot, "tests", "fixtures", "sec03");
const receiptPath = join(repoRoot, SEC_03_RECEIPT_RELATIVE_PATH);
const con06ReceiptPath = join(repoRoot, CON_06_RECEIPT_RELATIVE_PATH);

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

function parseHiddenView(value: unknown): HiddenCredentialView {
  const view = expectRecord(value, "hiddenView");
  if (view.hidden !== true || view.masked !== "********") {
    throw new Error("hiddenView must be a redacted credential handle");
  }
  return {
    secretRef: expectString(view.secretRef, "hiddenView.secretRef"),
    hidden: true,
    masked: "********",
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

function sessionFromFixture(path: string): {
  id: string;
  fakeToken: string;
  session: SecretMediationSession;
  fixture: Record<string, unknown>;
} {
  const fixture = expectRecord(loadJson(path), path);
  const secretRef = expectString(fixture.secretRef, "secretRef");
  const fakeToken = expectString(fixture.fakeToken, "fakeToken");
  const actor = fixture.actor;
  if (actor !== "worker" && actor !== "adversary" && actor !== "sink") {
    throw new Error("actor must be worker, adversary, or sink");
  }
  return {
    id: expectString(fixture.id, "id"),
    fakeToken,
    fixture,
    session: {
      actor,
      secretRef,
      adapter: parseAdapter(fixture.adapter),
      policy: parsePolicy(fixture.policy),
      vault: { secrets: { [secretRef]: fakeToken } },
    },
  };
}

describe("SEC-03 secret-mediation boundary", () => {
  it("records an experimental default-off adapter disabled by unresolved ownership", () => {
    const receipt = refuseEnabledMediationWithoutOwner(loadJson(receiptPath));

    expect(receipt.task).toBe(SEC_03_TASK);
    expect(receipt.impl).toBe(SEC_03_IMPL);
    expect(receipt.status).toBe(SEC_03_STATUS_DISABLED);
    expect(receipt.enabled).toBe(false);
    expect(receipt.experimental).toBe(true);
    expect(receipt.defaultOff).toBe(true);
    expect(receipt.spend).toBe(0);
    expect(receipt.con06Status).toBe("NOT_ACTIVATED");
    expect(receipt.ownership).toBe("unresolved");
    expect(receipt.blocker).toBe(MISS_SEC03_OWNER_UNRESOLVED);
    expect(receipt.miss).toBe(MISS_SEC03_OWNER_UNRESOLVED);

    const disabled = evaluateMediationAdapter(adapterStateFromReceipt(receipt));
    expect(disabled).not.toBeNull();
    expect(disabled?.code).toBe(MEDIATION_DENIAL.ADAPTER_DISABLED);
    expect(disabled?.blocker).toBe(MISS_SEC03_OWNER_UNRESOLVED);
  });

  it("leaves the CON-06 consumer row NOT_ACTIVATED", () => {
    const receipt = refuseIntegratedCon06Claim(loadJson(con06ReceiptPath));
    expect(receipt.status).toBe("NOT_ACTIVATED");
    expect(receipt.pin).toBeNull();
    expect(receipt.binding).toBeNull();
    expect(receipt.experimentalImports).toBe(false);
  });

  it("FX-SEC03-adversary-no-secret: adversary cannot obtain the secret or use it outside an admitted destination/action", () => {
    const loaded = sessionFromFixture(join(fixtureRoot, `${FX_SEC03_ADVERSARY_NO_SECRET}.json`));
    expect(loaded.id).toBe(FX_SEC03_ADVERSARY_NO_SECRET);
    const { session, fakeToken, fixture } = loaded;
    const attempts = expectRecord(fixture.attempts, "attempts");
    const unlisted = expectRecord(attempts.unlisted, "attempts.unlisted");
    const divert = expectRecord(attempts.admittedThenDivert, "attempts.admittedThenDivert");

    const raw = requestRawSecret(session);
    expect(raw.ok).toBe(false);
    expect(raw.code).toBe(MEDIATION_DENIAL.WORKER_SECRET_REFUSED);

    const projected = projectUse(null, session);
    expect(isMediationDenial(projected)).toBe(true);
    if (!isMediationDenial(projected)) {
      throw new Error("expected use projection without admit to be denied");
    }
    expect(projected.code).toBe(MEDIATION_DENIAL.ADMIT_REQUIRED);

    const materialized = materializeUse(null, session);
    expect(isMediationDenial(materialized)).toBe(true);
    if (!isMediationDenial(materialized)) {
      throw new Error("expected materialization without admit to be denied");
    }
    expect(materialized.code).toBe(MEDIATION_DENIAL.ADMIT_REQUIRED);

    const unlistedAdmit = admit(
      expectString(unlisted.destination, "unlisted.destination"),
      expectString(unlisted.action, "unlisted.action"),
      session,
    );
    expect(unlistedAdmit.ok).toBe(false);
    if (!isMediationDenial(unlistedAdmit)) {
      throw new Error("expected unlisted destination admit to fail");
    }
    expect(unlistedAdmit.code).toBe(MEDIATION_DENIAL.DESTINATION_ACTION_NOT_ADMITTED);

    const diversionAfterAdmit = materializeUse(unlistedAdmit, session);
    expect(isMediationDenial(diversionAfterAdmit)).toBe(true);

    const admitted = admit(
      expectString(divert.destination, "admitted.destination"),
      expectString(divert.action, "admitted.action"),
      session,
    );
    expect(admitted.ok).toBe(true);

    const forged = {
      ok: true as const,
      destination: expectString(divert.divertDestination, "divertDestination"),
      action: expectString(divert.divertAction, "divertAction"),
      secretRef: session.secretRef,
    };
    const diverted = materializeUse(forged, session);
    expect(isMediationDenial(diverted)).toBe(true);
    if (!isMediationDenial(diverted)) {
      throw new Error("expected diverted destination to be refused");
    }
    expect(diverted.code).toBe(MEDIATION_DENIAL.ADMIT_REQUIRED);

    const sink = materializeUse(admitted, session);
    if (isMediationDenial(sink)) {
      throw new Error("expected admitted sink apply to succeed");
    }
    expect(sink.applied).toBe(true);
    expect(sink.workerVisible.kind).toBe(SEC02_USE_PROJECTION_KIND);
    expect(sink.workerVisible.materialPresent).toBe(false);
    expect(sink.workerVisible.admitted).toBe(true);

    const visible = workerVisiblePayload({
      raw,
      projected,
      materialized,
      unlistedAdmit,
      diverted,
      workerVisible: sink.workerVisible,
    });
    expect(collectSecretLeaks(visible, session.vault)).toEqual([]);
    expect(JSON.stringify(visible)).not.toContain(fakeToken);
  });

  it("FX-SEC03-hide-not-authorize: hiding a credential does not authorize arbitrary service effects", () => {
    const loaded = sessionFromFixture(join(fixtureRoot, `${FX_SEC03_HIDE_NOT_AUTHORIZE}.json`));
    expect(loaded.id).toBe(FX_SEC03_HIDE_NOT_AUTHORIZE);
    const { session, fakeToken, fixture } = loaded;
    const hiddenView = parseHiddenView(fixture.hiddenView);
    const arbitrary = expectRecord(fixture.arbitraryEffect, "arbitraryEffect");
    const destination = expectString(arbitrary.destination, "arbitraryEffect.destination");
    const action = expectString(arbitrary.action, "arbitraryEffect.action");

    const hidden = hideCredential(session.secretRef);
    expect(hidden).toEqual({
      secretRef: session.secretRef,
      hidden: true,
      masked: "********",
    });
    expect(hiddenView.hidden).toBe(true);

    const fromHide = authorizeFromHiddenCredential(hidden, destination, action);
    expect(fromHide.ok).toBe(false);
    expect(fromHide.code).toBe(MEDIATION_DENIAL.HIDE_IS_NOT_AUTHORIZE);

    const fromFixtureView = authorizeFromHiddenCredential(hiddenView, destination, action);
    expect(fromFixtureView.code).toBe(MEDIATION_DENIAL.HIDE_IS_NOT_AUTHORIZE);

    const hiddenAdmit = admit(destination, action, session);
    expect(isMediationDenial(hiddenAdmit)).toBe(true);
    if (!isMediationDenial(hiddenAdmit)) {
      throw new Error("expected hidden credential not to admit arbitrary effects");
    }
    expect(hiddenAdmit.code).toBe(MEDIATION_DENIAL.DESTINATION_ACTION_NOT_ADMITTED);

    const granted = session.policy[0];
    if (granted === undefined) {
      throw new Error("hide-not-authorize fixture must declare a policy grant");
    }
    const admitted = admit(granted.destination, granted.action, session);
    const projection = projectUse(admitted, session);
    if (isMediationDenial(projection)) {
      throw new Error("expected admitted use projection");
    }
    expect(projection.kind).toBe(SEC02_USE_PROJECTION_KIND);
    expect(projection.materialPresent).toBe(false);

    const hideDoesNotWiden = authorizeFromHiddenCredential(
      hideCredential(projection.secretRef),
      destination,
      action,
    );
    expect(hideDoesNotWiden.code).toBe(MEDIATION_DENIAL.HIDE_IS_NOT_AUTHORIZE);

    const visible = workerVisiblePayload({
      hidden,
      fromHide,
      fromFixtureView,
      hiddenAdmit,
      projection,
      hideDoesNotWiden,
    });
    expect(collectSecretLeaks(visible, session.vault)).toEqual([]);
    expect(JSON.stringify(visible)).not.toContain(fakeToken);
  });

  it("FX-SEC03-unresolved-owner-disabled: unresolved ownership keeps the adapter disabled and refuses an invented vault", () => {
    const loaded = sessionFromFixture(
      join(fixtureRoot, `${FX_SEC03_UNRESOLVED_OWNER_DISABLED}.json`),
    );
    expect(loaded.id).toBe(FX_SEC03_UNRESOLVED_OWNER_DISABLED);
    const { session, fakeToken, fixture } = loaded;
    expect(fixture.attemptEnable).toBe(true);
    expect(fixture.inventVault).toBe(true);
    expect(session.adapter.enabled).toBe(true);

    const evaluated = evaluateMediationAdapter(session.adapter);
    expect(evaluated).not.toBeNull();
    expect(evaluated?.code).toBe(MEDIATION_DENIAL.ADAPTER_DISABLED);
    expect(evaluated?.blocker).toBe(MISS_SEC03_OWNER_UNRESOLVED);

    const granted = session.policy[0];
    if (granted === undefined) {
      throw new Error("unresolved-owner fixture must declare a policy grant");
    }
    const admission = admit(granted.destination, granted.action, session);
    expect(isMediationDenial(admission)).toBe(true);
    if (!isMediationDenial(admission)) {
      throw new Error("expected unresolved-owner adapter to refuse admit");
    }
    expect(admission.code).toBe(MEDIATION_DENIAL.ADAPTER_DISABLED);
    expect(admission.blocker).toBe(MISS_SEC03_OWNER_UNRESOLVED);

    expect(isMediationDenial(projectUse(null, session))).toBe(true);
    expect(isMediationDenial(materializeUse(null, session))).toBe(true);

    const invented = refuseInventedVault();
    expect(invented.ok).toBe(false);
    expect(invented.code).toBe(MEDIATION_DENIAL.INVENTED_VAULT_REFUSED);
    expect(invented.blocker).toBe(MISS_SEC03_OWNER_UNRESOLVED);

    expect(() =>
      refuseEnabledMediationWithoutOwner({
        ...expectRecord(loadJson(receiptPath), "receipt"),
        enabled: true,
        status: "ENABLED",
        ownership: "fixture-invented-owner",
      }),
    ).toThrow(/enabled must be false|status must be|ownership must be/);

    const visible = workerVisiblePayload({ evaluated, admission, invented });
    expect(collectSecretLeaks(visible, session.vault)).toEqual([]);
    expect(JSON.stringify(visible)).not.toContain(fakeToken);
  });
});
