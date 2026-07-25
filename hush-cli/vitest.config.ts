import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    isolate: true,
    pool: 'forks',
    fileParallelism: false,
    // Many tests shell out to real sops/age; local binary versions and machine
    // load make 5s flaky. CI pins sops/age versions and remains the gate.
    testTimeout: 30000,
    env: {
      // The 2s production preflight budget catches a captive-portal hang fast,
      // but a loaded box can take far longer just to start sops (measured 17.8s
      // at load average ~490). A timed-out preflight here cascades into
      // confusing decrypt failures across the suite, so raise it for tests only.
      // Tests that assert preflight behavior clear this themselves.
      HUSH_SOPS_PREFLIGHT_TIMEOUT_MS: '30000',
    },
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 64,
        functions: 78,
        branches: 49,
        statements: 64,
      },
    },
  },
});
