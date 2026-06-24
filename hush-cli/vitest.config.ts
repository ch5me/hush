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
