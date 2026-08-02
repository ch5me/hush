import { describe, it, expect } from "vitest";

import { mergeVars } from "../../src/core/merge.js";
import type { EnvVar } from "../../src/types.js";

describe("mergeVars", () => {
  it("merges two arrays of vars", () => {
    const a: EnvVar[] = [
      { key: "FOO", value: "a" },
      { key: "BAR", value: "b" },
    ];
    const b: EnvVar[] = [{ key: "BAZ", value: "c" }];
    const result = mergeVars(a, b);
    expect(result).toHaveLength(3);
    expect(result).toContainEqual({ key: "FOO", value: "a" });
    expect(result).toContainEqual({ key: "BAR", value: "b" });
    expect(result).toContainEqual({ key: "BAZ", value: "c" });
  });

  it("later arrays override earlier ones", () => {
    const a: EnvVar[] = [{ key: "FOO", value: "original" }];
    const b: EnvVar[] = [{ key: "FOO", value: "overridden" }];
    const result = mergeVars(a, b);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "FOO", value: "overridden" });
  });

  it("handles three arrays with cascading overrides", () => {
    const shared: EnvVar[] = [
      { key: "FOO", value: "shared" },
      { key: "SHARED_ONLY", value: "shared" },
    ];
    const env: EnvVar[] = [
      { key: "FOO", value: "env" },
      { key: "ENV_ONLY", value: "env" },
    ];
    const local: EnvVar[] = [
      { key: "FOO", value: "local" },
      { key: "LOCAL_ONLY", value: "local" },
    ];
    const result = mergeVars(shared, env, local);
    expect(result).toHaveLength(4);
    expect(result.find((v) => v.key === "FOO")?.value).toBe("local");
    expect(result.find((v) => v.key === "SHARED_ONLY")?.value).toBe("shared");
    expect(result.find((v) => v.key === "ENV_ONLY")?.value).toBe("env");
    expect(result.find((v) => v.key === "LOCAL_ONLY")?.value).toBe("local");
  });

  it("handles empty arrays", () => {
    const result = mergeVars([], [], []);
    expect(result).toEqual([]);
  });

  it("handles single array", () => {
    const vars: EnvVar[] = [{ key: "FOO", value: "bar" }];
    const result = mergeVars(vars);
    expect(result).toEqual([{ key: "FOO", value: "bar" }]);
  });

  it("handles no arguments", () => {
    const result = mergeVars();
    expect(result).toEqual([]);
  });
});
