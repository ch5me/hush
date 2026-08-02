import { describe, it, expect } from "vitest";

import { parseEnvContent, varsToRecord, recordToVars } from "../../src/core/parse.js";

describe("parseEnvContent", () => {
  it("parses simple key=value pairs", () => {
    const content = `FOO=bar
BAZ=qux`;
    const result = parseEnvContent(content);
    expect(result).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("ignores empty lines and comments", () => {
    const content = `# This is a comment
FOO=bar

# Another comment
BAZ=qux
`;
    const result = parseEnvContent(content);
    expect(result).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("handles quoted values", () => {
    const content = `SINGLE='single quoted'
DOUBLE="double quoted"
UNQUOTED=unquoted value`;
    const result = parseEnvContent(content);
    expect(result).toEqual([
      { key: "SINGLE", value: "single quoted" },
      { key: "DOUBLE", value: "double quoted" },
      { key: "UNQUOTED", value: "unquoted value" },
    ]);
  });

  it("handles values with equals signs", () => {
    const content = `URL=postgres://user:pass@host/db?foo=bar`;
    const result = parseEnvContent(content);
    expect(result).toEqual([{ key: "URL", value: "postgres://user:pass@host/db?foo=bar" }]);
  });

  it("handles empty values", () => {
    const content = `EMPTY=
ALSO_EMPTY=""`;
    const result = parseEnvContent(content);
    expect(result).toEqual([
      { key: "EMPTY", value: "" },
      { key: "ALSO_EMPTY", value: "" },
    ]);
  });

  it("returns empty array for empty content", () => {
    const result = parseEnvContent("");
    expect(result).toEqual([]);
  });

  it("skips lines without equals sign", () => {
    const content = `VALID=value
INVALID_LINE_NO_EQUALS
ALSO_VALID=test`;
    const result = parseEnvContent(content);
    expect(result).toEqual([
      { key: "VALID", value: "value" },
      { key: "ALSO_VALID", value: "test" },
    ]);
  });
});

describe("varsToRecord", () => {
  it("converts EnvVar array to record", () => {
    const vars = [
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ];
    const result = varsToRecord(vars);
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("returns empty object for empty array", () => {
    const result = varsToRecord([]);
    expect(result).toEqual({});
  });
});

describe("recordToVars", () => {
  it("converts record to EnvVar array", () => {
    const record = { FOO: "bar", BAZ: "qux" };
    const result = recordToVars(record);
    expect(result).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("returns empty array for empty object", () => {
    const result = recordToVars({});
    expect(result).toEqual([]);
  });
});
