// ACBP-P1-004 — unit tests for members HTTP mapping + bounded body parsing.
import { describe, test, expect } from 'vitest';
import { parseInviteBody, parseAcceptBody, toMembersResponse, MAX_MEMBERS_BODY_BYTES } from './members-http.js';
import type { MembersRequestResult } from './members-request.js';

function req(contentType: string | null, bodyStr: string, declaredLength?: number): Parameters<typeof parseInviteBody>[0] {
  const bytes = new TextEncoder().encode(bodyStr);
  const len = declaredLength ?? bytes.byteLength;
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : k.toLowerCase() === 'content-length' ? String(len) : null) },
    body: null,
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  };
}

describe('parseInviteBody / parseAcceptBody', () => {
  test('non-JSON → 415; over-cap → 413; malformed/array → 400', async () => {
    expect(await parseInviteBody(req('text/plain', '{}'))).toEqual({ ok: false, status: 415 });
    expect(await parseInviteBody(req('application/json', '{}', MAX_MEMBERS_BODY_BYTES + 1))).toEqual({ ok: false, status: 413 });
    expect(await parseInviteBody(req('application/json', '{bad'))).toEqual({ ok: false, status: 400 });
    expect(await parseInviteBody(req('application/json', '[1]'))).toEqual({ ok: false, status: 400 });
  });
  test('invite body extracts only invitedEmail + role (drops other keys)', async () => {
    const r = await parseInviteBody(req('application/json', JSON.stringify({ invitedEmail: 'a@b.com', role: 'viewer', accountId: 'evil', membershipId: 'x' })));
    expect(r).toEqual({ ok: true, input: { invitedEmail: 'a@b.com', role: 'viewer' } });
  });
  test('accept body extracts only token', async () => {
    const r = await parseAcceptBody(req('application/json', JSON.stringify({ token: 'tok', accountId: 'evil' })));
    expect(r).toEqual({ ok: true, input: { token: 'tok' } });
  });
});

describe('toMembersResponse', () => {
  const cases: ReadonlyArray<[MembersRequestResult, number]> = [
    [{ status: 'members', members: [] }, 200],
    [{ status: 'invited', membershipId: 'm', role: 'viewer', inviteToken: 'tok' }, 201],
    [{ status: 'accepted', membershipId: 'm', accountId: 'a', role: 'viewer' }, 200],
    [{ status: 'revoked' }, 204],
    [{ status: 'validation', error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'x', retryable: false } }, 400],
    [{ status: 'conflict' }, 409],
    [{ status: 'last_owner' }, 409],
    [{ status: 'already_member' }, 409],
    [{ status: 'invalid_token' }, 400],
    [{ status: 'email_mismatch' }, 403],
    [{ status: 'email_unverified' }, 403],
    [{ status: 'forbidden' }, 403],
    [{ status: 'not_found' }, 404],
    [{ status: 'unavailable' }, 503],
    [{ status: 'unauthenticated' }, 401],
  ];
  for (const [result, status] of cases) {
    test(`${result.status} → HTTP ${status}`, () => {
      const res = toMembersResponse(result);
      expect(res.status).toBe(status);
      if (status !== 204) expect(res.headers.get('content-type')).toContain('application/json');
    });
  }

  test('the invite response carries the token exactly once and no internal fields', async () => {
    const res = toMembersResponse({ status: 'invited', membershipId: 'm1', role: 'viewer', inviteToken: 'raw-token' });
    const body = (await res.json()) as { membership: Record<string, unknown>; inviteToken: string };
    expect(body.inviteToken).toBe('raw-token');
    expect(body.membership).toEqual({ membershipId: 'm1', role: 'viewer' });
    expect(JSON.stringify(body)).not.toContain('invite_token_hash');
  });
});
