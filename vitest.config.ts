// ACBP-P0-014 — shared Vitest configuration for the monorepo.
// Single test runner for unit / contract / integration / security / workflow tests across
// all workspace members. No product functionality. Coverage is deferred (see docs/implementation/TESTING.md)
// until real source exists to measure.
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    // Resolve @acbp/* aliases the same way tsconfig.base.json does, so tests and the
    // TypeScript compiler agree on module resolution.
    alias: [{ find: /^@acbp\/(.*)$/, replacement: resolve(import.meta.dirname, 'packages/$1/src/index.ts') }],
  },
  test: {
    include: ['apps/**/*.test.{ts,mts}', 'packages/**/*.test.{ts,mts}', 'tools/**/*.test.{ts,mts,mjs}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
    environment: 'node',
    globals: false,
    isolate: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // Deterministic timezone for all tests.
    env: { TZ: 'UTC' },
    reporters: ['default'],
  },
});
