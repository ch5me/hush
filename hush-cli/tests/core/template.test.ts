import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { loadLocalTemplates, resolveTemplateVars } from "../../src/core/template.js";

const TEST_DIR = join(tmpdir(), "hush-test-template-fixtures");

// Mock fs implementation using real node:fs for this test
const mockFs = {
  existsSync: (p: string) => nodeFs.existsSync(p),
  readFileSync: (p: string, opts: Parameters<typeof nodeFs.readFileSync>[1]) =>
    nodeFs.readFileSync(p, opts),
  writeFileSync: (
    p: string,
    data: Parameters<typeof nodeFs.writeFileSync>[1],
    opts: Parameters<typeof nodeFs.writeFileSync>[2],
  ) => nodeFs.writeFileSync(p, data, opts),
  mkdirSync: (p: string, opts: Parameters<typeof nodeFs.mkdirSync>[1]) => nodeFs.mkdirSync(p, opts),
  readdirSync: (p: string, opts: Parameters<typeof nodeFs.readdirSync>[1]) =>
    nodeFs.readdirSync(p, opts),
  statSync: (p: string) => nodeFs.statSync(p),
  fstatSync: (fd: number) => nodeFs.fstatSync(fd),
  renameSync: (a: string, b: string) => nodeFs.renameSync(a, b),
  unlinkSync: (p: string) => nodeFs.unlinkSync(p),
  // Every method forwards to node:fs above; this asserts the shape the loader
  // is injected with, not a wider one.
} as unknown as typeof nodeFs;

describe("loadLocalTemplates", () => {
  beforeEach(() => {
    nodeFs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns hasTemplate: false when no .hush files exist", () => {
    const result = loadLocalTemplates(TEST_DIR, "development", mockFs);
    expect(result.hasTemplate).toBe(false);
    expect(result.vars).toEqual([]);
  });

  it("loads base .hush file", () => {
    nodeFs.writeFileSync(join(TEST_DIR, ".hush"), "FOO=bar\nBAZ=qux");

    const result = loadLocalTemplates(TEST_DIR, "development", mockFs);
    expect(result.hasTemplate).toBe(true);
    expect(result.files).toEqual([".hush"]);
    expect(result.vars).toContainEqual({ key: "FOO", value: "bar" });
    expect(result.vars).toContainEqual({ key: "BAZ", value: "qux" });
  });

  it("merges .hush with .hush.development", () => {
    nodeFs.writeFileSync(join(TEST_DIR, ".hush"), "FOO=base\nSHARED=shared");
    nodeFs.writeFileSync(join(TEST_DIR, ".hush.development"), "FOO=dev\nDEV_ONLY=true");

    const result = loadLocalTemplates(TEST_DIR, "development", mockFs);
    expect(result.hasTemplate).toBe(true);
    expect(result.files).toContain(".hush");
    expect(result.files).toContain(".hush.development");
    expect(result.vars).toContainEqual({ key: "FOO", value: "dev" });
    expect(result.vars).toContainEqual({ key: "SHARED", value: "shared" });
    expect(result.vars).toContainEqual({ key: "DEV_ONLY", value: "true" });
  });

  it("merges .hush with .hush.production", () => {
    nodeFs.writeFileSync(join(TEST_DIR, ".hush"), "FOO=base");
    nodeFs.writeFileSync(join(TEST_DIR, ".hush.production"), "FOO=prod");

    const result = loadLocalTemplates(TEST_DIR, "production", mockFs);
    expect(result.hasTemplate).toBe(true);
    expect(result.vars).toContainEqual({ key: "FOO", value: "prod" });
  });

  it("merges .hush.local last (highest priority)", () => {
    nodeFs.writeFileSync(join(TEST_DIR, ".hush"), "FOO=base");
    nodeFs.writeFileSync(join(TEST_DIR, ".hush.development"), "FOO=dev");
    nodeFs.writeFileSync(join(TEST_DIR, ".hush.local"), "FOO=local");

    const result = loadLocalTemplates(TEST_DIR, "development", mockFs);
    expect(result.vars).toContainEqual({ key: "FOO", value: "local" });
  });
});

describe("resolveTemplateVars", () => {
  it("resolves ${VAR} references from root secrets", () => {
    const templateVars = [{ key: "NEXT_PUBLIC_API_URL", value: "${API_URL}" }];
    const rootSecrets = { API_URL: "https://api.example.com" };

    const result = resolveTemplateVars(templateVars, rootSecrets);
    expect(result).toContainEqual({ key: "NEXT_PUBLIC_API_URL", value: "https://api.example.com" });
  });

  it("handles string composition", () => {
    const templateVars = [{ key: "NEXT_PUBLIC_API_URL", value: "${API_URL}/v1" }];
    const rootSecrets = { API_URL: "https://api.example.com" };

    const result = resolveTemplateVars(templateVars, rootSecrets);
    expect(result).toContainEqual({
      key: "NEXT_PUBLIC_API_URL",
      value: "https://api.example.com/v1",
    });
  });

  it("passes through literal values", () => {
    const templateVars = [{ key: "DEBUG", value: "true" }];
    const rootSecrets = {};

    const result = resolveTemplateVars(templateVars, rootSecrets);
    expect(result).toContainEqual({ key: "DEBUG", value: "true" });
  });

  it("only returns template-defined variables (not root secrets)", () => {
    const templateVars = [{ key: "NEXT_PUBLIC_API_URL", value: "${API_URL}" }];
    const rootSecrets = {
      API_URL: "https://api.example.com",
      DATABASE_URL: "postgres://localhost/db",
    };

    const result = resolveTemplateVars(templateVars, rootSecrets);
    expect(result.length).toBe(1);
    expect(result[0].key).toBe("NEXT_PUBLIC_API_URL");
  });

  it("resolves ${env:VAR} from processEnv", () => {
    const templateVars = [{ key: "CI", value: "${env:CI}" }];
    const rootSecrets = {};

    const result = resolveTemplateVars(templateVars, rootSecrets, { processEnv: { CI: "true" } });
    expect(result).toContainEqual({ key: "CI", value: "true" });
  });

  it("handles ${VAR:-default} syntax", () => {
    const templateVars = [{ key: "PORT", value: "${PORT:-3000}" }];
    const rootSecrets = {};

    const result = resolveTemplateVars(templateVars, rootSecrets);
    expect(result).toContainEqual({ key: "PORT", value: "3000" });
  });

  it("uses root secret over default when available", () => {
    const templateVars = [{ key: "PORT", value: "${PORT:-3000}" }];
    const rootSecrets = { PORT: "8080" };

    const result = resolveTemplateVars(templateVars, rootSecrets);
    expect(result).toContainEqual({ key: "PORT", value: "8080" });
  });
});

describe("resolveTemplateVars - edge cases", () => {
  describe("multiple variables in one value", () => {
    it("resolves multiple ${VAR} references", () => {
      const templateVars = [{ key: "URL", value: "${PROTOCOL}://${HOST}:${PORT}" }];
      const rootSecrets = { PROTOCOL: "https", HOST: "api.example.com", PORT: "443" };

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "URL", value: "https://api.example.com:443" });
    });

    it("resolves mix of literals and variables", () => {
      const templateVars = [{ key: "NEXT_PUBLIC_API_URL", value: "${API_URL}/api/v1" }];
      const rootSecrets = { API_URL: "https://api.example.com" };

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({
        key: "NEXT_PUBLIC_API_URL",
        value: "https://api.example.com/api/v1",
      });
    });

    it("handles prefix and suffix around variable", () => {
      const templateVars = [{ key: "MESSAGE", value: "Hello ${NAME}, welcome!" }];
      const rootSecrets = { NAME: "World" };

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "MESSAGE", value: "Hello World, welcome!" });
    });
  });

  describe("defaults with special characters", () => {
    it("handles URL as default value", () => {
      const templateVars = [{ key: "API_URL", value: "${API_URL:-http://localhost:3000/api}" }];
      const rootSecrets = {};

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "API_URL", value: "http://localhost:3000/api" });
    });

    it("handles default with equals sign", () => {
      const templateVars = [{ key: "QUERY", value: "${QUERY:-key=value}" }];
      const rootSecrets = {};

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "QUERY", value: "key=value" });
    });

    it("handles empty default", () => {
      const templateVars = [{ key: "OPTIONAL", value: "${OPTIONAL:-}" }];
      const rootSecrets = {};

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "OPTIONAL", value: "" });
    });

    it("does not support nested braces in default (known limitation)", () => {
      const templateVars = [{ key: "CONFIG", value: "${CONFIG:-simple-value}" }];
      const rootSecrets = {};

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "CONFIG", value: "simple-value" });
    });
  });

  describe("chained variable resolution", () => {
    it("resolves variables that reference other template variables", () => {
      const templateVars = [
        { key: "HOST", value: "localhost" },
        { key: "PORT", value: "3000" },
        { key: "BASE_URL", value: "http://${HOST}:${PORT}" },
        { key: "API_URL", value: "${BASE_URL}/api" },
      ];
      const rootSecrets = {};

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "API_URL", value: "http://localhost:3000/api" });
    });

    it("resolves template var referencing root secret which references another root secret", () => {
      const templateVars = [{ key: "EXPO_PUBLIC_API", value: "${API_URL}" }];
      const rootSecrets = {
        API_HOST: "api.example.com",
        API_URL: "https://api.example.com/v1",
      };

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({
        key: "EXPO_PUBLIC_API",
        value: "https://api.example.com/v1",
      });
    });
  });

  describe("local template vs root secret precedence", () => {
    it("template can define same key as root with different value", () => {
      const templateVars = [{ key: "DEBUG", value: "true" }];
      const rootSecrets = { DEBUG: "false" };

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "DEBUG", value: "true" });
    });

    it("template references root secret with same key name", () => {
      const templateVars = [{ key: "API_KEY", value: "${API_KEY}" }];
      const rootSecrets = { API_KEY: "secret-key-123" };

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "API_KEY", value: "secret-key-123" });
    });
  });

  describe("empty string vs undefined handling", () => {
    it("empty root secret uses default", () => {
      const templateVars = [{ key: "VALUE", value: "${EMPTY:-fallback}" }];
      const rootSecrets = { EMPTY: "" };

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "VALUE", value: "fallback" });
    });

    it("whitespace-only value is not treated as empty", () => {
      const templateVars = [{ key: "VALUE", value: "${SPACES:-fallback}" }];
      const rootSecrets = { SPACES: "   " };

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "VALUE", value: "   " });
    });

    it("missing root secret without default leaves reference", () => {
      const templateVars = [{ key: "VALUE", value: "${MISSING}" }];
      const rootSecrets = {};

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "VALUE", value: "${MISSING}" });
    });
  });

  describe("mixing ${VAR}, ${VAR:-default}, and ${env:VAR}", () => {
    it("combines all three syntaxes in one template", () => {
      const templateVars = [
        { key: "API_URL", value: "${API_URL}" },
        { key: "PORT", value: "${PORT:-3000}" },
        { key: "CI", value: "${env:CI}" },
      ];
      const rootSecrets = { API_URL: "https://api.example.com" };

      const result = resolveTemplateVars(templateVars, rootSecrets, { processEnv: { CI: "true" } });
      expect(result).toContainEqual({ key: "API_URL", value: "https://api.example.com" });
      expect(result).toContainEqual({ key: "PORT", value: "3000" });
      expect(result).toContainEqual({ key: "CI", value: "true" });
    });

    it("handles ${env:VAR} with default when env var is missing", () => {
      const templateVars = [{ key: "CI", value: "${env:CI}" }];
      const rootSecrets = {};

      const result = resolveTemplateVars(templateVars, rootSecrets, { processEnv: {} });
      expect(result).toContainEqual({ key: "CI", value: "" });
    });
  });

  describe("real-world framework patterns", () => {
    it("Next.js public API pattern", () => {
      const templateVars = [
        { key: "NEXT_PUBLIC_API_URL", value: "${API_URL}" },
        { key: "NEXT_PUBLIC_WS_URL", value: "${WS_URL:-ws://localhost:3001}" },
        { key: "NEXT_PUBLIC_DEBUG", value: "true" },
      ];
      const rootSecrets = {
        API_URL: "https://api.myapp.com/v1",
        DATABASE_URL: "postgres://...",
      };

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result.length).toBe(3);
      expect(result).toContainEqual({
        key: "NEXT_PUBLIC_API_URL",
        value: "https://api.myapp.com/v1",
      });
      expect(result).toContainEqual({ key: "NEXT_PUBLIC_WS_URL", value: "ws://localhost:3001" });
      expect(result).toContainEqual({ key: "NEXT_PUBLIC_DEBUG", value: "true" });
      expect(result.find((v) => v.key === "DATABASE_URL")).toBeUndefined();
    });

    it("Expo/React Native pattern with prefix transformation", () => {
      const templateVars = [
        { key: "EXPO_PUBLIC_API_URL", value: "${API_URL}" },
        { key: "EXPO_PUBLIC_STRIPE_KEY", value: "${STRIPE_PUBLISHABLE_KEY}" },
        { key: "EXPO_PUBLIC_ENVIRONMENT", value: "${ENVIRONMENT:-development}" },
      ];
      const rootSecrets = {
        API_URL: "https://api.myapp.com",
        STRIPE_PUBLISHABLE_KEY: "pk_test_xxx",
        STRIPE_SECRET_KEY: "sk_test_xxx",
      };

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result.length).toBe(3);
      expect(result).toContainEqual({ key: "EXPO_PUBLIC_API_URL", value: "https://api.myapp.com" });
      expect(result).toContainEqual({ key: "EXPO_PUBLIC_STRIPE_KEY", value: "pk_test_xxx" });
      expect(result).toContainEqual({ key: "EXPO_PUBLIC_ENVIRONMENT", value: "development" });
      expect(result.find((v) => v.key === "STRIPE_SECRET_KEY")).toBeUndefined();
    });

    it("Cloudflare Workers pattern", () => {
      const templateVars = [
        { key: "DATABASE_URL", value: "${DATABASE_URL}" },
        { key: "API_SECRET", value: "${API_SECRET}" },
        { key: "ENVIRONMENT", value: "${ENVIRONMENT:-staging}" },
      ];
      const rootSecrets = {
        DATABASE_URL: "d1://...",
        API_SECRET: "secret-123",
      };

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "DATABASE_URL", value: "d1://..." });
      expect(result).toContainEqual({ key: "API_SECRET", value: "secret-123" });
      expect(result).toContainEqual({ key: "ENVIRONMENT", value: "staging" });
    });
  });

  describe("circular and self-reference edge cases", () => {
    it("self-referential with default uses default (no root value)", () => {
      const templateVars = [{ key: "PORT", value: "${PORT:-3000}" }];
      const rootSecrets = {};

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "PORT", value: "3000" });
    });

    it("self-referential with default uses root value when available", () => {
      const templateVars = [{ key: "PORT", value: "${PORT:-3000}" }];
      const rootSecrets = { PORT: "8080" };

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "PORT", value: "8080" });
    });

    it("simple self-reference without default uses root value", () => {
      const templateVars = [{ key: "API_KEY", value: "${API_KEY}" }];
      const rootSecrets = { API_KEY: "my-secret-key" };

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "API_KEY", value: "my-secret-key" });
    });

    it("simple self-reference without default and no root stays unresolved", () => {
      const templateVars = [{ key: "UNDEFINED", value: "${UNDEFINED}" }];
      const rootSecrets = {};

      const result = resolveTemplateVars(templateVars, rootSecrets);
      expect(result).toContainEqual({ key: "UNDEFINED", value: "${UNDEFINED}" });
    });
  });
});
