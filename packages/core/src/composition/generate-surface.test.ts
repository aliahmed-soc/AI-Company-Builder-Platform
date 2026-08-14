// ACBP-API-008 (CDR-092 §1) — the generate surface is reachable through the package's public entry point.
//
// WHY THIS TEST EXISTS, AND WHY IT IMPORTS FROM THE PACKAGE ROOT RATHER THAN THE FILES.
//
// CDR-092 §1 originally claimed none of these were exported. That claim came from grepping `index.ts` for the
// function names — and `index.ts` re-exports with `export * from './strategy/index.js'`, so the names are NOT
// there to find. The grep could only ever return "not found", whatever the truth was: a measurement that cannot
// come out any other way is not evidence.
//
// This asserts the property the boundary rule actually cares about — `apps/web` may reach the domain ONLY
// through `@acbp/core`, so what matters is whether these resolve from the package root, not whether a name
// appears in a particular file. If a future refactor drops one from a sub-barrel, this fails where a grep would
// keep passing.
import { describe, test, expect } from 'vitest';
import * as core from '../index.js';

describe('CDR-092 §1 — the four generate use cases and the live gateway are publicly reachable', () => {
  test.each([
    ['generateStrategyOptions'],
    ['recommendStrategy'],
    ['generateRoadmap'],
    ['generateTasks'],
    ['createAnthropicGateway'],
  ])('%s is exported from @acbp/core', (name) => {
    expect(typeof (core as unknown as Record<string, unknown>)[name]).toBe('function');
  });

  test('the deps types travel with them — a caller cannot construct the call without these', () => {
    // Types are erased at runtime, so this pins the VALUE exports a caller needs alongside them. The deps types
    // themselves are checked by `pnpm typecheck` at every call site; asserting them here would be theatre.
    for (const name of ['getLatestStrategyGeneration', 'getLatestRoadmap', 'steerTaskPlanning']) {
      expect(typeof (core as unknown as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
