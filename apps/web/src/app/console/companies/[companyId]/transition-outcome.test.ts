// ACBP-FE-006 — what the pause/resume answer means to a founder.
import { describe, it, expect } from 'vitest';
import { interpretTransitionResponse } from './transition-outcome';

describe('interpretTransitionResponse', () => {
  it('reports the new state the server confirmed, not the one we asked for', () => {
    // Asking to pause and reporting "paused" from our own request would be assuming success. The value comes
    // from the response body.
    const o = interpretTransitionResponse(200, { status: 'paused' }, null);
    expect(o).toMatchObject({ kind: 'done', companyStatus: 'paused' });
    expect(o.message).toContain('paused');
  });

  it('surfaces the ACTUAL state on a 409 rather than a generic conflict', () => {
    const o = interpretTransitionResponse(409, { error: 'invalid_transition', from: 'deactivating' }, null);
    if (o.kind !== 'stale') throw new Error('expected stale');
    expect(o.from).toBe('deactivating');
    expect(o.message).toContain('deactivating');
    // It must say plainly that nothing changed — a 409 that reads like a failure to save invites a retry loop.
    expect(o.message.toLowerCase()).toContain('no change');
  });

  it('separates an unverified email from a plain refusal', () => {
    expect(interpretTransitionResponse(403, { error: 'email_unverified' }, null).message.toLowerCase()).toContain('email');
    const plain = interpretTransitionResponse(403, { error: 'forbidden' }, null);
    expect(plain.kind).toBe('refused');
    expect(plain.message.toLowerCase()).toContain('owner');
  });

  it('uses the Retry-After header as the only disclosed number', () => {
    const o = interpretTransitionResponse(429, {}, '90');
    if (o.kind !== 'retry') throw new Error('expected retry');
    expect(o.afterSeconds).toBe(90);
    expect(o.message).toContain('90');
  });

  it('reports an unknown wait rather than inventing zero when Retry-After is missing or junk', () => {
    for (const header of [null, '', 'soon', '-5']) {
      const o = interpretTransitionResponse(429, {}, header);
      if (o.kind !== 'retry') throw new Error('expected retry');
      expect(o.afterSeconds).toBeNull();
      expect(o.message).not.toContain('0 seconds');
    }
  });

  it('never claims to know whether an unhandled status applied the change', () => {
    const o = interpretTransitionResponse(418, {}, null);
    expect(o.kind).toBe('error');
    expect(o.message).toContain('418');
    expect(o.message.toLowerCase()).toContain('nothing has been assumed');
  });

  it('tolerates a body that is not an object', () => {
    for (const body of [null, undefined, 'text', 42, []]) {
      expect(() => interpretTransitionResponse(200, body, null)).not.toThrow();
      expect(() => interpretTransitionResponse(409, body, null)).not.toThrow();
    }
  });
});
