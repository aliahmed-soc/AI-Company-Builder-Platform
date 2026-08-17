/*
 * ACBP-FE-005 — the screen's interpreters, driven by the SERVER'S OWN response builder.
 *
 * WHY THIS EXISTS SEPARATELY from the interpreter unit tests. Those tests feed hand-written bodies, and a
 * hand-written body encodes what I BELIEVED the server sends. That belief was already wrong once in this
 * slice: the 400 validation arm carries `{ error: <PublicErrorEnvelope object> }`, and the first version of
 * `interpretCreateResponse` treated `error` as a string, threw the server's own message away, and passed its
 * unit tests because those tests asserted the same wrong shape.
 *
 * So this file does not hand-write bodies. It takes real `CompaniesRequestResult` arms, runs them through the
 * REAL `toCompaniesResponse` — the exact function the routes call — and feeds the actual status and body into
 * the client interpreters. If the server's envelope changes, these fail, and they fail on the arm that
 * changed rather than somewhere downstream in a page nobody can render in a test.
 *
 * The row's evidence line asks for "a route test covering create, poll and resume". The routes' own behaviour
 * is already covered by companies-request.test.ts and companies-http.test.ts from ACBP-P1-012, and this slice
 * adds no route — so rather than restate that coverage, this pins the SEAM those tests do not: that what the
 * server actually emits is what this screen actually reads.
 */
import { describe, test, expect } from 'vitest';
import { toCompaniesResponse } from '@/server/companies/companies-http';
import type { CompaniesRequestResult } from '@/server/companies/companies-request';
import { interpretCreateResponse } from './create-outcome';
import { interpretResumeResponse } from '../[companyId]/provisioning/resume-outcome';
import { toProvisioningView } from '../[companyId]/provisioning/provisioning-view';

/*
 * NO `as` CAST ON THE ARGUMENT, and that is deliberate. The first version of this file cast each literal to
 * `CompaniesRequestResult`, which let a WRONG shape through the compiler: the `created` arm is FLAT —
 * `{status:'created', companyId, companyStatus, creationMode}` — and the `{company:{…}}` nesting is produced
 * BY `toCompaniesResponse` (companies-http.ts:117), not passed to it. The cast hid that, the server built
 * `{company:{}}` from undefined fields, and the interpreter correctly reported an error. Taking the parameter
 * as the real union means the compiler now rejects a malformed arm instead of a test doing it at runtime.
 */
async function throughServer(result: CompaniesRequestResult): Promise<{ status: number; body: string; retryAfter: string | null }> {
  const res = toCompaniesResponse(result);
  return { status: res.status, body: await res.text(), retryAfter: res.headers.get('retry-after') };
}

const provisioning = {
  companyId: 'c-1',
  companyStatus: 'onboarding',
  steps: [
    { step: 'profile' as const, order: 1, status: 'completed' as const, attempt: 1, requestedAt: '2026-08-17T00:00:00.000Z', startedAt: null, completedAt: '2026-08-17T00:00:01.000Z', failedAt: null, failureCode: null },
    { step: 'mission_draft' as const, order: 2, status: 'pending' as const, attempt: 0, requestedAt: '2026-08-17T00:00:00.000Z', startedAt: null, completedAt: null, failedAt: null, failureCode: null },
    { step: 'research' as const, order: 3, status: 'pending' as const, attempt: 0, requestedAt: '2026-08-17T00:00:00.000Z', startedAt: null, completedAt: null, failedAt: null, failureCode: null },
    { step: 'roadmap' as const, order: 4, status: 'pending' as const, attempt: 0, requestedAt: '2026-08-17T00:00:00.000Z', startedAt: null, completedAt: null, failedAt: null, failureCode: null },
    { step: 'documents' as const, order: 5, status: 'pending' as const, attempt: 0, requestedAt: '2026-08-17T00:00:00.000Z', startedAt: null, completedAt: null, failedAt: null, failureCode: null },
    { step: 'activity' as const, order: 6, status: 'pending' as const, attempt: 0, requestedAt: '2026-08-17T00:00:00.000Z', startedAt: null, completedAt: null, failedAt: null, failureCode: null },
  ],
  nextIncompleteStep: 'mission_draft' as const,
  resumable: true,
  exhausted: false,
  completed: false,
};

describe('ACBP-FE-005 — CREATE: the screen reads what the server actually emits', () => {
  test('the 201 the server builds routes the founder onward', async () => {
    const { status, body, retryAfter } = await throughServer({ status: 'created', companyId: 'c-9', companyStatus: 'onboarding', creationMode: 'own_idea' });
    expect(status).toBe(201);
    const r = interpretCreateResponse(status, body, retryAfter);
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') throw new Error('unreachable');
    expect(r.companyId).toBe('c-9');
    expect(r.provisioningFinishedInline).toBe(false);
  });

  test("the REAL validation envelope reaches the screen with the server's own message intact", async () => {
    // This is the assertion that would have caught the original defect: the arm carries an OBJECT.
    const { status, body, retryAfter } = await throughServer({
      status: 'validation',
      error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'A company name is required.', retryable: false },
    });
    expect(status).toBe(400);
    const r = interpretCreateResponse(status, body, retryAfter);
    expect(r.kind).toBe('invalid');
    if (r.kind !== 'invalid') throw new Error('unreachable');
    expect(r.serverMessage).toBe('A company name is required.');
  });

  test('the two 403 arms stay distinguishable after a real round trip', async () => {
    const forbidden = await throughServer({ status: 'forbidden' });
    const unverified = await throughServer({ status: 'email_unverified' });
    expect(forbidden.status).toBe(403);
    expect(unverified.status).toBe(403);
    const a = interpretCreateResponse(forbidden.status, forbidden.body, forbidden.retryAfter);
    const b = interpretCreateResponse(unverified.status, unverified.body, unverified.retryAfter);
    expect(a.kind).toBe('forbidden');
    expect(b.kind).toBe('email_unverified');
  });

  test("rate_limited's Retry-After survives the real header the server sets", async () => {
    const { status, body, retryAfter } = await throughServer({ status: 'rate_limited', retryAfterSeconds: 31 });
    expect(status).toBe(429);
    expect(retryAfter, 'the server really does set the header').not.toBeNull();
    const r = interpretCreateResponse(status, body, retryAfter);
    if (r.kind !== 'rate_limited') throw new Error('unreachable');
    expect(r.retryAfterSeconds).toBe(31);
  });
});

describe('ACBP-FE-005 — POLL: the provisioning body the server emits is the one the view maps', () => {
  test('the served envelope drives the view without any reshaping in between', async () => {
    const { status, body } = await throughServer({ status: 'provisioning', provisioning });
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as typeof provisioning;
    // The exact key set the server promises (companies-http.test.ts pins this too) — if a key is dropped or
    // added, the view is reading something other than what ships.
    expect(Object.keys(parsed).sort()).toEqual(['companyId', 'companyStatus', 'completed', 'exhausted', 'nextIncompleteStep', 'resumable', 'steps'].sort());
    const view = toProvisioningView(parsed);
    expect(view.kind).toBe('resumable');
    if (view.kind !== 'resumable') throw new Error('unreachable');
    expect(view.nextStep).toBe('mission_draft');
    expect(view.completedCount).toBe(1);
    expect(view.totalCount).toBe(6);
  });

  test('the served body carries no account identifier', async () => {
    const { body } = await throughServer({ status: 'provisioning', provisioning });
    expect(body).not.toContain('accountId');
  });
});

describe('ACBP-FE-005 — RESUME: the screen reads the real resume arms', () => {
  test('a real resume success carries the new state back into the view', async () => {
    const { status, body, retryAfter } = await throughServer({ status: 'provisioning', provisioning });
    const r = interpretResumeResponse(status, body, retryAfter);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error('unreachable');
    expect(toProvisioningView(r.provisioning).kind).toBe('resumable');
  });

  test('the real 409 is read as a refusal that names no single cause', async () => {
    const { status, body, retryAfter } = await throughServer({ status: 'conflict' });
    expect(status).toBe(409);
    const r = interpretResumeResponse(status, body, retryAfter);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') throw new Error('unreachable');
    expect(r.detail).toMatch(/does not say|several|which/i);
  });
});
