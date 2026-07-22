// ACBP-P1-010 — unit tests for companies HTTP mapping + bounded body parsing.
import { describe, test, expect } from 'vitest';
import { parseCreateCompanyBody, parseRenameCompanyBody, toCompaniesResponse, MAX_COMPANIES_BODY_BYTES } from './companies-http.js';
import type { CompaniesRequestResult } from './companies-request.js';

function req(contentType: string | null, bodyStr: string, declaredLength?: number): Parameters<typeof parseCreateCompanyBody>[0] {
  const bytes = new TextEncoder().encode(bodyStr);
  const len = declaredLength ?? bytes.byteLength;
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : k.toLowerCase() === 'content-length' ? String(len) : null) },
    body: null,
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  };
}

describe('body parsing', () => {
  test('non-JSON → 415; over-cap → 413; malformed/array → 400', async () => {
    expect(await parseCreateCompanyBody(req('text/plain', '{}'))).toEqual({ ok: false, status: 415 });
    expect(await parseCreateCompanyBody(req('application/json', '{}', MAX_COMPANIES_BODY_BYTES + 1))).toEqual({ ok: false, status: 413 });
    expect(await parseCreateCompanyBody(req('application/json', '{bad'))).toEqual({ ok: false, status: 400 });
    expect(await parseCreateCompanyBody(req('application/json', '[1]'))).toEqual({ ok: false, status: 400 });
  });
  test('create body extracts only creationMode + name + description (drops other keys, e.g. status)', async () => {
    const r = await parseCreateCompanyBody(req('application/json', JSON.stringify({ creationMode: 'own_idea', name: 'Co', description: 'd', status: 'active', accountId: 'evil' })));
    expect(r).toEqual({ ok: true, input: { creationMode: 'own_idea', name: 'Co', description: 'd' } });
  });
  test('rename body extracts only name + description', async () => {
    const r = await parseRenameCompanyBody(req('application/json', JSON.stringify({ name: 'New', description: 'x', version: 99 })));
    expect(r).toEqual({ ok: true, input: { name: 'New', description: 'x' } });
  });
});

describe('toCompaniesResponse', () => {
  const cases: ReadonlyArray<[CompaniesRequestResult, number]> = [
    [{ status: 'created', companyId: 'co', companyStatus: 'draft', creationMode: 'own_idea' }, 201],
    [{ status: 'company', company: { companyId: 'co', status: 'active', displayStatus: 'active', name: 'A', description: null, profileVersion: 1 } }, 200],
    [{ status: 'renamed', changed: true, version: 2 }, 200],
    [{ status: 'transitioned', companyStatus: 'paused' }, 200],
    [{ status: 'validation', error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'x', retryable: false } }, 400],
    [{ status: 'invalid_transition', from: 'draft' }, 409],
    [{ status: 'conflict' }, 409],
    [{ status: 'forbidden' }, 403],
    [{ status: 'not_found' }, 404],
    [{ status: 'unavailable' }, 503],
    [{ status: 'email_unverified' }, 403],
    [{ status: 'unauthenticated' }, 401],
  ];
  test.each(cases)('%o → %i', (result, status) => {
    expect(toCompaniesResponse(result).status).toBe(status);
  });

  test('a denial never leaks which cause (forbidden is the same opaque 403 shape)', async () => {
    const res = toCompaniesResponse({ status: 'forbidden' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  test('created returns only the safe company summary (no internal fields)', async () => {
    const res = toCompaniesResponse({ status: 'created', companyId: 'co_1', companyStatus: 'draft', creationMode: 'own_idea' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ company: { companyId: 'co_1', status: 'draft', creationMode: 'own_idea' } });
  });
});
