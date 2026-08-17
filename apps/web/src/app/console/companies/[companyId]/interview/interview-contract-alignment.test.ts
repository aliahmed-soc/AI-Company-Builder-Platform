/*
 * ACBP-FE-007 — the interview screen's modules, driven by the SERVER'S OWN response builder.
 *
 * Same reasoning as `create-contract-alignment.test.ts` beside it, and the same defect behind it: a
 * hand-written body encodes what the author BELIEVED the server sends, and in FE-005 that belief was wrong in
 * a way the unit tests could not catch, because they asserted the same wrong shape. So nothing here is
 * hand-written. Real `CompaniesRequestResult` arms go through the REAL `toCompaniesResponse` — the exact
 * function the five interview routes call — and the actual status and body are fed to this screen's modules.
 *
 * THE GENUINELY NEW EVIDENCE IS `rationale` AND `source` ON THE WIRE — and only on the wire. Both fields are
 * already covered where they are produced and stored (packages/database interview-question-adaptive
 * integration tests, packages/contracts orchestration tests); what has never been asserted is that they
 * SURVIVE SERIALIZATION to an HTTP body. `companies-http.test.ts` exercises the qa arm with `items: []`, so
 * no question is serialized at all, and `interview-qa-routes.integration.test.ts` reaches only into
 * `currentAnswer.content`. Both fields are the substance of this ticket — `rationale` IS the row's "why this
 * question", and `source` is the flag that tells a founder the interview degraded to the static bank — so a
 * responder that dropped either would remove the feature with every existing test still green.
 *
 * The row's evidence line asks for "route tests for answer, suspend and resume". That coverage already
 * exists at three layers (companies-request.test.ts:318-387, companies-http.test.ts:43-74, and the two
 * real-DB suites in server/adversarial), and this slice adds no route. Restating it would be duplication;
 * this pins the seam those tests do not — that what the server emits is what this screen reads.
 */
import { describe, test, expect } from 'vitest';
import { toCompaniesResponse } from '@/server/companies/companies-http';
import type { CompaniesRequestResult } from '@/server/companies/companies-request';
import type { QuestionWithAnswerDTO } from '@acbp/contracts';
import { toInterviewView } from './interview-view';
import { interpretAnswerResponse } from './answer-outcome';
import { interpretSessionResponse } from './session-outcome';

// No `as` cast on the argument — deliberately. See create-contract-alignment.test.ts:27-34: a cast let a
// malformed arm through the compiler once already, and the server then built a body from undefined fields.
async function throughServer(result: CompaniesRequestResult): Promise<{ status: number; body: string; retryAfter: string | null }> {
  const res = toCompaniesResponse(result);
  return { status: res.status, body: await res.text(), retryAfter: res.headers.get('retry-after') };
}

const session = {
  sessionId: 'ses_1',
  companyId: 'cmp_1',
  state: 'in_progress' as const,
  phase: 'in_progress' as const,
  startedAt: '2026-08-17T00:00:00.000Z',
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
};

function item(over: { id: string; position: number; rationale: string | null; source: 'adaptive' | 'static_fallback' }): QuestionWithAnswerDTO {
  return {
    question: { questionId: over.id, position: over.position, prompt: `Prompt ${over.id}`, rationale: over.rationale, source: over.source, createdAt: '2026-08-17T00:00:00.000Z' },
    currentAnswer: null,
    revisions: [],
    lifecycle: 'asked',
  };
}

describe('ACBP-FE-007 — the qa read: what the server serializes is what the screen renders', () => {
  test('rationale and source survive the real round trip into the view', async () => {
    const { status, body } = await throughServer({
      status: 'qa',
      qa: { sessionId: 'ses_1', items: [item({ id: 'q1', position: 1, rationale: 'To size the market.', source: 'adaptive' }), item({ id: 'q2', position: 2, rationale: 'Fallback bank.', source: 'static_fallback' })] },
    });
    expect(status).toBe(200);

    const parsed = JSON.parse(body) as { qa: { sessionId: string; items: readonly QuestionWithAnswerDTO[] } };
    // The nesting is built BY the responder, so read it the way the client will rather than assuming.
    const view = toInterviewView(session, parsed.qa);

    expect(view.questions[0]?.rationale).toBe('To size the market.');
    expect(view.questions[0]?.degraded).toBe(false);
    expect(view.questions[1]?.rationale).toBe('Fallback bank.');
    expect(view.questions[1]?.degraded, 'the static-fallback flag must reach the screen or the honest-degradation signal is lost').toBe(true);
  });

  test('a NULL rationale survives as null rather than arriving undefined', async () => {
    // JSON round-tripping is where an explicit null quietly becomes an absent key. The why-block must render
    // as absent, and `undefined` would take the same branch by luck rather than by contract.
    const { body } = await throughServer({ status: 'qa', qa: { sessionId: 'ses_1', items: [item({ id: 'q1', position: 1, rationale: null, source: 'adaptive' })] } });
    const parsed = JSON.parse(body) as { qa: { items: readonly QuestionWithAnswerDTO[] } };
    expect(parsed.qa.items[0]?.question.rationale).toBeNull();
    expect(toInterviewView(session, { sessionId: 'ses_1', items: parsed.qa.items }).questions[0]?.rationale).toBeNull();
  });

  test('an empty qa read is the no-questions state, never a finished one', async () => {
    const { body } = await throughServer({ status: 'qa', qa: { sessionId: 'ses_1', items: [] } });
    const parsed = JSON.parse(body) as { qa: { sessionId: string; items: readonly QuestionWithAnswerDTO[] } };
    expect(toInterviewView(session, parsed.qa).questionsState).toBe('none_exist');
  });

  test('the served question carries EXACTLY the six DTO fields and nothing else', async () => {
    // This replaces a `not.toContain('accountId')` assertion that could not fail: the arm is typed
    // `SessionQADTO`, which has no such field, so the responder was handed a payload with nothing to leak
    // and the test name promised a redaction guarantee it never exercised. Pinning the exact key set is a
    // real guarantee — it fails if a field is ADDED to the wire as well as if one is dropped, which is the
    // direction an accidental disclosure would actually take.
    const { body } = await throughServer({ status: 'qa', qa: { sessionId: 'ses_1', items: [item({ id: 'q1', position: 1, rationale: 'why', source: 'adaptive' })] } });
    const parsed = JSON.parse(body) as { qa: { items: readonly { question: Record<string, unknown> }[] } };
    const question = parsed.qa.items[0]?.question;
    expect(question).toBeDefined();
    expect(Object.keys(question ?? {}).sort()).toEqual(['createdAt', 'position', 'prompt', 'questionId', 'rationale', 'source'].sort());
  });
});

describe('ACBP-FE-007 — the answer write', () => {
  test('the real 200 envelope reaches the interpreter and reads as saved', async () => {
    const { status, body, retryAfter } = await throughServer({
      status: 'answer',
      answer: { questionId: 'q1', revision: 1, status: 'answered', content: 'Independent clinics.', createdAt: '2026-08-17T00:00:00.000Z' },
      created: true,
    });
    expect(status).toBe(200);
    const r = interpretAnswerResponse(status, body, retryAfter, { status: 'answered', content: 'Independent clinics.' });
    expect(r.kind).toBe('saved');
  });

  test('a REAL created:false carrying different content is read as a lost answer, not a quiet success', async () => {
    // The contention arm: the server truthfully returns whatever is stored now, which may be another
    // writer's. Driving it through the real responder proves the shape the client discriminates on is the
    // shape actually emitted.
    const { status, body, retryAfter } = await throughServer({
      status: 'answer',
      answer: { questionId: 'q1', revision: 4, status: 'answered', content: 'Text another writer stored.', createdAt: '2026-08-17T00:00:00.000Z' },
      created: false,
    });
    const r = interpretAnswerResponse(status, body, retryAfter, { status: 'answered', content: 'What the founder typed.' });
    expect(r.kind).toBe('overwritten_by_other');
    if (r.kind !== 'overwritten_by_other') throw new Error('unreachable');
    expect(r.storedContent).toBe('Text another writer stored.');
  });

  test('an identical created:false is read as unchanged', async () => {
    const { status, body, retryAfter } = await throughServer({
      status: 'answer',
      answer: { questionId: 'q1', revision: 1, status: 'answered', content: 'Same text.', createdAt: '2026-08-17T00:00:00.000Z' },
      created: false,
    });
    expect(interpretAnswerResponse(status, body, retryAfter, { status: 'answered', content: 'Same text.' }).kind).toBe('unchanged');
  });

  test.each([
    'Answer status is invalid.',
    'A skipped answer carries no content.',
    'An answer requires non-empty content.',
    'Answer content is too long.',
  ])('the real validation envelope delivers %j verbatim', async (message) => {
    // The four sentences validateAnswerSubmission actually produces. This is the FE-005 assertion applied to
    // the endpoint where the message matters most — the server has already named which field is wrong.
    const { status, body, retryAfter } = await throughServer({ status: 'validation', error: { category: 'validation', code: 'VALIDATION_FAILED', message, retryable: false } });
    expect(status).toBe(400);
    const r = interpretAnswerResponse(status, body, retryAfter, { status: 'answered', content: 'x' });
    expect(r.kind).toBe('invalid');
    if (r.kind !== 'invalid') throw new Error('unreachable');
    expect(r.serverMessage).toBe(message);
  });
});

describe('ACBP-FE-007 — refusals that must survive the round trip as distinct things', () => {
  test('the two 409s do not collapse after real serialization', async () => {
    const transition = await throughServer({ status: 'invalid_transition', from: 'waiting_for_user' });
    const inactive = await throughServer({ status: 'company_not_active' });
    expect(transition.status).toBe(409);
    expect(inactive.status).toBe(409);

    const a = interpretSessionResponse('pause', transition.status, transition.body, transition.retryAfter);
    const b = interpretSessionResponse('start', inactive.status, inactive.body, inactive.retryAfter);
    expect(a.kind).toBe('blocked_transition');
    expect(b.kind).toBe('company_not_active');
    // `from` is the only detail the refusal carries, and it has to survive to be worth rendering.
    if (a.kind !== 'blocked_transition') throw new Error('unreachable');
    expect(a.from).toBe('waiting_for_user');
  });

  test('the two 403s stay distinguishable', async () => {
    const forbidden = await throughServer({ status: 'forbidden' });
    const unverified = await throughServer({ status: 'email_unverified' });
    expect(interpretSessionResponse('start', forbidden.status, forbidden.body, forbidden.retryAfter).kind).toBe('forbidden');
    expect(interpretSessionResponse('start', unverified.status, unverified.body, unverified.retryAfter).kind).toBe('email_unverified');
  });

  test('a bare conflict is read as a conflict rather than mistaken for a transition refusal', async () => {
    const { status, body, retryAfter } = await throughServer({ status: 'conflict' });
    expect(interpretSessionResponse('pause', status, body, retryAfter).kind).toBe('conflict');
  });

  test('the same 404 means different things to start and to pause', async () => {
    const { status, body, retryAfter } = await throughServer({ status: 'not_found' });
    expect(interpretSessionResponse('start', status, body, retryAfter).kind).toBe('no_user_record');
    expect(interpretSessionResponse('pause', status, body, retryAfter).kind).toBe('no_session');
  });

  test("rate_limited's Retry-After survives the header the server really sets", async () => {
    const { status, body, retryAfter } = await throughServer({ status: 'rate_limited', retryAfterSeconds: 31 });
    expect(status).toBe(429);
    expect(retryAfter, 'the server really does set the header').not.toBeNull();
    const r = interpretSessionResponse('pause', status, body, retryAfter);
    if (r.kind !== 'rate_limited') throw new Error('unreachable');
    expect(r.retryAfterSeconds).toBe(31);
  });
});

describe('ACBP-FE-007 — the session read', () => {
  test('the served session drives the controls from the phase the server chose', async () => {
    const { status, body } = await throughServer({ status: 'interview', session: { ...session, state: 'waiting_for_user', phase: 'awaiting_input' } });
    expect(status).toBe(200);
    const parsed = JSON.parse(body) as { session: typeof session };
    const view = toInterviewView(parsed.session, { sessionId: 'ses_1', items: [] });
    expect(view.resume.kind).toBe('available');
    expect(view.pause.kind).toBe('unavailable');
  });

  test('the served session carries EXACTLY the seven DTO fields and nothing else', async () => {
    // Same reasoning as the qa key-set assertion above: pinning the set catches an ADDED field, which is the
    // shape a disclosure would take. `accountId` really is absent — but the point is that this test would
    // now notice if it stopped being.
    const { body } = await throughServer({ status: 'interview', session });
    const parsed = JSON.parse(body) as { session: Record<string, unknown> };
    expect(Object.keys(parsed.session).sort()).toEqual(['companyId', 'createdAt', 'phase', 'sessionId', 'startedAt', 'state', 'updatedAt'].sort());
  });
});
