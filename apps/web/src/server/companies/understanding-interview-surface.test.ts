/*
 * ACBP-API-013 — the understanding read (DISC-006) and the metered interview pair (DISC-003/005).
 *
 * ⚠️ WHAT THIS SUITE CAN AND CANNOT PROVE. The authorization is NOT tested here, because it does not live here:
 * `understanding:read` is checked inside `readCurrentUnderstanding`, and the interview pair inherits
 * `interview:read` / `memory:write` from the primitives it composes. Those are proved against real PostgreSQL by
 * the core suites. What this layer is held to is the opposite property — that it adds no second authority, debits
 * nothing before authorization, and cannot turn one verdict's payload into another's.
 */
import { describe, expect, it, vi } from 'vitest';
import { toCompaniesResponse, parseEvaluateAnswerBody } from './companies-http.js';
import { getUnderstandingForRequest, evaluateAnswerForRequest, suggestAssumptionForRequest } from './companies-request.js';

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const DOC = {
  documentId: 'doc_1',
  version: 3,
  status: 'complete' as const,
  overallConfidence: 0.62,
  sections: [{ class: 'fact' as const, count: 2, confidence: 0.8, status: 'present' as const }],
  items: [{ class: 'fact' as const, content: 'Sells wholesale coffee', confidence: 0.8 }],
  createdAt: '2026-08-19T00:00:00.000Z',
};

/*
 * A fake runtime carrying only what these rows touch. The FULL fake — the one whose required members make an
 * omission a compile error — lives in `companies-request.test.ts`; duplicating all 50 here would copy that
 * guarantee rather than add one.
 */
function deps(stub: Record<string, unknown>): Parameters<typeof getUnderstandingForRequest>[1] {
  const runtime = {
    checkRequestLimit: () => Promise.resolve({ kind: 'allowed' } as const),
    resolveInternalUser: () => Promise.resolve({ status: 'active', userId: 'usr_internal' }),
    ensurePersonalAccount: () => Promise.resolve({ accountId: 'acct_1', created: false }),
    getInterviewSession: () => Promise.resolve({ status: 'ok', session: { sessionId: 'sess_1' } }),
    authorizeMeteredParticipate: () => Promise.resolve('allowed' as const),
    ...stub,
  } as never;
  return {
    runtime,
    identity: {
      getUserId: () => Promise.resolve('clerk_1'),
      getSessionId: () => Promise.resolve('sess_test'),
      checkSessionLimit: () => Promise.resolve({ kind: 'allowed' } as const),
      getBackendUser: () =>
        Promise.resolve({
          id: 'clerk_1',
          primaryEmailAddressId: 'e1',
          emailAddresses: [{ id: 'e1', emailAddress: 'me@example.com', verification: { status: 'verified' } }],
          firstName: null,
          lastName: null,
        }),
    },
  };
}

describe('an absent understanding is a success, not a 404', () => {
  it('null document maps to 200 carrying null', async () => {
    // The G9 rule. A 404 would assert the company has no understanding SURFACE — a different, false statement,
    // and how a UI shows an error page on a founder's first visit.
    const res = toCompaniesResponse({ status: 'understanding', understanding: { document: null, confirmed: false, superseded: false } });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ document: null, confirmed: false, superseded: false });
  });

  it('the request layer forwards core\'s null rather than inventing an empty document', async () => {
    const r = await getUnderstandingForRequest('co_1', deps({ readCurrentUnderstanding: () => Promise.resolve({ status: 'ok', document: null, confirmed: false, superseded: false }) }));
    expect(r).toEqual({ status: 'understanding', understanding: { document: null, confirmed: false, superseded: false } });
  });
});

describe('superseded is carried SEPARATELY from confirmed (DISC-008)', () => {
  /*
   * ACBP-FE-009: "the UI shows a stale document as stale". A single `confirmed` boolean cannot support that — it
   * reads false both for a document nobody has confirmed and for one whose confirmation a correction undid. These
   * cases pin that the wire keeps them apart, so a screen never tells a founder who just corrected their
   * understanding that they have not confirmed it yet.
   */
  const withFlags = (confirmed: boolean, superseded: boolean) =>
    toCompaniesResponse({ status: 'understanding', understanding: { document: DOC, confirmed, superseded } });

  it('never confirmed → confirmed false, superseded FALSE', async () => {
    expect(await bodyOf(withFlags(false, false))).toMatchObject({ confirmed: false, superseded: false });
  });

  it('confirmed then corrected → confirmed false, superseded TRUE — the same confirmed value, a different state', async () => {
    expect(await bodyOf(withFlags(false, true))).toMatchObject({ confirmed: false, superseded: true });
  });

  it('confirmed and active → confirmed true, superseded false', async () => {
    expect(await bodyOf(withFlags(true, false))).toMatchObject({ confirmed: true, superseded: false });
  });

  it('the request layer forwards BOTH flags from core rather than deriving either', async () => {
    // A layer that computed `superseded: !confirmed` would pass every case above except this one.
    const r = await getUnderstandingForRequest(
      'co_1',
      deps({ readCurrentUnderstanding: () => Promise.resolve({ status: 'ok', document: DOC, confirmed: false, superseded: true }) }),
    );
    expect(r).toEqual({ status: 'understanding', understanding: { document: DOC, confirmed: false, superseded: true } });
  });
});

describe('confirmed travels with the document', () => {
  it('a confirmed document reports confirmed on the wire', async () => {
    const r = await getUnderstandingForRequest('co_1', deps({ readCurrentUnderstanding: () => Promise.resolve({ status: 'ok', document: DOC, confirmed: true, superseded: false }) }));
    expect(r.status).toBe('understanding');
    const body = await bodyOf(toCompaniesResponse(r));
    expect(body['confirmed']).toBe(true);
    expect((body['document'] as typeof DOC).version).toBe(3);
  });

  it('an UNCONFIRMED document is still returned — the screen decides what to say, the server does not hide it', async () => {
    const r = await getUnderstandingForRequest('co_1', deps({ readCurrentUnderstanding: () => Promise.resolve({ status: 'ok', document: DOC, confirmed: false, superseded: false }) }));
    const body = await bodyOf(toCompaniesResponse(r));
    expect(body['confirmed']).toBe(false);
    expect(body['document']).not.toBeNull();
  });

  it('a viewer refusal is forwarded unchanged as 403', async () => {
    const r = await getUnderstandingForRequest('co_1', deps({ readCurrentUnderstanding: () => Promise.resolve({ status: 'forbidden' }) }));
    expect(r).toEqual({ status: 'forbidden' });
    expect(toCompaniesResponse(r).status).toBe(403);
  });
});

describe('each verdict carries ONLY its own payload', () => {
  /*
   * THE ROW THIS SUITE EXISTS FOR. `EvaluateAnswerResult`'s ok arm is a three-way union with three different
   * payloads. If the wire flattened them, every field would be optional and a screen could render a
   * clarification beside a clear answer — telling a founder to rephrase something the server accepted.
   */
  it('clear sends memoryItemId and NO clarification or conflict', async () => {
    const body = await bodyOf(toCompaniesResponse({ status: 'answer_evaluated', evaluation: { status: 'ok', verdict: 'clear', memoryItemId: 'mem_1' } }));
    expect(body).toEqual({ verdict: 'clear', memoryItemId: 'mem_1' });
    expect(Object.keys(body)).not.toContain('clarification');
    expect(Object.keys(body)).not.toContain('conflict');
  });

  it('vague sends the clarification and NO memoryItemId', async () => {
    const body = await bodyOf(toCompaniesResponse({ status: 'answer_evaluated', evaluation: { status: 'ok', verdict: 'vague', clarification: 'Which region?' } }));
    expect(body).toEqual({ verdict: 'vague', clarification: 'Which region?' });
    expect(Object.keys(body)).not.toContain('memoryItemId');
  });

  it('contradictory sends the conflict and NO clarification', async () => {
    const body = await bodyOf(toCompaniesResponse({ status: 'answer_evaluated', evaluation: { status: 'ok', verdict: 'contradictory', conflict: 'Earlier you said retail.' } }));
    expect(body).toEqual({ verdict: 'contradictory', conflict: 'Earlier you said retail.' });
    expect(Object.keys(body)).not.toContain('clarification');
  });
});

describe('a null assumption is a success', () => {
  it('the model declining to assume is 200, not an error', async () => {
    // DISC-005: an invented assumption is exactly what the ai_assumption memory type exists to keep separable
    // from a founder-stated fact. "Nothing could be assumed" is an honest answer and must not read as a failure.
    const r = await suggestAssumptionForRequest('co_1', 'q_1', deps({ suggestAssumptionForSkip: () => Promise.resolve({ status: 'ok', assumption: null, memoryItemId: null }) }));
    const res = toCompaniesResponse(r);
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ assumption: null, memoryItemId: null });
  });
});

describe('the company ceiling is never debited before authorization', () => {
  it('a forbidden metered caller does NOT consume the company bucket', async () => {
    /*
     * CDR-092 §15's actual guarantee, applied to the member-level gate. If the debit ran first, an unauthorized
     * caller could drain a company's interview ceiling without ever being allowed to evaluate anything.
     *
     * ⚠️ ASSERT THE BUCKET, NOT THE STUB. `checkRequestLimit` serves TWO buckets through one method: the generic
     * per-ACCOUNT request limiter that guards every route during actor resolution, and the per-COMPANY metered
     * ceiling. The account call legitimately happens before authorization — it is what stops an unauthenticated
     * flood from reaching the authorization query at all. Only the `('company', …)` debit is the thing §15
     * protects, so a blanket `not.toHaveBeenCalled()` here would assert a rule the system does not have.
     */
    const limit = vi.fn(() => Promise.resolve({ kind: 'allowed' } as const));
    const evaluate = vi.fn();
    const r = await evaluateAnswerForRequest(
      'co_1',
      'q_1',
      'we sell coffee',
      deps({ authorizeMeteredParticipate: () => Promise.resolve('forbidden' as const), checkRequestLimit: limit, evaluateAnswer: evaluate }),
    );
    expect(r).toEqual({ status: 'forbidden' });
    expect(limit).not.toHaveBeenCalledWith('company', 'co_1');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('an authorized caller debits the COMPANY bucket, keyed on the company', async () => {
    const limit = vi.fn(() => Promise.resolve({ kind: 'allowed' } as const));
    await evaluateAnswerForRequest('co_1', 'q_1', 'we sell wholesale coffee', deps({ checkRequestLimit: limit, evaluateAnswer: () => Promise.resolve({ status: 'ok', verdict: 'clear', memoryItemId: 'mem_1' }) }));
    expect(limit).toHaveBeenCalledWith('company', 'co_1');
  });

  it('a throttled company yields 429 and never reaches the paid call', async () => {
    const evaluate = vi.fn();
    const r = await evaluateAnswerForRequest(
      'co_1',
      'q_1',
      'we sell coffee',
      deps({ checkRequestLimit: () => Promise.resolve({ kind: 'throttled', retryAfterSeconds: 12 } as const), evaluateAnswer: evaluate }),
    );
    expect(toCompaniesResponse(r).status).toBe(429);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('an UNREADABLE bucket fails closed — 503, and no paid call', async () => {
    const evaluate = vi.fn();
    const r = await evaluateAnswerForRequest('co_1', 'q_1', 'x', deps({ checkRequestLimit: () => Promise.resolve({ kind: 'unavailable' } as const), evaluateAnswer: evaluate }));
    expect(toCompaniesResponse(r).status).toBe(503);
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe('the session is the server\'s, and the answer text is forwarded raw', () => {
  it('the session id comes from the open interview, never from the caller', async () => {
    const seen = vi.fn();
    await evaluateAnswerForRequest(
      'co_1',
      'q_1',
      'we sell coffee',
      deps({
        evaluateAnswer: (p: unknown) => {
          seen(p);
          return Promise.resolve({ status: 'ok', verdict: 'clear', memoryItemId: 'm' });
        },
      }),
    );
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess_1', companyId: 'co_1', questionId: 'q_1', userId: 'usr_internal' }));
  });

  it('a vague-looking answer is forwarded UNJUDGED — the server scores it, not this layer', async () => {
    const seen = vi.fn();
    await evaluateAnswerForRequest(
      'co_1',
      'q_1',
      'dunno maybe',
      deps({
        evaluateAnswer: (p: unknown) => {
          seen(p);
          return Promise.resolve({ status: 'ok', verdict: 'vague', clarification: 'Which market?' });
        },
      }),
    );
    // ACBP-FE-008 forbids client-side answer scoring. Nothing here inspects the text.
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ answerText: 'dunno maybe' }));
  });
});

describe('the evaluate body parser checks shape, never quality', () => {
  function jsonRequest(body: string): Request {
    return new Request('https://example.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  }

  it('a blank answer is refused with 400 before it can spend anything', async () => {
    expect(await parseEvaluateAnswerBody(jsonRequest(JSON.stringify({ answerText: '   ' })))).toEqual({ ok: false, status: 400 });
  });

  it('a short or vague answer is ACCEPTED — judging it is the metered call\'s job', async () => {
    const parsed = await parseEvaluateAnswerBody(jsonRequest(JSON.stringify({ answerText: 'no idea' })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.input.answerText).toBe('no idea');
  });

  it('a non-JSON content type is refused with 415 before a byte is read', async () => {
    const req = new Request('https://example.test/x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'answerText=x' });
    expect(await parseEvaluateAnswerBody(req)).toEqual({ ok: false, status: 415 });
  });

  it('an oversize body is refused with 413 — a paid route is not an unbounded parser', async () => {
    const req = jsonRequest(JSON.stringify({ answerText: 'x'.repeat(20 * 1024) }));
    expect(await parseEvaluateAnswerBody(req)).toEqual({ ok: false, status: 413 });
  });
});
