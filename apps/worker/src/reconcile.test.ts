// ACBP-P1-002 — reconciliation worker command tests (apps/worker). Injected fake runtime + test logger;
// no Clerk, no database. Proves exit codes, that the runtime is always closed, and that a failure is
// logged sanitized (no secret/PII leak).
import { describe, test, expect } from 'vitest';
import { createTestLogger } from '@acbp/observability';
import type { ClerkIdentityRuntime, ReconciliationSummary } from '@acbp/core';
import { runReconcile } from './reconcile.js';

const SUMMARY: ReconciliationSummary = { scanned: 3, inSync: 2, repaired: 1, providerMissing: 0, providerUnavailable: 0 };

function fakeRuntime(over: Partial<{ reconcile: () => Promise<ReconciliationSummary>; onClose: () => void }> = {}): ClerkIdentityRuntime {
  return {
    webhook: { handle: () => Promise.reject(new Error('not used')) },
    resolveInternalUser: () => Promise.resolve({ status: 'not_found' }),
    reconcile: over.reconcile ?? (() => Promise.resolve(SUMMARY)),
    close: () => {
      over.onClose?.();
      return Promise.resolve();
    },
  } as unknown as ClerkIdentityRuntime;
}

describe('runReconcile', () => {
  test('success → exit code 0 with summary; runtime is closed; done is logged', async () => {
    const logger = createTestLogger({ component: 'reconcile' });
    let closed = false;
    let reconcileCalls = 0;
    const runtime = fakeRuntime({
      reconcile: () => {
        reconcileCalls += 1;
        return Promise.resolve(SUMMARY);
      },
      onClose: () => (closed = true),
    });
    const result = await runReconcile({ createRuntime: () => runtime, logger: logger.logger });
    expect(result.code).toBe(0);
    expect(result.summary).toEqual(SUMMARY);
    expect(reconcileCalls).toBe(1);
    expect(closed).toBe(true);
    expect(logger.records.some((r) => r.event === 'reconcile.worker.done')).toBe(true);
  });

  test('failure → exit code 1; runtime still closed; error logged sanitized (no leak)', async () => {
    const logger = createTestLogger({ component: 'reconcile' });
    let closed = false;
    const runtime = fakeRuntime({
      reconcile: () => Promise.reject(new Error('boom: whsec_secret person@example.com')),
      onClose: () => (closed = true),
    });
    const result = await runReconcile({ createRuntime: () => runtime, logger: logger.logger });
    expect(result.code).toBe(1);
    expect(result.summary).toBeUndefined();
    expect(closed).toBe(true);
    expect(logger.records.some((r) => r.level === 'error' && r.event === 'reconcile.worker.failed')).toBe(true);
    const logged = JSON.stringify(logger.records);
    expect(logged).not.toMatch(/whsec_|person@example\.com/i);
  });
});
