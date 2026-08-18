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
    alias: [
      { find: /^@acbp\/(.*)$/, replacement: resolve(import.meta.dirname, 'packages/$1/src/index.ts') },
      // apps/web's own "@/..." path alias (apps/web/tsconfig.json). Needed so the ACBP-P1-014 adversarial
      // suite can import and drive the REAL Next route handlers against a real database.
      { find: /^@\/(.*)$/, replacement: resolve(import.meta.dirname, 'apps/web/src/$1') },
    ],
  },
  test: {
    // `tests/` holds CROSS-LAYER suites that belong to no single package — specifically the ACBP-P1-014
    // adversarial tests that drive apps/web route handlers against a real database. Such a test must import
    // both layers, which the dependency-boundary rule (rightly) forbids inside apps/ or packages/; the
    // checker scans apps/ + packages/ only, so a repo-level test creates no production dependency edge.
    // .tsx IS INCLUDED FOR apps/** ONLY (ACBP-FE-019). A rendered-component test must be a .tsx file, and
    // the default environment: 'node' below stays: each such file opts IN with a @vitest-environment jsdom
    // docblock, so the 4000+ node-environment tests keep their current runtime and isolation. Widening the
    // GLOBAL environment to jsdom instead would have made every existing suite pay for a DOM none of them uses.
    include: ['apps/**/*.test.{ts,mts,tsx}', 'packages/**/*.test.{ts,mts}', 'tools/**/*.test.{ts,mts,mjs}', 'tests/**/*.test.{ts,mts}'],
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
