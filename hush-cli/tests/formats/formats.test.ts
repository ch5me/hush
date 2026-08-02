import { describe, it, expect } from "vitest";

import { formatDotenv } from "../../src/formats/dotenv.js";
import { formatVars } from "../../src/formats/index.js";
import { formatJson } from "../../src/formats/json.js";
import { formatShell } from "../../src/formats/shell.js";
import { formatWrangler } from "../../src/formats/wrangler.js";
import { formatYaml } from "../../src/formats/yaml.js";
import type { EnvVar } from "../../src/types.js";

const testVars: EnvVar[] = [
  { key: "FOO", value: "bar" },
  { key: "BAZ", value: "qux" },
];

describe("formatDotenv", () => {
  it("formats vars as key=value lines", () => {
    const result = formatDotenv(testVars);
    expect(result).toBe("FOO=bar\nBAZ=qux\n");
  });

  it("handles empty array", () => {
    const result = formatDotenv([]);
    expect(result).toBe("\n");
  });

  it("preserves special characters in values", () => {
    const vars = [{ key: "URL", value: "postgres://user:pass@host/db" }];
    const result = formatDotenv(vars);
    expect(result).toBe("URL=postgres://user:pass@host/db\n");
  });
});

describe("formatWrangler", () => {
  it("formats vars same as dotenv (Wrangler .dev.vars format)", () => {
    const result = formatWrangler(testVars);
    expect(result).toBe("FOO=bar\nBAZ=qux\n");
  });
});

describe("formatJson", () => {
  it("formats vars as JSON object", () => {
    const result = formatJson(testVars);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles empty array", () => {
    const result = formatJson([]);
    expect(JSON.parse(result)).toEqual({});
  });

  it("pretty prints with 2-space indent", () => {
    const result = formatJson([{ key: "A", value: "1" }]);
    expect(result).toContain('  "A"');
  });
});

describe("formatShell", () => {
  it("formats vars as export statements", () => {
    const result = formatShell(testVars);
    expect(result).toBe("export FOO=bar\nexport BAZ=qux\n");
  });

  it("quotes values with special characters", () => {
    const vars = [{ key: "MSG", value: "hello world" }];
    const result = formatShell(vars);
    expect(result).toBe("export MSG='hello world'\n");
  });

  it("escapes single quotes in values", () => {
    const vars = [{ key: "MSG", value: "it's working" }];
    const result = formatShell(vars);
    expect(result).toContain("'it'\\''s working'");
  });

  it("does not quote simple values", () => {
    const vars = [{ key: "SIMPLE", value: "abc123" }];
    const result = formatShell(vars);
    expect(result).toBe("export SIMPLE=abc123\n");
  });
});

describe("formatYaml", () => {
  it("formats vars as YAML key: value lines", () => {
    const result = formatYaml(testVars);
    expect(result).toBe("FOO: bar\nBAZ: qux\n");
  });

  it("handles empty array", () => {
    const result = formatYaml([]);
    expect(result).toBe("{}\n");
  });

  it("quotes values with special characters", () => {
    const vars = [{ key: "URL", value: "postgres://user:pass@host/db" }];
    const result = formatYaml(vars);
    expect(result).toContain('"postgres://user:pass@host/db"');
  });

  it("quotes values that look like booleans", () => {
    const vars = [{ key: "FLAG", value: "true" }];
    const result = formatYaml(vars);
    expect(result).toBe('FLAG: "true"\n');
  });

  it("quotes values that look like numbers", () => {
    const vars = [{ key: "PORT", value: "3000" }];
    const result = formatYaml(vars);
    expect(result).toBe('PORT: "3000"\n');
  });

  it("escapes double quotes in values", () => {
    const vars = [{ key: "MSG", value: 'say "hello"' }];
    const result = formatYaml(vars);
    expect(result).toContain('\\"hello\\"');
  });

  it("escapes newlines in values", () => {
    const vars = [{ key: "MULTILINE", value: "line1\nline2" }];
    const result = formatYaml(vars);
    expect(result).toContain("\\n");
  });
});

describe("formatVars dispatcher", () => {
  it("dispatches to dotenv formatter", () => {
    expect(formatVars(testVars, "dotenv")).toBe(formatDotenv(testVars));
  });

  it("dispatches to wrangler formatter", () => {
    expect(formatVars(testVars, "wrangler")).toBe(formatWrangler(testVars));
  });

  it("dispatches to json formatter", () => {
    expect(formatVars(testVars, "json")).toBe(formatJson(testVars));
  });

  it("dispatches to shell formatter", () => {
    expect(formatVars(testVars, "shell")).toBe(formatShell(testVars));
  });

  it("dispatches to yaml formatter", () => {
    expect(formatVars(testVars, "yaml")).toBe(formatYaml(testVars));
  });
});
