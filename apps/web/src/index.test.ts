// ACBP-P0-014 — proves an *application* test is discovered and runs independently.
// No product behaviour; the app entry is still an empty stub.
import { test, expect } from 'vitest';
import * as web from './index.js';

test('web app test runs under the shared runner', () => {
  expect(typeof web).toBe('object');
});
