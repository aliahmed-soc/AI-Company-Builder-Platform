// ACBP-P2-001 / CDR-022 — real-PostgreSQL proof of the interview session use cases through the RESTRICTED role.
// Setup/seed runs on the owner connection (the two-tenant harness); every operation runs as `acbp_app` under a
// validated CompanyScope. Proves: start (not_started→in_progress) emits interview.started in the SAME
// transaction; idempotent start (one open session per company); suspend/resume (in_progress⇄waiting_for_user)
// with EXACT KILL-AND-RESUME (the durable row survives independent transactions and a storage-layer read);
// illegal transitions rejected; company-active precondition; participate = owner|viewer, non-member forbidden;
// atomic rollback (a failing audit writer leaves NO session). Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DatabaseClient, AuditScope, AuditWriteContext } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import type { AuditEvent } from '@acbp/contracts';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { startInterviewSession, suspendInterviewSession, resumeInterviewSession, getInterviewSession } from './interview-session.js';

const CORE_SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('interview session use cases (real PostgreSQL, restricted role) — ACBP-P2-001/CDR-022', () => {
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

  const paramsFor = (userId: string, companyId: string, accountId: string) => ({ userId, accountId, companyId });

  test('start emits interview.started (same tx) and is idempotent — one open session per company', async () => {
    const started = await startInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA));
    expect(started.status).toBe('ok');
    if (started.status !== 'ok') return;
    expect(started.created).toBe(true);
    expect(started.session.state).toBe('in_progress');
    expect(started.session.phase).toBe('in_progress');
    expect(started.session.startedAt).not.toBeNull();

    // The interview.started audit was written in the same transaction: subject = session id; actor = the founder;
    // company stamped from the CompanyScope (never caller-supplied).
    const audits = await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'interview.started').where('company_id', '=', w.companyA1).execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ subject_id: started.session.sessionId, subject_type: 'interview_session', actor_type: 'user', actor_id: w.aOwner, account_id: w.accountA });

    // A second start returns the SAME open session (created: false) — no duplicate, no error.
    const again = await startInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA));
    expect(again.status === 'ok' && again.created).toBe(false);
    expect(again.status === 'ok' && again.session.sessionId).toBe(started.session.sessionId);
    // Still exactly ONE session row and ONE audit row for the company.
    expect(await owner.kysely.selectFrom('interview_sessions').selectAll().where('company_id', '=', w.companyA1).execute()).toHaveLength(1);
    expect(await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'interview.started').where('company_id', '=', w.companyA1).execute()).toHaveLength(1);
  });

  test('EXACT kill-and-resume: suspend, then the durable state survives independent transactions and a storage read', async () => {
    await startInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA));
    const suspended = await suspendInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA));
    expect(suspended.status === 'ok' && suspended.session.state).toBe('waiting_for_user');

    // "Kill": a completely independent transaction (and a direct storage-layer read) both see EXACTLY the
    // waiting_for_user state — nothing was lost on close.
    const reread = await getInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA));
    expect(reread.status === 'ok' && reread.session.state).toBe('waiting_for_user');
    const durable = await owner.kysely.selectFrom('interview_sessions').select(['state']).where('company_id', '=', w.companyA1).executeTakeFirstOrThrow();
    expect(durable.state).toBe('waiting_for_user');

    // Resume restores it to in_progress (the exact-resume transition).
    const resumed = await resumeInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA));
    expect(resumed.status === 'ok' && resumed.session.state).toBe('in_progress');
  });

  test('illegal transitions are rejected: resume of an in_progress session, and a double suspend', async () => {
    await startInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA));
    // The open session is in_progress; resume targets in_progress → not a legal (in_progress→in_progress) move.
    const badResume = await resumeInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA));
    expect(badResume.status).toBe('invalid_transition');
    expect(badResume.status === 'invalid_transition' && badResume.from).toBe('in_progress');
    // Suspend once (ok), then again → waiting_for_user→waiting_for_user is illegal.
    await suspendInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA));
    const doubleSuspend = await suspendInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA));
    expect(doubleSuspend.status).toBe('invalid_transition');
    expect(doubleSuspend.status === 'invalid_transition' && doubleSuspend.from).toBe('waiting_for_user');
  });

  test('transitions with no session are not_found; get with no session is not_found', async () => {
    expect((await suspendInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA))).status).toBe('not_found');
    expect((await getInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA))).status).toBe('not_found');
  });

  test('participate + read = any active company member (owner OR viewer); a non-member is forbidden', async () => {
    // A VIEWER of company A1 may start and read the interview (participate/read = owner|viewer).
    const byViewer = await startInterviewSession(product, paramsFor(w.aViewer, w.companyA1, w.accountA));
    expect(byViewer.status).toBe('ok');
    expect((await getInterviewSession(product, paramsFor(w.aViewer, w.companyA1, w.accountA))).status).toBe('ok');
    // The OUTSIDER (no membership anywhere) is denied — coarse forbidden, no oracle.
    expect((await startInterviewSession(product, paramsFor(w.outsider, w.companyA1, w.accountA))).status).toBe('forbidden');
    expect((await getInterviewSession(product, paramsFor(w.outsider, w.companyA1, w.accountA))).status).toBe('forbidden');
    // A member of a DIFFERENT tenant cannot reach company A1 (not a member of it).
    expect((await startInterviewSession(product, paramsFor(w.bOwner, w.companyA1, w.accountA))).status).toBe('forbidden');
  });

  test('company-active precondition: a paused company cannot start an interview', async () => {
    // Company B2 is PAUSED in the fixture and bOwner owns it → the active precondition blocks the start.
    const onPaused = await startInterviewSession(product, paramsFor(w.bOwner, w.companyB2, w.accountB));
    expect(onPaused.status).toBe('company_not_active');
    // …and nothing was written.
    expect(await owner.kysely.selectFrom('interview_sessions').selectAll().where('company_id', '=', w.companyB2).execute()).toHaveLength(0);
  });

  test('atomicity: a failing in-tx audit write rolls the whole start back — no orphaned session', async () => {
    const boom: (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string> = () => Promise.reject(new Error('deliberate audit failure'));
    const result = await startInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA), { auditWriter: boom }).catch((e: unknown) => ({ status: 'threw', error: e }) as const);
    // Whether the failure surfaces as a throw or is swallowed by the scope runner, the invariant is the same:
    // NO session row and NO audit row survive (the transaction rolled back atomically).
    void result;
    expect(await owner.kysely.selectFrom('interview_sessions').selectAll().where('company_id', '=', w.companyA1).execute()).toHaveLength(0);
    expect(await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'interview.started').where('company_id', '=', w.companyA1).execute()).toHaveLength(0);
    // A subsequent clean start still works (the failed attempt left no partial state to block it).
    const clean = await startInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA));
    expect(clean.status).toBe('ok');
  });

  test('a company-scoped session is invisible to another tenant (RLS): B cannot see A1’s session', async () => {
    const started = await startInterviewSession(product, paramsFor(w.aOwner, w.companyA1, w.accountA));
    expect(started.status).toBe('ok');
    // bOwner asking for company A1 is denied at resolution (not a member) — never a cross-tenant read.
    expect((await getInterviewSession(product, paramsFor(w.bOwner, w.companyA1, w.accountA))).status).toBe('forbidden');
    // And bOwner's own company B1 has no session of its own.
    expect((await getInterviewSession(product, paramsFor(w.bOwner, w.companyB1, w.accountB))).status).toBe('not_found');
  });
});
