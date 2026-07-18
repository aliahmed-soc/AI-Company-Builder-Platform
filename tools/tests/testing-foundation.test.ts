// ACBP-P0-014 — infrastructure-level tests proving the shared testing foundation works.
// No product behaviour is exercised.
import { describe, test, expect } from 'vitest';
import { TEST_MARKER } from '@acbp/test-support';

describe('testing foundation', () => {
  test('executes TypeScript and passes (exit 0 path)', () => {
    const typed: number = 40 + 2;
    expect(typed).toBe(42);
  });

  test('awaits async tests correctly', async () => {
    const value = await Promise.resolve('async-ok');
    expect(value).toBe('async-ok');
  });

  // Isolation: two tests mutating a local do not leak state between each other.
  test('isolation A — local state does not leak', () => {
    const state: string[] = [];
    state.push('a');
    expect(state).toEqual(['a']);
  });
  test('isolation B — starts from a clean local state', () => {
    const state: string[] = [];
    expect(state).toEqual([]);
  });

  test('@acbp/* path aliases resolve consistently with the compiler', () => {
    // Importing a workspace package by its alias must resolve (test-support is import-allowed for tests).
    expect(TEST_MARKER).toBe('acbp-test-support');
  });

  test('deterministic environment: TZ is pinned to UTC', () => {
    expect(process.env.TZ).toBe('UTC');
  });
});
