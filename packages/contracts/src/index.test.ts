// ACBP-P0-014 — proves a workspace *package* test is discovered and runs independently.
// No product behaviour; the package source is still an empty stub.
import { test, expect } from 'vitest';
import * as contracts from './index.js';

test('contracts package test runs under the shared runner', () => {
  expect(typeof contracts).toBe('object');
});
