import { describe, it, expect } from "vitest";

import { computeDiff, isInSync } from "../src/lib/diff.js";
import type { EnvVar } from "../src/types.js";

describe("computeDiff", () => {
  it("returns empty diff when both are identical", () => {
    const source: EnvVar[] = [
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ];
    const encrypted: EnvVar[] = [
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ];

    const diff = computeDiff(source, encrypted);

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(isInSync(diff)).toBe(true);
  });

  it("detects added keys", () => {
    const source: EnvVar[] = [
      { key: "FOO", value: "bar" },
      { key: "NEW_KEY", value: "new_value" },
    ];
    const encrypted: EnvVar[] = [{ key: "FOO", value: "bar" }];

    const diff = computeDiff(source, encrypted);

    expect(diff.added).toEqual(["NEW_KEY"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(isInSync(diff)).toBe(false);
  });

  it("detects removed keys", () => {
    const source: EnvVar[] = [{ key: "FOO", value: "bar" }];
    const encrypted: EnvVar[] = [
      { key: "FOO", value: "bar" },
      { key: "OLD_KEY", value: "old_value" },
    ];

    const diff = computeDiff(source, encrypted);

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual(["OLD_KEY"]);
    expect(diff.changed).toEqual([]);
    expect(isInSync(diff)).toBe(false);
  });

  it("detects changed keys", () => {
    const source: EnvVar[] = [{ key: "FOO", value: "new_value" }];
    const encrypted: EnvVar[] = [{ key: "FOO", value: "old_value" }];

    const diff = computeDiff(source, encrypted);

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual(["FOO"]);
    expect(isInSync(diff)).toBe(false);
  });

  it("detects multiple changes at once", () => {
    const source: EnvVar[] = [
      { key: "EXISTING", value: "changed" },
      { key: "NEW", value: "new_val" },
    ];
    const encrypted: EnvVar[] = [
      { key: "EXISTING", value: "original" },
      { key: "OLD", value: "to_remove" },
    ];

    const diff = computeDiff(source, encrypted);

    expect(diff.added).toEqual(["NEW"]);
    expect(diff.removed).toEqual(["OLD"]);
    expect(diff.changed).toEqual(["EXISTING"]);
  });

  it("ignores key ordering differences", () => {
    const source: EnvVar[] = [
      { key: "B", value: "2" },
      { key: "A", value: "1" },
    ];
    const encrypted: EnvVar[] = [
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ];

    const diff = computeDiff(source, encrypted);

    expect(isInSync(diff)).toBe(true);
  });

  it("handles empty source", () => {
    const source: EnvVar[] = [];
    const encrypted: EnvVar[] = [{ key: "FOO", value: "bar" }];

    const diff = computeDiff(source, encrypted);

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual(["FOO"]);
    expect(diff.changed).toEqual([]);
  });

  it("handles empty encrypted", () => {
    const source: EnvVar[] = [{ key: "FOO", value: "bar" }];
    const encrypted: EnvVar[] = [];

    const diff = computeDiff(source, encrypted);

    expect(diff.added).toEqual(["FOO"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("handles both empty", () => {
    const diff = computeDiff([], []);

    expect(isInSync(diff)).toBe(true);
  });

  it("treats whitespace differences in values as changes", () => {
    const source: EnvVar[] = [{ key: "FOO", value: "bar " }];
    const encrypted: EnvVar[] = [{ key: "FOO", value: "bar" }];

    const diff = computeDiff(source, encrypted);

    expect(diff.changed).toEqual(["FOO"]);
  });

  it("sorts keys alphabetically in output", () => {
    const source: EnvVar[] = [
      { key: "C_NEW", value: "c" },
      { key: "A_NEW", value: "a" },
      { key: "B_NEW", value: "b" },
    ];
    const encrypted: EnvVar[] = [];

    const diff = computeDiff(source, encrypted);

    expect(diff.added).toEqual(["A_NEW", "B_NEW", "C_NEW"]);
  });
});

describe("isInSync", () => {
  it("returns true when all arrays are empty", () => {
    expect(isInSync({ added: [], removed: [], changed: [] })).toBe(true);
  });

  it("returns false when added is not empty", () => {
    expect(isInSync({ added: ["KEY"], removed: [], changed: [] })).toBe(false);
  });

  it("returns false when removed is not empty", () => {
    expect(isInSync({ added: [], removed: ["KEY"], changed: [] })).toBe(false);
  });

  it("returns false when changed is not empty", () => {
    expect(isInSync({ added: [], removed: [], changed: ["KEY"] })).toBe(false);
  });
});

describe("security: never expose secret values", () => {
  it("diff output contains only key names, never values", () => {
    const secretValue = "super_secret_password_123!@#";
    const source: EnvVar[] = [
      { key: "SECRET_KEY", value: secretValue },
      { key: "NEW_KEY", value: "another_secret_value" },
    ];
    const encrypted: EnvVar[] = [
      { key: "SECRET_KEY", value: "old_secret" },
      { key: "REMOVED_KEY", value: "removed_value" },
    ];

    const diff = computeDiff(source, encrypted);
    const diffString = JSON.stringify(diff);

    expect(diffString).not.toContain(secretValue);
    expect(diffString).not.toContain("another_secret_value");
    expect(diffString).not.toContain("old_secret");
    expect(diffString).not.toContain("removed_value");

    expect(diff.added).toContain("NEW_KEY");
    expect(diff.removed).toContain("REMOVED_KEY");
    expect(diff.changed).toContain("SECRET_KEY");
  });
});
