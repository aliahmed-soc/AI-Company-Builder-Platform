// @acbp/observability — recording a duplicate-suppression incident (ACBP-P6-011; CDR-074 §0/§5).
import { describe, expect, it } from 'vitest';
import type { SuppressionIncident } from '@acbp/contracts';
import { createTestLogger } from './logger.js';
import { recordSuppression, SUPPRESSION_EVENT } from './suppression.js';

describe('recordSuppression', () => {
  it('emits one countable record naming the surface and tenant', () => {
    const t = createTestLogger({ component: 'usage' });

    recordSuppression(t.logger, { surface: 'usage_event', accountId: 'acc-1', companyId: 'co-1' });

    expect(t.records).toHaveLength(1);
    // ONE STABLE EVENT NAME across every surface, which is what makes the incidents COUNTABLE. If each call site
    // invented its own name, counting suppressions would mean knowing the full list of names in advance -- and a
    // surface that stopped reporting would be indistinguishable from one whose name nobody knew to query.
    expect(t.records[0]?.event).toBe(SUPPRESSION_EVENT);
    expect(t.records[0]?.metadata).toEqual({ surface: 'usage_event', accountId: 'acc-1', companyId: 'co-1' });
  });

  it('records at info, because a suppression is a correct outcome', () => {
    const t = createTestLogger();
    recordSuppression(t.logger, { surface: 'job_enqueue', accountId: 'acc-1', companyId: 'co-1' });
    // NOT warn. A suppressed duplicate is the mechanism working exactly as designed -- warning on it would train
    // whoever reads these to ignore warnings, which costs more than the visibility gains. The threshold at which a
    // suppression RATE deserves an alert is the owner's (CDR-074 §4), and is not this function's business.
    expect(t.records[0]?.level).toBe('info');
  });

  it('never records the idempotency key, even when a caller passes one', () => {
    const t = createTestLogger();
    const laden = {
      surface: 'usage_event',
      accountId: 'acc-1',
      companyId: 'co-1',
      idempotencyKey: 'invoice-for-someone@example.test',
    } as unknown as SuppressionIncident;

    recordSuppression(t.logger, laden);

    expect(JSON.stringify(t.records)).not.toContain('example.test');
    expect(JSON.stringify(t.records)).not.toContain('idempotencyKey');
  });

  it('is a no-op when no logger is supplied', () => {
    // Every existing call site takes `logger?: Logger`, so an absent logger is the normal case in tests and in any
    // caller that has not been given one. Recording an incident must never be the thing that fails a write.
    expect(() => recordSuppression(undefined, { surface: 'identity_event', accountId: null, companyId: null })).not.toThrow();
  });
});
