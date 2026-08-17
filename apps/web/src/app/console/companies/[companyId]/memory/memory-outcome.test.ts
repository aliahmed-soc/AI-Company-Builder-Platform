/*
 * ACBP-FE-010 — every arm the three memory verbs can hand back.
 *
 * The pressure points here are unusual, and both would look like success to a careless reading:
 *   - a successful EDIT returns a DIFFERENT id than the one it was sent to, because editing supersedes
 *     rather than mutates. Treating that as a mismatch would report a working edit as broken.
 *   - a 409 on DELETE covers three genuinely different states behind one opaque body, while a GET of the
 *     same item answers 404. The copy must not pick one and present it as the diagnosis.
 */
import { describe, expect, it } from 'vitest';
import { interpretDeleteResponse, interpretEditResponse, interpretListResponse } from './memory-outcome';

const ITEM = {
  memoryItemId: 'm_new',
  type: 'user_fact',
  content: 'We sell to clinics.',
  sourceType: 'user_edit',
  sourceRef: 'memory:m_old',
  confidence: null,
  confirmationState: 'proposed',
  supersededBy: null,
  createdAt: '2026-08-18T00:00:00.000Z',
};

const envelope = (message: string) => JSON.stringify({ error: { category: 'validation', code: 'VALIDATION_FAILED', message, retryable: false } });

describe('interpretListResponse', () => {
  it('reads the items envelope', () => {
    const out = interpretListResponse(200, JSON.stringify({ items: [ITEM] }), null);
    expect(out.kind).toBe('items');
    expect(out.kind === 'items' && out.items).toHaveLength(1);
  });

  it('reports an empty list as an empty list, not as a failure', () => {
    const out = interpretListResponse(200, JSON.stringify({ items: [] }), null);
    expect(out.kind).toBe('items');
    expect(out.kind === 'items' && out.items).toHaveLength(0);
  });

  it('treats a 200 that is not the items envelope as an error rather than as zero items', () => {
    // An unreadable 200 rendered as "no items" would be the FE-007 defect in a new place: absence of
    // evidence shown as evidence of absence.
    expect(interpretListResponse(200, JSON.stringify({ nope: true }), null).kind).toBe('error');
    expect(interpretListResponse(200, 'not json', null).kind).toBe('error');
  });

  it('drops an element that is not a real memory item rather than rendering a half-empty row', () => {
    const out = interpretListResponse(200, JSON.stringify({ items: [ITEM, { memoryItemId: 'x' }] }), null);
    expect(out.kind === 'items' && out.items).toHaveLength(1);
  });

  it.each([
    [401, 'signed_out'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [503, 'unavailable'],
    [500, 'error'],
  ])('maps %i to %s', (status, kind) => {
    expect(interpretListResponse(status, JSON.stringify({ error: 'x' }), null).kind).toBe(kind);
  });

  it('reads a real Retry-After and treats an empty one as absent', () => {
    expect(interpretListResponse(429, '{}', '30')).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 30 });
    expect(interpretListResponse(429, '{}', '')).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: null });
  });
});

describe('interpretEditResponse — a successful edit returns a NEW id', () => {
  it('reads the saved item and does not treat the changed id as a mismatch', () => {
    // Editing supersedes rather than mutates, so the 200 legitimately carries an id that differs from the
    // URL it was sent to. A screen that compared them and reported a failure would be wrong every time.
    const out = interpretEditResponse(200, JSON.stringify({ item: ITEM }), null);
    expect(out.kind).toBe('saved');
    expect(out.kind === 'saved' && out.item.memoryItemId).toBe('m_new');
  });

  it('treats a 200 that is not an item envelope as an error, not a save', () => {
    expect(interpretEditResponse(200, JSON.stringify({ item: { memoryItemId: 'x' } }), null).kind).toBe('error');
  });

  it('carries the server validation sentence verbatim', () => {
    const out = interpretEditResponse(400, envelope('Memory content is too long.'), null);
    expect(out.kind).toBe('invalid');
    expect(out.kind === 'invalid' && out.serverMessage).toBe('Memory content is too long.');
  });

  it('keeps a route-level 400 distinct from a domain 400', () => {
    const routeLevel = interpretEditResponse(400, JSON.stringify({ error: 'bad_request' }), null);
    expect(routeLevel.kind).toBe('malformed');
    expect(routeLevel.kind).not.toBe(interpretEditResponse(400, envelope('Memory type is invalid.'), null).kind);
  });

  it('says a 409 changed state without claiming which of several states it was', () => {
    const out = interpretEditResponse(409, JSON.stringify({ error: 'conflict' }), null);
    expect(out.kind).toBe('conflict');
    expect(out.detail.toLowerCase()).toMatch(/does not say|which/);
  });

  it.each([
    [401, 'signed_out'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [413, 'too_large'],
    [415, 'malformed_media'],
    [503, 'unavailable'],
  ])('maps %i to %s', (status, kind) => {
    expect(interpretEditResponse(status, JSON.stringify({ error: 'x' }), null).kind).toBe(kind);
  });
});

describe('interpretDeleteResponse', () => {
  it('reads the id-only success body', () => {
    const out = interpretDeleteResponse(200, JSON.stringify({ memoryItemId: 'm1' }), null);
    expect(out.kind).toBe('deleted');
    expect(out.kind === 'deleted' && out.memoryItemId).toBe('m1');
  });

  it('treats a 200 without a usable id as an error', () => {
    expect(interpretDeleteResponse(200, JSON.stringify({ ok: true }), null).kind).toBe('error');
  });

  it('NEVER reports a 409 as "already deleted"', () => {
    // The bare 409 covers already-deleted, a superseded historical version, AND a lost concurrent race —
    // with no discriminator. Naming one would be a guess dressed as a diagnosis, and the same item answers
    // 404 on a read, so the screen cannot even infer it from a follow-up.
    const out = interpretDeleteResponse(409, JSON.stringify({ error: 'conflict' }), null);
    expect(out.kind).toBe('conflict');
    expect(out.detail.toLowerCase()).not.toContain('already deleted');
    expect(out.detail.toLowerCase()).toMatch(/changed|which/);
  });

  it('has no 413 or 415 arm, because DELETE sends no body', () => {
    expect(interpretDeleteResponse(413, JSON.stringify({ error: 'payload_too_large' }), null).kind).toBe('error');
    expect(interpretDeleteResponse(415, JSON.stringify({ error: 'unsupported_media_type' }), null).kind).toBe('error');
  });

  it.each([
    [401, 'signed_out'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [503, 'unavailable'],
    [500, 'error'],
  ])('maps %i to %s', (status, kind) => {
    expect(interpretDeleteResponse(status, JSON.stringify({ error: 'x' }), null).kind).toBe(kind);
  });

  it('separates an unverified email from a plain refusal', () => {
    expect(interpretDeleteResponse(403, JSON.stringify({ error: 'email_unverified' }), null).kind).toBe('email_unverified');
    expect(interpretDeleteResponse(403, JSON.stringify({ error: 'forbidden' }), null).kind).toBe('forbidden');
  });
});
