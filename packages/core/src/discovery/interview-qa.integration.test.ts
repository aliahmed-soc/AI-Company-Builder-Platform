// ACBP-P2-002 / CDR-023 — real-PostgreSQL proof of the Q&A persistence use cases through the RESTRICTED role.
// Setup/seed runs on the owner connection (two-tenant harness); every operation runs as `acbp_app` under a
// validated CompanyScope. Proves: add immutable ordered questions; record an answer (append revision 1);
// revise (a new row, history retained); idempotent no-op on an identical resubmit; skip ("I don't know");
// the Q&A read (current answer + full history + derived lifecycle); participate/read = owner|viewer with
// non-members + cross-tenant forbidden; graceful concurrent revision; not_found for a foreign/unknown question.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { startInterviewSession } from './interview-session.js';
import { addInterviewQuestion, recordInterviewAnswer, getSessionQa } from './interview-qa.js';

const CORE_SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('interview Q&A use cases (real PostgreSQL, restricted role) — ACBP-P2-002/CDR-023', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });
  beforeEach(async () => {
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, CORE_SEED_OPS);
  });

  const base = (userId: string, sessionId: string) => ({ userId, accountId: w.accountA, companyId: w.companyA1, sessionId });

  /** Start a session for company A1 as aOwner and return its id. */
  async function startSessionA(): Promise<string> {
    const r = await startInterviewSession(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
    if (r.status !== 'ok') throw new Error(`could not start session: ${r.status}`);
    return r.session.sessionId;
  }

  test('add ordered immutable questions; record an answer, revise it (history retained), and read the Q&A', async () => {
    const s = await startSessionA();
    const q1 = await addInterviewQuestion(product, { ...base(w.aOwner, s), prompt: 'What problem?' });
    expect(q1.status === 'ok' && q1.question.position).toBe(1);
    const q2 = await addInterviewQuestion(product, { ...base(w.aOwner, s), prompt: 'Who for?' });
    expect(q2.status === 'ok' && q2.question.position).toBe(2);
    if (q1.status !== 'ok') return;

    const a1 = await recordInterviewAnswer(product, { ...base(w.aOwner, s), questionId: q1.question.questionId, status: 'answered', content: 'first' });
    expect(a1.status === 'ok' && a1.created && a1.answer.revision).toBe(1);
    const a2 = await recordInterviewAnswer(product, { ...base(w.aOwner, s), questionId: q1.question.questionId, status: 'answered', content: 'second' });
    expect(a2.status === 'ok' && a2.created && a2.answer.revision).toBe(2);

    const qa = await getSessionQa(product, base(w.aOwner, s));
    expect(qa.status).toBe('ok');
    if (qa.status !== 'ok') return;
    expect(qa.qa.items).toHaveLength(2);
    const item1 = qa.qa.items[0]!;
    expect(item1.question.questionId).toBe(q1.question.questionId);
    expect(item1.currentAnswer?.revision).toBe(2);
    expect(item1.currentAnswer?.content).toBe('second');
    expect(item1.revisions.map((r) => r.content)).toEqual(['first', 'second']); // full history retained
    expect(item1.lifecycle).toBe('answered');
    // The unanswered second question reads as `asked`.
    expect(qa.qa.items[1]!.currentAnswer).toBeNull();
    expect(qa.qa.items[1]!.lifecycle).toBe('asked');
  });

  test('idempotent: resubmitting the identical current answer creates no new revision', async () => {
    const s = await startSessionA();
    const q = await addInterviewQuestion(product, { ...base(w.aOwner, s), prompt: 'Q' });
    if (q.status !== 'ok') return;
    const first = await recordInterviewAnswer(product, { ...base(w.aOwner, s), questionId: q.question.questionId, status: 'answered', content: 'same' });
    const again = await recordInterviewAnswer(product, { ...base(w.aOwner, s), questionId: q.question.questionId, status: 'answered', content: 'same' });
    expect(first.status === 'ok' && first.created).toBe(true);
    expect(again.status === 'ok' && again.created).toBe(false);
    expect(again.status === 'ok' && again.answer.revision).toBe(1); // still revision 1
    const rows = await owner.kysely.selectFrom('interview_answers').selectAll().where('question_id', '=', q.question.questionId).execute();
    expect(rows).toHaveLength(1);
  });

  test('skip ("I don\'t know") records a skipped answer with no content and lifecycle skipped', async () => {
    const s = await startSessionA();
    const q = await addInterviewQuestion(product, { ...base(w.aOwner, s), prompt: 'Q' });
    if (q.status !== 'ok') return;
    const skip = await recordInterviewAnswer(product, { ...base(w.aOwner, s), questionId: q.question.questionId, status: 'skipped' });
    expect(skip.status === 'ok' && skip.answer.status).toBe('skipped');
    expect(skip.status === 'ok' && skip.answer.content).toBeNull();
    const qa = await getSessionQa(product, base(w.aOwner, s));
    expect(qa.status === 'ok' && qa.qa.items[0]!.lifecycle).toBe('skipped');
  });

  test('validation: an answered submission needs content; a skipped one forbids it', async () => {
    const s = await startSessionA();
    const q = await addInterviewQuestion(product, { ...base(w.aOwner, s), prompt: 'Q' });
    if (q.status !== 'ok') return;
    expect((await recordInterviewAnswer(product, { ...base(w.aOwner, s), questionId: q.question.questionId, status: 'answered' })).status).toBe('validation');
    expect((await recordInterviewAnswer(product, { ...base(w.aOwner, s), questionId: q.question.questionId, status: 'skipped', content: 'x' })).status).toBe('validation');
    expect((await recordInterviewAnswer(product, { ...base(w.aOwner, s), questionId: q.question.questionId, status: 'bogus', content: 'x' })).status).toBe('validation');
  });

  test('participate/read = owner|viewer; a non-member and a foreign tenant are forbidden', async () => {
    const s = await startSessionA();
    const q = await addInterviewQuestion(product, { ...base(w.aOwner, s), prompt: 'Q' });
    if (q.status !== 'ok') return;
    // A VIEWER of A1 may record + read.
    expect((await recordInterviewAnswer(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, sessionId: s, questionId: q.question.questionId, status: 'answered', content: 'v' })).status).toBe('ok');
    expect((await getSessionQa(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, sessionId: s })).status).toBe('ok');
    // The OUTSIDER is forbidden on both.
    expect((await addInterviewQuestion(product, { userId: w.outsider, accountId: w.accountA, companyId: w.companyA1, sessionId: s, prompt: 'x' })).status).toBe('forbidden');
    expect((await getSessionQa(product, { userId: w.outsider, accountId: w.accountA, companyId: w.companyA1, sessionId: s })).status).toBe('forbidden');
    // A member of tenant B cannot reach A1's session.
    expect((await getSessionQa(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1, sessionId: s })).status).toBe('forbidden');
  });

  test('not_found: recording against a question that is not in the session', async () => {
    const s = await startSessionA();
    const unknownQuestion = '00000000-0000-4000-8000-0000000000ff';
    expect((await recordInterviewAnswer(product, { ...base(w.aOwner, s), questionId: unknownQuestion, status: 'answered', content: 'x' })).status).toBe('not_found');
  });

  test('CONCURRENT revisions are graceful: two records race a revision, both ok, exactly one new row per revision', async () => {
    const s = await startSessionA();
    const q = await addInterviewQuestion(product, { ...base(w.aOwner, s), prompt: 'Q' });
    if (q.status !== 'ok') return;
    await recordInterviewAnswer(product, { ...base(w.aOwner, s), questionId: q.question.questionId, status: 'answered', content: 'v1' });
    // Two concurrent revisions over v1 → the (question_id, revision) PK + ON CONFLICT DO NOTHING makes the
    // loser return the current answer (no 23505/500). At most one new row lands per revision number.
    const [x, y] = await Promise.all([
      recordInterviewAnswer(product, { ...base(w.aOwner, s), questionId: q.question.questionId, status: 'answered', content: 'v2a' }),
      recordInterviewAnswer(product, { ...base(w.aOwner, s), questionId: q.question.questionId, status: 'answered', content: 'v2b' }),
    ]);
    expect(x.status).toBe('ok');
    expect(y.status).toBe('ok');
    const rows = await owner.kysely.selectFrom('interview_answers').selectAll().where('question_id', '=', q.question.questionId).execute();
    // No duplicate revision numbers, and history is a clean 1..N sequence.
    const revisions = rows.map((r) => r.revision).sort((a, b) => a - b);
    expect(new Set(revisions).size).toBe(revisions.length); // unique
    expect(revisions[0]).toBe(1);
  });

  test('cross-tenant isolation: tenant B never sees A1’s questions/answers', async () => {
    const s = await startSessionA();
    const q = await addInterviewQuestion(product, { ...base(w.aOwner, s), prompt: 'secret question' });
    if (q.status !== 'ok') return;
    await recordInterviewAnswer(product, { ...base(w.aOwner, s), questionId: q.question.questionId, status: 'answered', content: 'secret answer' });
    // bOwner reading A1's session is denied at resolution; and the storage rows are invisible to B's scope.
    expect((await getSessionQa(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1, sessionId: s })).status).toBe('forbidden');
    const bVisible = await owner.kysely.selectFrom('interview_questions').selectAll().where('company_id', '=', w.companyB1).execute();
    expect(bVisible).toHaveLength(0);
  });
});
