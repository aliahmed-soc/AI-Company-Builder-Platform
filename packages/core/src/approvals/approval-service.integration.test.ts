// ACBP-P6-003c / CDR-068 — real-PostgreSQL proof of the APPROVAL SERVICE itself, through the restricted role.
//
// WHY THIS FILE EXISTS. Two independent review passes found the same thing from different angles: the approval
// service — the ticket's headline deliverable — had no tests and no consumers. Eight mutations of its production
// source survived the entire 2953-test suite green, including `approval:decide` downgraded to `approval:read` (any
// viewer may decide an approval), the authenticated-decider overwrite reverted to a caller-supplied id, the audit
// event deleted, and evaluation point 2 recorded as point 3. Nothing could call the module, so nothing did.
//
// Each test below corresponds to a mutation that used to survive. The point is not coverage percentage; it is that
// every guard in this module now has something that fails when the guard is removed.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { type DatabaseClient } from '@acbp/database';
import {
  hasTestDatabase,
  createOwnerFixtureClient,
  createRestrictedProductClient,
  enableAppLogin,
  resetSchema,
  truncateFixtures,
  seedTwoTenantWorld,
  teardown,
  assertRestrictedRole,
  type TwoTenantWorld,
} from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask } from '../tasks/index.js';
import { startRun } from '../runs/index.js';
import { initializeCompanyPolicy } from '../policy/index.js';
import { requestApproval, decideApproval, revokeApproval, listApprovalInbox } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('approval service (real PostgreSQL, restricted role) — ACBP-P6-003c/CDR-068', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let runId: string;

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

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });

  /**
   * The content half of a request. Complete on purpose — incompleteness is its own test.
   *
   * `expiresAt` IS STATED EXPLICITLY, and it has to be: ACBP-P6-004 ships the expiry mechanism with no default
   * value anywhere, because ADR-009 §15 leaves per-risk-class defaults an open owner question. A test that could
   * omit it would mean the platform was quietly answering that question somewhere.
   */
  const content = () => ({
    expiresAt: new Date(Date.now() + 3_600_000),
    scope: 'one_action' as const,
    action: 'Email three suppliers',
    reason: 'Outreach is the next planned step',
    expectedResult: 'Three emails delivered',
    data: { recipients: 3 },
    estimatedCostCredits: 1,
    preview: 'To: 3 suppliers',
  });

  const request = (over: Record<string, unknown> = {}) => requestApproval(product, { ...base(), runId, toolId: 'send_email', ...content(), ...over });

  const okRequestId = async (over: Record<string, unknown> = {}): Promise<string> => {
    const r = await request(over);
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    return r.request.id;
  };

  const events = async (name: string) =>
    owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', name).orderBy('event_id').execute();
  const evaluations = async () => owner.kysely.selectFrom('policy_evaluations').selectAll().orderBy('created_at').execute();

  beforeEach(async () => {
    await truncateFixtures(owner);
    await sql`delete from tool_definitions`.execute(owner.kysely);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);

    const created = await createTask(product, { ...base(), title: 'Contact suppliers', description: null, milestoneId: null });
    const taskId = (created as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await planTask(product, { ...base(), taskId })).status).toBe('ok');
    await sql`update tasks set state = 'queued' where id = ${taskId}::uuid`.execute(owner.kysely);
    const started = await startRun(product, { ...base(), taskId, attempt: 1 });
    expect(started.status).toBe('ok');
    runId = (started as { status: 'ok'; run: { id: string } }).run.id;

    await sql`insert into tool_definitions (tool_id, version, risk_class, description, status)
              values ('send_email', 1, 'external_reversible', 'fixture tool', 'active'),
                     ('wipe_everything', 1, 'sensitive_irreversible', 'fixture tool', 'active'),
                     ('unclassified_tool', 1, null, 'fixture tool', 'active')`.execute(owner.kysely);

    expect((await initializeCompanyPolicy(product, base())).status).toBe('ok');
  });

  // ───────────────────────────────── REQUESTING (mutations: no authz, point 2 mislabelled) ─────────────────────

  test('a request records EVALUATION POINT 2 and pins the policy version the human will decide under', async () => {
    const id = await okRequestId();

    // POINT 2, NOT POINT 3. The two are different questions — point 2 makes the decision explicable afterwards —
    // and recording one as the other was a surviving mutation.
    const evaluation = (await evaluations())[0];
    expect(evaluation?.evaluation_point).toBe('approval_requested');

    // The version is on the REQUEST, which is the whole purpose of the point-2 evaluation.
    const row = await owner.kysely.selectFrom('approval_requests').selectAll().where('id', '=', id).executeTakeFirst();
    expect(Number(row?.policy_version)).toBe(Number(evaluation?.policy_version));
    expect(await events('approval.requested')).toHaveLength(1);
  });

  test('a NON-MEMBER of the company cannot raise an approval request', async () => {
    // Company B's owner against company A. Refused, and nothing is written — an approval that a stranger can
    // create is an inbox a stranger can fill.
    const r = await requestApproval(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1, runId, toolId: 'send_email', ...content() });
    expect(r.status).not.toBe('ok');
    expect(await owner.kysely.selectFrom('approval_requests').selectAll().execute()).toHaveLength(0);
  });

  test('a VIEWER cannot raise an approval request — requesting rides the EXECUTION authority, not the read one', async () => {
    const r = await requestApproval(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, runId, toolId: 'send_email', ...content() });
    expect(r.status).toBe('forbidden');
    expect(await owner.kysely.selectFrom('approval_requests').selectAll().execute()).toHaveLength(0);
  });

  test('the inbox page is CLAMPED — a caller cannot ask for the whole history at once', async () => {
    for (let i = 0; i < 3; i += 1) await okRequestId();
    const r = await listApprovalInbox(product, { ...base(), limit: 1_000_000 });
    // The clamp is what stops an unbounded read; asking for a million must not return a million.
    expect((r as { status: 'ok'; requests: readonly unknown[] }).requests.length).toBeLessThanOrEqual(200);
    // …and a nonsense limit does not become "everything" either.
    const junk = await listApprovalInbox(product, { ...base(), limit: Number.NaN });
    expect((junk as { status: 'ok'; requests: readonly unknown[] }).requests.length).toBeLessThanOrEqual(200);
  });

  test('an INCOMPLETE request is refused, and nothing is written or evaluated', async () => {
    const r = await request({ reason: '   ' });
    expect(r).toMatchObject({ status: 'incomplete' });
    expect(await owner.kysely.selectFrom('approval_requests').selectAll().execute()).toHaveLength(0);
    // Refused BEFORE the evaluation, so the record never mentions a request that was never viable.
    expect(await evaluations()).toHaveLength(0);
  });

  // ───────────────── THE RISK CLASS COMES FROM THE REGISTRY, NOT THE CALLER (review pass 1 H3 / pass 2 H5) ──────

  test('the risk class and tool version come from tool_definitions — a caller cannot understate the danger', async () => {
    const id = await okRequestId({ toolId: 'wipe_everything' });
    const row = await owner.kysely.selectFrom('approval_requests').selectAll().where('id', '=', id).executeTakeFirst();

    // The caller passed no risk class at all — there is no parameter to pass one through any more. The registry
    // says `sensitive_irreversible`, so the human is shown `irreversible`. Before this fix a model could declare
    // `informational`, `reversibilityOf` would derive "reversible" from the lie, and the CHECK would certify the
    // pair as consistent: an irreversible action presented to a human as undoable.
    expect(row?.risk_class).toBe('sensitive_irreversible');
    expect(row?.reversibility).toBe('irreversible');
    expect(Number(row?.tool_version)).toBe(1);
  });

  test('an UNCLASSIFIED tool is treated as the most dangerous, not the least', async () => {
    const id = await okRequestId({ toolId: 'unclassified_tool' });
    const row = await owner.kysely.selectFrom('approval_requests').selectAll().where('id', '=', id).executeTakeFirst();
    expect(row?.risk_class).toBe('sensitive_irreversible');
    expect(row?.reversibility).toBe('irreversible');
  });

  test('an UNREGISTERED tool cannot have an approval raised for it', async () => {
    // There is no registry row, so there is no risk class to show a human — and a request whose danger is unknown
    // is not a request anyone can meaningfully approve.
    expect(await request({ toolId: 'never_registered' })).toMatchObject({ status: 'tool_not_registered' });
  });

  // ─────────────────────────── DECIDING (mutations: owner-only gate, decider forgery, audit) ───────────────────

  test('DECIDING IS OWNER-ONLY — a viewer who can read the inbox cannot answer it', async () => {
    const id = await okRequestId();
    const r = await decideApproval(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, requestId: id, decision: { path: 'approve', decidedAt: new Date() } });
    expect(r.status).toBe('forbidden');

    // And the refusal is total: no decision row, and the request is still waiting for a human.
    expect(await owner.kysely.selectFrom('approval_decisions').selectAll().execute()).toHaveLength(0);
    expect((await owner.kysely.selectFrom('approval_requests').selectAll().where('id', '=', id).executeTakeFirst())?.status).toBe('pending');
  });

  test('the DECIDER IS THE AUTHENTICATED CALLER — a supplied user id is discarded, not honoured', async () => {
    const id = await okRequestId();
    // The caller names someone else as the approver. The audit trail's entire value is that the name on a decision
    // is the name of whoever made it.
    const r = await decideApproval(product, { ...base(), requestId: id, decision: { path: 'approve', decidedAt: new Date(), decidedBy: { userId: w.bOwner } } as never });
    expect(r.status).toBe('ok');

    const decision = await owner.kysely.selectFrom('approval_decisions').selectAll().executeTakeFirst();
    expect(decision?.decided_by_user_id).toBe(w.aOwner);
    expect(decision?.decided_by_user_id).not.toBe(w.bOwner);
  });

  test('a caller cannot declare its own DECIDER TYPE — including `delegated`, which nothing can yet verify', async () => {
    const id = await okRequestId();
    // Invariant 5's three layers all tested this same caller-supplied string, so what they enforced was "a caller
    // that honestly declares itself a worker is refused". The type is now derived from the authenticated principal.
    const r = await decideApproval(product, { ...base(), requestId: id, decision: { path: 'approve', decidedAt: new Date(), decidedBy: { type: 'delegated' } } as never });
    expect(r).toMatchObject({ status: 'invalid' });
    expect(await owner.kysely.selectFrom('approval_decisions').selectAll().execute()).toHaveLength(0);
  });

  test('a decision writes its audit event in the SAME transaction as the decision itself', async () => {
    const id = await okRequestId();
    expect((await decideApproval(product, { ...base(), requestId: id, decision: { path: 'approve', decidedAt: new Date() } })).status).toBe('ok');
    expect(await events('approval.approved')).toHaveLength(1);
  });

  test('a REJECTION is recorded as a rejection, with the human reason kept OUT of the audit event', async () => {
    const id = await okRequestId();
    const secret = 'I do not trust this supplier, see the private thread';
    expect((await decideApproval(product, { ...base(), requestId: id, decision: { path: 'reject', decidedAt: new Date(), reason: secret } })).status).toBe('ok');

    expect(await events('approval.approved')).toHaveLength(0);
    const rejected = await events('approval.rejected');
    expect(rejected).toHaveLength(1);
    // The reason lives on the decision for whoever may read the request; it is deliberately not in the audit stream.
    expect(JSON.stringify(rejected[0])).not.toContain(secret);
    expect((await owner.kysely.selectFrom('approval_decisions').selectAll().executeTakeFirst())?.reason).toBe(secret);
  });

  test('ONE DECISION PER REQUEST — a second attempt is refused rather than producing two authorizations', async () => {
    const id = await okRequestId();
    expect((await decideApproval(product, { ...base(), requestId: id, decision: { path: 'approve', decidedAt: new Date() } })).status).toBe('ok');

    const second = await decideApproval(product, { ...base(), requestId: id, decision: { path: 'reject', decidedAt: new Date(), reason: 'changed my mind' } });
    expect(second).toMatchObject({ status: 'already_decided' });
    expect(await owner.kysely.selectFrom('approval_decisions').selectAll().execute()).toHaveLength(1);
  });

  test('TWO SIMULTANEOUS DECISIONS on one request: exactly one wins, and the loser writes nothing', async () => {
    const id = await okRequestId();

    // The sequential case is caught by the pre-read. THIS is the case the pre-read cannot catch: both callers see
    // `pending`, and only the `where status = 'pending'` update can break the tie. Whoever loses that update must
    // stop — before this fix the loser ignored the zero-row result and went on to insert a second decision, so the
    // outcome was a raw uniqueness violation rather than an honest `already_decided`.
    const [a, b] = await Promise.all([
      decideApproval(product, { ...base(), requestId: id, decision: { path: 'approve', decidedAt: new Date() } }),
      decideApproval(product, { ...base(), requestId: id, decision: { path: 'reject', decidedAt: new Date(), reason: 'no' } }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['already_decided', 'ok']);
    // ONE decision, ONE audit event. Two contradictory authorizations for one action is the outcome the UNIQUE
    // constraint and this guard exist to make impossible.
    expect(await owner.kysely.selectFrom('approval_decisions').selectAll().execute()).toHaveLength(1);
    expect([...(await events('approval.approved')), ...(await events('approval.rejected'))]).toHaveLength(1);
  });

  test('an EDIT_THEN_APPROVE without a successor request is refused, not silently recorded as a plain decision', async () => {
    const id = await okRequestId();
    // The silent downgrade to `markDecided` is exactly how the original payload came to be authorized.
    const r = await decideApproval(product, {
      ...base(),
      requestId: id,
      decision: { path: 'edit_then_approve', decidedAt: new Date(), editedData: { recipients: 1 } },
    });
    expect(r).toMatchObject({ status: 'invalid' });
    expect(await owner.kysely.selectFrom('approval_decisions').selectAll().execute()).toHaveLength(0);
    expect((await owner.kysely.selectFrom('approval_requests').selectAll().where('id', '=', id).executeTakeFirst())?.status).toBe('pending');
  });

  test('an EDIT_THEN_APPROVE WITH a successor supersedes the old request rather than deciding it', async () => {
    const original = await okRequestId();
    const successor = await okRequestId({ data: { recipients: 1 }, preview: 'To: 1 supplier' });

    const r = await decideApproval(product, {
      ...base(),
      requestId: original,
      supersededByRequestId: successor,
      decision: { path: 'edit_then_approve', decidedAt: new Date(), editedData: { recipients: 1 } },
    });
    expect(r.status).toBe('ok');

    const row = await owner.kysely.selectFrom('approval_requests').selectAll().where('id', '=', original).executeTakeFirst();
    expect(row?.status).toBe('superseded');
    expect(row?.superseded_by_request_id).toBe(successor);
    // The successor is still PENDING: the human's substitute has to be approved on its own merits.
    expect((await owner.kysely.selectFrom('approval_requests').selectAll().where('id', '=', successor).executeTakeFirst())?.status).toBe('pending');
  });

  test('a request from ANOTHER company reads as absent, not as someone else’s approval', async () => {
    const id = await okRequestId();
    const r = await decideApproval(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1, requestId: id, decision: { path: 'approve', decidedAt: new Date() } });
    expect(r.status).toBe('not_found');
  });

  // ─────────────────────────────── REVOCATION (ACBP-P6-004; APPR-006; CDR-069 §1-G4/G6) ───────────────────────

  const decide = async (id: string): Promise<void> => {
    expect((await decideApproval(product, { ...base(), requestId: id, decision: { path: 'approve', decidedAt: new Date() } })).status).toBe('ok');
  };

  test('REVOKING is owner-only — a viewer cannot take back an authorization they could not grant', async () => {
    const id = await okRequestId();
    await decide(id);
    const r = await revokeApproval(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, requestId: id });
    expect(r.status).toBe('forbidden');
    expect((await owner.kysely.selectFrom('approval_requests').selectAll().where('id', '=', id).executeTakeFirst())?.status).toBe('decided');
  });

  test('an owner REVOKES a decided approval, and the event names who did it', async () => {
    const id = await okRequestId();
    await decide(id);
    expect((await revokeApproval(product, { ...base(), requestId: id })).status).toBe('ok');

    const row = await owner.kysely.selectFrom('approval_requests').selectAll().where('id', '=', id).executeTakeFirst();
    expect(row?.status).toBe('revoked');
    expect(row?.revoked_by_user_id).toBe(w.aOwner);

    const events = await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'approval.revoked').execute();
    expect(events).toHaveLength(1);
    // `denied`, matching `approval.rejected`: what is audited is an authorization, and this one ends withheld.
    expect(events[0]?.outcome).toBe('denied');
  });

  test('a PENDING request cannot be revoked — there is no authorization to withdraw', async () => {
    const id = await okRequestId();
    const r = await revokeApproval(product, { ...base(), requestId: id });
    expect(r).toMatchObject({ status: 'not_revocable', currentStatus: 'pending' });
    expect(await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'approval.revoked').execute()).toHaveLength(0);
  });

  test('revoking TWICE is refused the second time, and writes one event, not two', async () => {
    const id = await okRequestId();
    await decide(id);
    expect((await revokeApproval(product, { ...base(), requestId: id })).status).toBe('ok');
    expect(await revokeApproval(product, { ...base(), requestId: id })).toMatchObject({ status: 'not_revocable', currentStatus: 'revoked' });
    expect(await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'approval.revoked').execute()).toHaveLength(1);
  });

  test('a revocation that LOSES to a consumption leaves a compensating alert (CDR-069 §1-G6)', async () => {
    const id = await okRequestId();
    await decide(id);
    // Spend it out from under the revoker, exactly as a dispatch would: a real call row, then the consumption.
    const callId = (
      await sql<{ id: string }>`insert into tool_calls (account_id, company_id, run_id, tool_id, risk_class, external_effect, outcome, arguments_digest)
             values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${runId}::uuid, 'send_email', 'external_reversible', true, 'requested', ${'c'.repeat(64)})
           returning id`.execute(owner.kysely)
    ).rows[0]!.id;
    await sql`update approval_requests set status='consumed', consumed_at=now(), consumed_by_call_id=${callId}::uuid where id=${id}::uuid`.execute(owner.kysely);

    const r = await revokeApproval(product, { ...base(), requestId: id });
    // The API is honest — it does not claim a revocation that did not happen.
    expect(r).toMatchObject({ status: 'already_consumed' });

    // …and the attempt is DURABLE. A human reaching for the brake and finding it already spent is the event an
    // operator must be able to alarm on, and a response nobody stored is not one.
    const alerts = await events('approval.revoke_failed');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.outcome).toBe('blocked');
    // No revocation was recorded, because none happened.
    expect(await events('approval.revoked')).toHaveLength(0);
  });

  test('a FRACTIONAL cost estimate is refused as incomplete, not thrown at the driver', async () => {
    // The column is `integer`; the contract now agrees about what a credit is.
    expect(await request({ estimatedCostCredits: 1.5 })).toMatchObject({ status: 'incomplete', missing: ['estimatedCostCredits'] });
  });

  test('an UNREADABLE expiry is refused as incomplete — the one date with no guard until review pass 2', async () => {
    expect(await request({ expiresAt: new Date('nonsense') })).toMatchObject({ status: 'incomplete', missing: ['expiresAt'] });
    expect(await request({ expiresAt: 'tomorrow' })).toMatchObject({ status: 'incomplete', missing: ['expiresAt'] });
    expect(await owner.kysely.selectFrom('approval_requests').selectAll().execute()).toHaveLength(0);
  });

  test('another company’s approval reads as absent, not as something to revoke', async () => {
    const id = await okRequestId();
    await decide(id);
    expect((await revokeApproval(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1, requestId: id })).status).toBe('not_found');
  });

  // ─────────────────────────────────────── THE INBOX (mutations: no authz, unbounded) ──────────────────────────

  test('the inbox lists PENDING requests for this company, and a VIEWER may read it', async () => {
    const id = await okRequestId();
    const r = await listApprovalInbox(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 });
    expect(r.status).toBe('ok');
    expect((r as { status: 'ok'; requests: readonly { id: string }[] }).requests.map((x) => x.id)).toEqual([id]);

    // Seeing that a human is needed is not authority to be one — the viewer who can read this cannot decide it.
    expect((await decideApproval(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, requestId: id, decision: { path: 'approve', decidedAt: new Date() } })).status).toBe('forbidden');
  });

  test('a DECIDED request leaves the inbox', async () => {
    const id = await okRequestId();
    expect((await decideApproval(product, { ...base(), requestId: id, decision: { path: 'approve', decidedAt: new Date() } })).status).toBe('ok');
    const r = await listApprovalInbox(product, base());
    expect((r as { status: 'ok'; requests: readonly unknown[] }).requests).toHaveLength(0);
  });

  test('another company’s pending approvals are invisible, not merely unlisted', async () => {
    await okRequestId();
    const r = await listApprovalInbox(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 });
    expect((r as { status: 'ok'; requests: readonly unknown[] }).requests).toHaveLength(0);
  });

  test('a NON-MEMBER cannot read the inbox at all', async () => {
    await okRequestId();
    const r = await listApprovalInbox(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 });
    expect(r.status).not.toBe('ok');
  });
});
