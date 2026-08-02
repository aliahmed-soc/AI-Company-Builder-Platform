// @acbp/contracts — the suppression-incident shape (ACBP-P6-011; CDR-074 §0/§5).
import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_SUPPRESSION_SURFACES,
  isIdempotencySuppressionSurface,
  suppressionMetadata,
  type SuppressionIncident,
} from './suppression.js';

describe('idempotency suppression incidents', () => {
  it('carries the surface and both tenant ids', () => {
    const meta = suppressionMetadata({ surface: 'usage_event', accountId: 'acc-1', companyId: 'co-1' });
    expect(meta).toEqual({ surface: 'usage_event', accountId: 'acc-1', companyId: 'co-1' });
  });

  it('keeps a tenantless surface as explicit nulls rather than dropping the fields', () => {
    // `identity_event` is the webhook-receipt dedupe, and identity mappings are global by design -- no account,
    // no company. Omitting the fields would read as "we forgot to record them"; explicit nulls say "this surface
    // has none", which is the difference between a gap and a fact.
    const meta = suppressionMetadata({ surface: 'identity_event', accountId: null, companyId: null });
    expect(meta).toEqual({ surface: 'identity_event', accountId: null, companyId: null });
    expect('companyId' in meta).toBe(true);
    expect('accountId' in meta).toBe(true);
  });

  it('drops every field that is not on the allow-list', () => {
    // THE GUARD. An idempotency key is CALLER-SUPPLIED and unbounded in content -- a caller is free to mint one
    // containing an email, a customer name, or a raw payload fragment. A suppression record is a log line, so a
    // spread of the incident object would publish whatever the caller put in the key. This builds the metadata
    // from named fields ONLY, which is why an extra property cannot ride along.
    const laden = {
      surface: 'usage_event',
      accountId: 'acc-1',
      companyId: 'co-1',
      idempotencyKey: 'user-someone@example.test-call-9',
      payload: { note: 'secret' },
    } as unknown as SuppressionIncident;

    const meta = suppressionMetadata(laden);

    expect(Object.keys(meta).sort()).toEqual(['accountId', 'companyId', 'surface']);
    expect(JSON.stringify(meta)).not.toContain('example.test');
    expect(JSON.stringify(meta)).not.toContain('secret');
  });

  it('recognises exactly the surfaces this ticket wires, and nothing else', () => {
    // Deliberately SHORT. Listing surfaces that nothing reports would claim coverage this ticket does not have --
    // the same "registered but not wired" defect the usage key itself is careful about (CDR-074 §5).
    expect([...IDEMPOTENCY_SUPPRESSION_SURFACES]).toEqual(['job_enqueue', 'identity_event', 'usage_event']);
    expect(isIdempotencySuppressionSurface('usage_event')).toBe(true);
    expect(isIdempotencySuppressionSurface('tool_call')).toBe(false);
    expect(isIdempotencySuppressionSurface(undefined)).toBe(false);
  });
});
