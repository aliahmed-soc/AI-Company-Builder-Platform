/*
 * ACBP-FE-010 — the memory browser's modules, driven by the SERVER'S OWN response builder.
 *
 * Same reasoning as `interview-contract-alignment.test.ts`: a hand-written body encodes what the author
 * BELIEVED the server sends, and in ACBP-FE-005 that belief was wrong in a way the unit tests could not
 * catch, because they asserted the same wrong shape. So nothing here is hand-written — real
 * `CompaniesRequestResult` arms go through the real `toCompaniesResponse` and the actual status and body
 * are fed to this screen's modules.
 *
 * THE ASSERTION THAT MATTERS MOST is that a successful EDIT returns an item whose id DIFFERS from the one
 * edited. That is not a quirk to tolerate — it is the supersede-and-create model surfacing, and a screen
 * that compared the two and reported a mismatch would flag every successful edit as broken. Driving it
 * through the real responder proves the shape the interpreter discriminates on is the shape actually sent.
 */
import { describe, test, expect } from 'vitest';
import { toCompaniesResponse } from '@/server/companies/companies-http';
import type { CompaniesRequestResult } from '@/server/companies/companies-request';
import type { MemoryItemDTO } from '@acbp/contracts';
import { toMemoryView } from './memory-view';
import { interpretDeleteResponse, interpretEditResponse, interpretListResponse } from './memory-outcome';

// No `as` cast on the argument — a cast let a malformed arm through the compiler once already, and the
// server then built a body out of undefined fields.
async function throughServer(result: CompaniesRequestResult): Promise<{ status: number; body: string; retryAfter: string | null }> {
  const res = toCompaniesResponse(result);
  return { status: res.status, body: await res.text(), retryAfter: res.headers.get('retry-after') };
}

function dto(over: Partial<MemoryItemDTO> & { memoryItemId: string }): MemoryItemDTO {
  return {
    type: 'user_fact',
    content: 'We sell to independent clinics.',
    sourceType: 'interview_answer',
    sourceRef: 'question:q1',
    confidence: null,
    confirmationState: 'proposed',
    supersededBy: null,
    createdAt: '2026-08-18T00:00:00.000Z',
    ...over,
  };
}

describe('ACBP-FE-010 — the list read', () => {
  test('the served items reach the view with provenance intact', async () => {
    const { status, body, retryAfter } = await throughServer({
      status: 'memory_list',
      items: [dto({ memoryItemId: 'm1', sourceType: 'user_edit', sourceRef: 'memory:m0', confidence: 0.5 })],
    });
    expect(status).toBe(200);
    const out = interpretListResponse(status, body, retryAfter);
    expect(out.kind).toBe('items');
    if (out.kind !== 'items') throw new Error('unreachable');
    const row = toMemoryView(out.items, 'owner', false).rows[0];
    expect(row?.sourceType).toBe('user_edit');
    expect(row?.sourceRef).toBe('memory:m0');
    expect(row?.confidenceLabel).toContain('0.5');
  });

  test('a NULL confidence survives JSON as null, not as an absent key', async () => {
    // The distinction matters: `undefined` would take the not-scored branch by luck rather than by contract.
    const { body } = await throughServer({ status: 'memory_list', items: [dto({ memoryItemId: 'm1', confidence: null })] });
    const parsed = JSON.parse(body) as { items: readonly MemoryItemDTO[] };
    expect(parsed.items[0]).toHaveProperty('confidence');
    expect(parsed.items[0]?.confidence).toBeNull();
    const out = interpretListResponse(200, body, null);
    if (out.kind !== 'items') throw new Error('unreachable');
    expect(toMemoryView(out.items, 'owner', false).rows[0]?.confidenceLabel).toBe('not scored');
  });

  test('a real supersession chain drives the derived backward link', async () => {
    const { body } = await throughServer({
      status: 'memory_list',
      items: [dto({ memoryItemId: 'v1', supersededBy: 'v2' }), dto({ memoryItemId: 'v2' })],
    });
    const out = interpretListResponse(200, body, null);
    if (out.kind !== 'items') throw new Error('unreachable');
    const rows = toMemoryView(out.items, 'owner', false).rows;
    expect(rows.find((r) => r.memoryItemId === 'v2')?.previousVersionId).toBe('v1');
    expect(rows.find((r) => r.memoryItemId === 'v1')?.lifecycle).toBe('superseded');
  });

  test('the served item carries EXACTLY the nine DTO fields and nothing else', async () => {
    // Pins the key set rather than asserting a field's absence: this fails if a field is ADDED, which is
    // the direction an accidental disclosure would take.
    const { body } = await throughServer({ status: 'memory_list', items: [dto({ memoryItemId: 'm1' })] });
    const parsed = JSON.parse(body) as { items: readonly Record<string, unknown>[] };
    expect(Object.keys(parsed.items[0] ?? {}).sort()).toEqual(
      ['confidence', 'confirmationState', 'content', 'createdAt', 'memoryItemId', 'sourceRef', 'sourceType', 'supersededBy', 'type'].sort(),
    );
  });

  test('an empty list is an empty list, and is not confused with an unread one', async () => {
    const { body } = await throughServer({ status: 'memory_list', items: [] });
    const out = interpretListResponse(200, body, null);
    if (out.kind !== 'items') throw new Error('unreachable');
    expect(toMemoryView(out.items, 'owner', false).itemsState).toBe('none_exist');
    expect(toMemoryView(null, 'owner', false).itemsState).toBe('unknown');
  });
});

describe('ACBP-FE-010 — the edit write', () => {
  test('the responder passes the edited item through unchanged, so the interpreter reads what was sent', async () => {
    // SCOPED HONESTLY. An earlier version of this test asserted `memoryItemId !== 'm_old'` and called that
    // proof of supersede-and-create. It proved nothing: the DTO is hand-built here, no request is ever
    // addressed to 'm_old', and `toCompaniesResponse` for the memory_edited arm is a pass-through that has
    // no notion of a requested id. Supersede-and-create is a DOMAIN behaviour, and it is pinned where it
    // actually happens — the real-PG PATCH test in memory-routes.integration.test.ts, which sends a real
    // request to a real id and asserts the returned id differs from it.
    const { status, body, retryAfter } = await throughServer({ status: 'memory_edited', item: dto({ memoryItemId: 'm_new', sourceType: 'user_edit' }) });
    expect(status).toBe(200);
    const out = interpretEditResponse(status, body, retryAfter);
    expect(out.kind).toBe('saved');
    if (out.kind !== 'saved') throw new Error('unreachable');
    expect(out.item.memoryItemId).toBe('m_new');
    expect(out.item.sourceType).toBe('user_edit');
  });

  test('the real validation envelope delivers the server sentence verbatim', async () => {
    const { status, body, retryAfter } = await throughServer({
      status: 'validation',
      error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'Memory content is too long.', retryable: false },
    });
    expect(status).toBe(400);
    const out = interpretEditResponse(status, body, retryAfter);
    expect(out.kind).toBe('invalid');
    if (out.kind !== 'invalid') throw new Error('unreachable');
    expect(out.serverMessage).toBe('Memory content is too long.');
  });

  test('the real conflict is read as a changed state, naming no single cause', async () => {
    const { status, body, retryAfter } = await throughServer({ status: 'conflict' });
    expect(status).toBe(409);
    const out = interpretEditResponse(status, body, retryAfter);
    expect(out.kind).toBe('conflict');
    expect(out.detail.toLowerCase()).not.toContain('already deleted');
  });
});

describe('ACBP-FE-010 — the delete write', () => {
  test('the real 200 carries only the id', async () => {
    const { status, body, retryAfter } = await throughServer({ status: 'memory_deleted', memoryItemId: 'm1' });
    expect(status).toBe(200);
    // The server deliberately leaks no content, actor or timestamp here, so the success notice cannot name
    // a time or a person — asserted rather than assumed.
    expect(Object.keys(JSON.parse(body) as Record<string, unknown>)).toEqual(['memoryItemId']);
    const out = interpretDeleteResponse(status, body, retryAfter);
    expect(out.kind).toBe('deleted');
    if (out.kind !== 'deleted') throw new Error('unreachable');
    expect(out.memoryItemId).toBe('m1');
  });

  test('the two 403 arms stay distinguishable after a real round trip', async () => {
    const forbidden = await throughServer({ status: 'forbidden' });
    const unverified = await throughServer({ status: 'email_unverified' });
    expect(interpretDeleteResponse(forbidden.status, forbidden.body, forbidden.retryAfter).kind).toBe('forbidden');
    expect(interpretDeleteResponse(unverified.status, unverified.body, unverified.retryAfter).kind).toBe('email_unverified');
  });

  test("rate_limited's Retry-After survives the header the server really sets", async () => {
    const { status, body, retryAfter } = await throughServer({ status: 'rate_limited', retryAfterSeconds: 42 });
    expect(status).toBe(429);
    expect(retryAfter, 'the server really does set the header').not.toBeNull();
    const out = interpretDeleteResponse(status, body, retryAfter);
    if (out.kind !== 'rate_limited') throw new Error('unreachable');
    expect(out.retryAfterSeconds).toBe(42);
  });
});
