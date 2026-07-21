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
    // Run test FILES sequentially (one at a time). The real-PostgreSQL integration suites all target
    // the SAME database (ACBP_TEST_DATABASE_URL) and each performs destructive setup — dropping every
    // table in beforeAll and, in the migration suites, running migrate-down mid-test. Running those
    // files concurrently lets one suite drop/rebuild tables another suite is mid-read on (flaky, timing-
    // dependent). Serial files make the shared-database run deterministic on every core count; within a
    // file tests still run in order. The suite is small, so the wall-clock cost is negligible.
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // Deterministic timezone for all tests.
    env: { TZ: 'UTC' },
    reporters: ['default'],
  },
});
