// ACBP-P1-010 — unit tests for companies HTTP mapping + bounded body parsing.
import { describe, test, expect } from 'vitest';
import { DECISION_ROOM_QUEUES, okSection, nonAnsweringSection, type DecisionRoomView } from '@acbp/contracts';
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

const ROOM: DecisionRoomView = {
  sections: DECISION_ROOM_QUEUES.map((q) => (q === 'blocked_work' ? nonAnsweringSection(q, 'restricted') : okSection(q, [], 0))),
  integrity: { unverifiedCompletions: 2 },
  usage: { status: 'restricted', figures: null },
  asOf: '2026-08-01T00:00:00.000Z',
  digest: 'd1',
};

describe('toCompaniesResponse', () => {
  const cases: ReadonlyArray<[CompaniesRequestResult, number]> = [
    [{ status: 'created', companyId: 'co', companyStatus: 'draft', creationMode: 'own_idea' }, 201],
    [{ status: 'company', company: { companyId: 'co', status: 'active', displayStatus: 'active', name: 'A', description: null, profileVersion: 1 } }, 200],
    [{ status: 'renamed', changed: true, version: 2 }, 200],
    [{ status: 'transitioned', companyStatus: 'paused' }, 200],
    [{ status: 'validation', error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'x', retryable: false } }, 400],
    [{ status: 'activity', page: { items: [], nextCursor: null, projectionMode: 'synchronous', asOf: '2026-07-22T00:00:00.000Z', sourceThrough: null, lagSeconds: 0 } }, 200],
    [{ status: 'decision_room', room: ROOM }, 200],
    [{ status: 'portfolio', page: { items: [], nextCursor: null } }, 200],
    [{ status: 'provisioning', provisioning: { companyId: 'co', companyStatus: 'onboarding', steps: [], nextIncompleteStep: null, resumable: false, exhausted: false, completed: false } }, 200],
    [{ status: 'interview', session: { sessionId: 's', companyId: 'co', state: 'in_progress', phase: 'in_progress', startedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } }, 200],
    [{ status: 'company_not_active' }, 409],
    [{ status: 'answer', answer: { questionId: 'q', revision: 2, status: 'answered', content: 'hi', createdAt: '2026-01-01T00:00:00.000Z' }, created: true }, 200],
    [{ status: 'qa', qa: { sessionId: 's', items: [] } }, 200],
    [{ status: 'memory_item', item: { memoryItemId: 'm', type: 'user_fact', content: 'hi', sourceType: 'interview_answer', sourceRef: 'r', confidence: null, confirmationState: 'proposed', supersededBy: null, createdAt: '2026-01-01T00:00:00.000Z' } }, 201],
    [{ status: 'memory_list', items: [] }, 200],
    [{ status: 'memory_item_single', item: { memoryItemId: 'm', type: 'user_fact', content: 'hi', sourceType: 'interview_answer', sourceRef: 'r', confidence: null, confirmationState: 'proposed', supersededBy: null, createdAt: '2026-01-01T00:00:00.000Z' } }, 200],
    [{ status: 'memory_edited', item: { memoryItemId: 'm2', type: 'user_fact', content: 'fixed', sourceType: 'user_edit', sourceRef: 'm', confidence: null, confirmationState: 'proposed', supersededBy: null, createdAt: '2026-01-01T00:00:00.000Z' } }, 200],
    [{ status: 'memory_deleted', memoryItemId: 'm' }, 200],
    [{ status: 'invalid_transition', from: 'draft' }, 409],
    [{ status: 'conflict' }, 409],
    [{ status: 'invalid_cursor' }, 400],
    [{ status: 'invalid_limit' }, 400],
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

  test('portfolio returns only the redacted items + nextCursor (no accountId/actor/metrics)', async () => {
    const item = { companyId: 'co_1', name: 'Acme', status: 'active', role: 'owner', createdAt: '2026-01-01T00:00:00.000000Z' };
    const res = toCompaniesResponse({ status: 'portfolio', page: { items: [item], nextCursor: 'nc' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [item], nextCursor: 'nc' });
  });

  // ACBP-P6-008 — the room travels WHOLE or not at all.
  test('decision_room returns all ten sections WITH their statuses, plus integrity and usage', async () => {
    const res = toCompaniesResponse({ status: 'decision_room', room: ROOM });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { room: DecisionRoomView };
    expect(body.room.sections.map((s) => s.queue)).toEqual([...DECISION_ROOM_QUEUES]);
    // A restricted section arrives as restricted with a NULL count — it must not reach a client looking empty.
    const restricted = body.room.sections.find((s) => s.queue === 'blocked_work');
    expect(restricted).toMatchObject({ status: 'restricted', count: null, items: [] });
    // The integrity counter is part of the room, never an optional extra a client can forget to fetch.
    expect(body.room.integrity).toEqual({ unverifiedCompletions: 2 });
    expect(body.room.usage).toEqual({ status: 'restricted', figures: null });
  });

  test('invalid_limit is a 400 (rejected, never clamped)', async () => {
    const res = toCompaniesResponse({ status: 'invalid_limit' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_limit' });
  });

  test('provisioning returns only the approved redacted fields (no accountId/actor/free-text failure)', async () => {
    const step = { step: 'research', order: 3, status: 'failed', attempt: 2, requestedAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:01.000Z', completedAt: null, failedAt: '2026-01-01T00:00:02.000Z', failureCode: 'internal_error' } as const;
    const res = toCompaniesResponse({ status: 'provisioning', provisioning: { companyId: 'co_1', companyStatus: 'onboarding', steps: [step], nextIncompleteStep: 'research', resumable: true, exhausted: false, completed: false } });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ companyId: 'co_1', companyStatus: 'onboarding', steps: [step], nextIncompleteStep: 'research', resumable: true, exhausted: false, completed: false });
    expect(JSON.stringify(body)).not.toContain('accountId');
  });

  test('interview returns the redacted session DTO under { session } (no accountId/actor)', async () => {
    const session = { sessionId: 'sess_1', companyId: 'co_1', state: 'waiting_for_user', phase: 'awaiting_input', startedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:05.000Z' } as const;
    const res = toCompaniesResponse({ status: 'interview', session });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ session });
    expect(JSON.stringify(body)).not.toContain('accountId');
  });

  test('company_not_active is a coarse 409 with no oracle detail', async () => {
    const res = toCompaniesResponse({ status: 'company_not_active' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'company_not_active' });
  });
});
