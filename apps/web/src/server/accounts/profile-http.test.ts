// ACBP-P1-003 — unit tests for account-profile HTTP mapping + bounded body parsing.
import { describe, test, expect } from 'vitest';
import { parseProfileUpdateBody, toProfileResponse, MAX_PROFILE_BODY_BYTES } from './profile-http.js';
import type { ProfileRequestResult } from './profile-request.js';

/** Minimal RawBodyRequest-compatible fake (arrayBuffer path; declared content-length). */
function req(contentType: string | null, bodyStr: string, declaredLength?: number): Parameters<typeof parseProfileUpdateBody>[0] {
  const bytes = new TextEncoder().encode(bodyStr);
  const len = declaredLength ?? bytes.byteLength;
  return {
    headers: {
      get: (k: string) => {
        const key = k.toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return String(len);
        return null;
      },
    },
    body: null,
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  };
}

describe('parseProfileUpdateBody', () => {
  test('rejects a non-JSON content type with 415', async () => {
    expect(await parseProfileUpdateBody(req('text/plain', '{}'))).toEqual({ ok: false, status: 415 });
    expect(await parseProfileUpdateBody(req(null, '{}'))).toEqual({ ok: false, status: 415 });
  });

  test('rejects an over-cap declared length with 413', async () => {
    const r = await parseProfileUpdateBody(req('application/json', '{}', MAX_PROFILE_BODY_BYTES + 1));
    expect(r).toEqual({ ok: false, status: 413 });
  });

  test('rejects malformed JSON and non-objects with 400', async () => {
    expect(await parseProfileUpdateBody(req('application/json', '{not json'))).toEqual({ ok: false, status: 400 });
    expect(await parseProfileUpdateBody(req('application/json', '[1,2]'))).toEqual({ ok: false, status: 400 });
    expect(await parseProfileUpdateBody(req('application/json', '"str"'))).toEqual({ ok: false, status: 400 });
  });

  test('an empty body is a no-op update ({})', async () => {
    expect(await parseProfileUpdateBody(req('application/json', ''))).toEqual({ ok: true, input: {} });
    expect(await parseProfileUpdateBody(req('application/json', '   '))).toEqual({ ok: true, input: {} });
  });

  test('extracts only displayName + locale and drops every other key (e.g. email, accountId)', async () => {
    const r = await parseProfileUpdateBody(req('application/json', JSON.stringify({ displayName: 'Ada', locale: 'en-GB', email: 'x@y.z', accountId: 'acc_evil', role: 'owner' })));
    expect(r).toEqual({ ok: true, input: { displayName: 'Ada', locale: 'en-GB' } });
  });

  test('preserves an explicit null displayName (clear intent)', async () => {
    const r = await parseProfileUpdateBody(req('application/json', JSON.stringify({ displayName: null })));
    expect(r).toEqual({ ok: true, input: { displayName: null } });
  });

  test('content-type media type is matched case-insensitively with params ignored', async () => {
    const r = await parseProfileUpdateBody(req('Application/JSON; charset=utf-8', JSON.stringify({ locale: 'en' })));
    expect(r).toEqual({ ok: true, input: { locale: 'en' } });
  });
});

describe('toProfileResponse', () => {
  const view = { accountId: 'acc_1', displayName: 'Ada', locale: 'en', email: 'a@b.com', emailVerified: true };
  const cases: ReadonlyArray<[ProfileRequestResult, number]> = [
    [{ status: 'ok', profile: view }, 200],
    [{ status: 'unauthenticated' }, 401],
    [{ status: 'email_unverified' }, 403],
    [{ status: 'forbidden' }, 403],
    [{ status: 'not_found' }, 404],
    [{ status: 'unavailable' }, 503],
    [{ status: 'validation_error', error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'bad', retryable: false } }, 400],
  ];

  for (const [result, status] of cases) {
    test(`${result.status} → HTTP ${status}`, async () => {
      const res = toProfileResponse(result);
      expect(res.status).toBe(status);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as Record<string, unknown>;
      if (result.status === 'ok') expect(body['profile']).toEqual(view);
      else expect(body['error']).toBeDefined();
    });
  }

  test('a success response never contains internal-only fields', async () => {
    const res = toProfileResponse({ status: 'ok', profile: view });
    const text = await res.text();
    expect(text).not.toContain('created_by_user_id');
    expect(text).not.toContain('provider_user_id');
  });
});
