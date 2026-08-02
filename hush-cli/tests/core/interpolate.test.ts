import { describe, it, expect } from "vitest";

import {
  interpolateValue,
  interpolateVars,
  hasUnresolvedVars,
  getUnresolvedVars,
} from "../../src/core/interpolate.js";

describe("interpolateValue", () => {
  it("replaces ${VAR} with context value", () => {
    const result = interpolateValue("Hello ${NAME}!", { NAME: "World" });
    expect(result).toBe("Hello World!");
  });

  it("replaces multiple variables", () => {
    const result = interpolateValue("${PROTO}://${HOST}:${PORT}", {
      PROTO: "https",
      HOST: "example.com",
      PORT: "443",
    });
    expect(result).toBe("https://example.com:443");
  });

  it("leaves unresolved variables unchanged", () => {
    const result = interpolateValue("${FOO} and ${BAR}", { FOO: "foo" });
    expect(result).toBe("foo and ${BAR}");
  });

  it("returns original value if no variables", () => {
    const result = interpolateValue("no variables", {});
    expect(result).toBe("no variables");
  });

  it("resolves ${env:VAR} from processEnv option", () => {
    const result = interpolateValue(
      "Home is ${env:HOME}",
      {},
      { processEnv: { HOME: "/home/user" } },
    );
    expect(result).toBe("Home is /home/user");
  });

  it("returns empty string for missing ${env:VAR}", () => {
    const result = interpolateValue("Missing: ${env:MISSING}", {}, { processEnv: {} });
    expect(result).toBe("Missing: ");
  });

  it("resolves ${VAR:-default} with default when VAR is missing", () => {
    const result = interpolateValue("${MISSING:-fallback}", {});
    expect(result).toBe("fallback");
  });

  it("resolves ${VAR:-default} with value when VAR exists", () => {
    const result = interpolateValue("${NAME:-fallback}", { NAME: "actual" });
    expect(result).toBe("actual");
  });

  it("uses default when VAR is empty string", () => {
    const result = interpolateValue("${EMPTY:-fallback}", { EMPTY: "" });
    expect(result).toBe("fallback");
  });

  it("handles default with special characters", () => {
    const result = interpolateValue("${MISSING:-http://localhost:3000}", {});
    expect(result).toBe("http://localhost:3000");
  });
});

describe("interpolateVars", () => {
  it("interpolates simple references", () => {
    const vars = [
      { key: "BASE_URL", value: "http://localhost" },
      { key: "API_URL", value: "${BASE_URL}/api" },
    ];
    const result = interpolateVars(vars);
    expect(result).toContainEqual({ key: "API_URL", value: "http://localhost/api" });
  });

  it("handles chain interpolation", () => {
    const vars = [
      { key: "HOST", value: "localhost" },
      { key: "PORT", value: "3000" },
      { key: "BASE", value: "http://${HOST}:${PORT}" },
      { key: "API", value: "${BASE}/api" },
    ];
    const result = interpolateVars(vars);
    expect(result).toContainEqual({ key: "API", value: "http://localhost:3000/api" });
  });

  it("preserves order of keys", () => {
    const vars = [
      { key: "A", value: "1" },
      { key: "B", value: "2" },
      { key: "C", value: "3" },
    ];
    const result = interpolateVars(vars);
    const keys = result.map((v) => v.key);
    expect(keys).toContain("A");
    expect(keys).toContain("B");
    expect(keys).toContain("C");
  });

  it("handles circular references gracefully", () => {
    const vars = [
      { key: "A", value: "${B}" },
      { key: "B", value: "${A}" },
    ];
    const result = interpolateVars(vars);
    expect(result.find((v) => v.key === "A")?.value).toContain("${");
    expect(result.find((v) => v.key === "B")?.value).toContain("${");
  });
});

describe("hasUnresolvedVars", () => {
  it("returns true for values with ${...} pattern", () => {
    expect(hasUnresolvedVars("${FOO}")).toBe(true);
    expect(hasUnresolvedVars("prefix ${BAR} suffix")).toBe(true);
  });

  it("returns false for values without ${...} pattern", () => {
    expect(hasUnresolvedVars("plain value")).toBe(false);
    expect(hasUnresolvedVars("$FOO")).toBe(false);
    expect(hasUnresolvedVars("")).toBe(false);
  });
});

describe("getUnresolvedVars", () => {
  it("returns keys with unresolved references", () => {
    const vars = [
      { key: "RESOLVED", value: "plain" },
      { key: "UNRESOLVED", value: "${MISSING}" },
      { key: "ALSO_GOOD", value: "test" },
    ];
    const result = getUnresolvedVars(vars);
    expect(result).toEqual(["UNRESOLVED"]);
  });

  it("returns empty array when all resolved", () => {
    const vars = [
      { key: "A", value: "a" },
      { key: "B", value: "b" },
    ];
    const result = getUnresolvedVars(vars);
    expect(result).toEqual([]);
  });
});

describe("interpolateVars with baseContext", () => {
  it("resolves variables from baseContext", () => {
    const vars = [{ key: "NEXT_PUBLIC_API", value: "${API_URL}" }];
    const result = interpolateVars(vars, { baseContext: { API_URL: "https://api.example.com" } });
    expect(result).toContainEqual({ key: "NEXT_PUBLIC_API", value: "https://api.example.com" });
    expect(result).toContainEqual({ key: "API_URL", value: "https://api.example.com" });
  });

  it("local vars take precedence over baseContext for same key", () => {
    const vars = [{ key: "DEBUG", value: "true" }];
    const result = interpolateVars(vars, { baseContext: { DEBUG: "false" } });
    expect(result.find((v) => v.key === "DEBUG")?.value).toBe("true");
  });

  it("self-reference with default uses baseContext when available", () => {
    const vars = [{ key: "PORT", value: "${PORT:-3000}" }];
    const result = interpolateVars(vars, { baseContext: { PORT: "8080" } });
    expect(result.find((v) => v.key === "PORT")?.value).toBe("8080");
  });

  it("self-reference with default uses default when baseContext is empty", () => {
    const vars = [{ key: "PORT", value: "${PORT:-3000}" }];
    const result = interpolateVars(vars, { baseContext: {} });
    expect(result.find((v) => v.key === "PORT")?.value).toBe("3000");
  });

  it("simple self-reference resolves from baseContext", () => {
    const vars = [{ key: "API_KEY", value: "${API_KEY}" }];
    const result = interpolateVars(vars, { baseContext: { API_KEY: "secret-123" } });
    expect(result.find((v) => v.key === "API_KEY")?.value).toBe("secret-123");
  });

  it("simple self-reference stays unresolved without baseContext value", () => {
    const vars = [{ key: "MISSING", value: "${MISSING}" }];
    const result = interpolateVars(vars, { baseContext: {} });
    expect(result.find((v) => v.key === "MISSING")?.value).toBe("${MISSING}");
  });

  it("mixes local vars, baseContext refs, and defaults", () => {
    const vars = [
      { key: "LOCAL", value: "local-value" },
      { key: "FROM_BASE", value: "${API_URL}" },
      { key: "WITH_DEFAULT", value: "${PORT:-3000}" },
      { key: "SELF_REF", value: "${SELF_REF:-fallback}" },
    ];
    const result = interpolateVars(vars, {
      baseContext: {
        API_URL: "https://api.example.com",
        PORT: "8080",
      },
    });

    expect(result.find((v) => v.key === "LOCAL")?.value).toBe("local-value");
    expect(result.find((v) => v.key === "FROM_BASE")?.value).toBe("https://api.example.com");
    expect(result.find((v) => v.key === "WITH_DEFAULT")?.value).toBe("8080");
    expect(result.find((v) => v.key === "SELF_REF")?.value).toBe("fallback");
  });
});

describe("interpolateValue edge cases", () => {
  it("does not support nested braces in default (known limitation)", () => {
    const result = interpolateValue("${VAR:-simple}", {});
    expect(result).toBe("simple");
  });

  it("handles multiple defaults in one string", () => {
    const result = interpolateValue("${A:-a}_${B:-b}_${C:-c}", {});
    expect(result).toBe("a_b_c");
  });

  it("partial match of defaults and context values", () => {
    const result = interpolateValue("${A:-default}_${B}", { B: "from-context" });
    expect(result).toBe("default_from-context");
  });

  it("handles very long default values", () => {
    const longDefault = "x".repeat(1000);
    const result = interpolateValue(`\${VAR:-${longDefault}}`, {});
    expect(result).toBe(longDefault);
  });

  it("handles unicode in variable values", () => {
    const result = interpolateValue("${EMOJI}", { EMOJI: "🚀" });
    expect(result).toBe("🚀");
  });

  it("handles unicode in default values", () => {
    const result = interpolateValue("${VAR:-🎉}", {});
    expect(result).toBe("🎉");
  });

  it("does not resolve $VAR syntax (only ${VAR})", () => {
    const result = interpolateValue("$VAR ${VAR}", { VAR: "value" });
    expect(result).toBe("$VAR value");
  });

  it("handles adjacent variables", () => {
    const result = interpolateValue("${A}${B}${C}", { A: "1", B: "2", C: "3" });
    expect(result).toBe("123");
  });
});
