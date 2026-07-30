// ACBP-P6-003b / CDR-068 §1 — approval requests and append-only decisions against a REAL database.
//
// THE CLAUSE THIS SUITE EXISTS FOR is canon's mechanism for invariant 5, verbatim: *"approval decisions are writable
// only through the approval API, which rejects non-human/non-delegated actor types AT THE SCHEMA LEVEL; worker/model
// actors have no code path to it."* P6-003a made a worker decider inexpressible in the TYPE. A type is not a schema,
// so the CHECK is asserted here, through the RESTRICTED `acbp_app` role — a guarantee tested as superuser is a
// guarantee about nobody.
//
// Everything else is the posture canon fixes for these two tables: a request whose CONTENT cannot be edited after a
// human read it (invariant 7), and a decision that cannot be edited at all.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { RISK_CLASSES, REVERSIBILITIES, APPROVAL_SCOPES, APPROVAL_DECISION_PATHS, APPROVAL_DECIDER_TYPES } from '@acbp/contracts';
import { createDatabase, closeDatabase, migrateToLatest, withTransaction, ApprovalRepository, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `appr_${'test'}_pw_1970`;

const ALL = [
  'approval_decisions',
  'approval_requests',
  'policy_evaluations',
  'policies',
  'artifact_revisions',
  'artifacts',
  'worker_runs',
  'company_worker_states',
  'worker_definitions',
  'tool_definitions',
  'job_checkpoints',
  'jobs',
  'planning_run_inputs',
  'planning_runs',
  'task_review_flags',
  'credit_transactions',
  'tool_calls',
  'task_runs',
  'task_deletions',
  'task_dependencies',
  'tasks',
  'milestones',
  'goals',
  'roadmaps',
  'decisions',
  'strategy_selections',
  'strategy_recommendations',
  'strategy_options',
  'strategy_generations',
  'usage_events',
  'understanding_confirmation_events',
  'understanding_item_reviews',
  'understanding_items',
  'understanding_documents',
  'memory_items',
  'interview_answers',
  'interview_questions',
  'interview_sessions',
  'platform_admins',
  'provisioning_steps',
  'company_workspace_areas',
  'activity_events',
  'company_memberships',
  'company_profiles',
  'companies',
  'audit_events',
  'memberships',
  'account_profiles',
  'accounts',
  'identity_webhook_receipts',
  'users',
] as const;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-appr-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-appr-test' }));
}

const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const INSUFFICIENT_PRIVILEGE = '42501';

describe.skipIf(!hasTestDatabase)('approval_requests + approval_decisions (real PostgreSQL, restricted role) — ACBP-P6-003b/CDR-068', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userA = '';
  let userB = '';
  let accountA = '';
  let accountB = '';
  let companyA = '';
  let companyB = '';
  let runA = '';
  let runB = '';
  let runA2 = '';
  let policyA = '';
  let policyB = '';
  let evalA = '';

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  /** Each refusal in its OWN transaction, and the SQLSTATE read by walking the cause chain — both paid-for lessons. */
  const sqlStateOf = (p: Promise<unknown>): Promise<string> =>
    p.then(() => 'no-error').catch((e: unknown) => {
      for (let cur: unknown = e, hops = 0; cur !== null && cur !== undefined && hops < 5; hops += 1) {
        const node = cur as { code?: unknown; cause?: unknown };
        if (typeof node.code === 'string' && /^[0-9A-Z]{5}$/.test(node.code)) return node.code;
        cur = node.cause;
      }
      return /sqlstate=([0-9A-Z]{5})/.exec(String(e))?.[1] ?? 'unknown';
    });

  beforeAll(async () => {
    su = superuserClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    expect((await migrateToLatest(su)).error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    const mkUser = async (tag: string) =>
      (await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_appr', ${tag}, now()) returning id`.execute(su.kysely))
        .rows[0]!.id;
    userA = await mkUser('user_appr_a');
    userB = await mkUser('user_appr_b');
    const mkAccount = async (u: string) => (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${u}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountA = await mkAccount(userA);
    accountB = await mkAccount(userB);
    const mkCompany = async (a: string) =>
      (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${a}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyA = await mkCompany(accountA);
    companyB = await mkCompany(accountB);
  }, 60_000);

  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (su) {
      try {
        await sql`alter role acbp_app nologin`.execute(su.kysely);
      } catch {
        /* best effort */
      }
      for (const t of ALL) await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(su);
    }
  });

  beforeEach(async () => {
    await sql`truncate table approval_decisions, approval_requests, policy_evaluations, policies, task_runs, tasks restart identity cascade`.execute(su.kysely);

    const mkRun = async (account: string, company: string, user: string) => {
      const task = (
        await sql<{ id: string }>`insert into tasks (account_id, company_id, title, created_by_user_id, state) values (${account}::uuid, ${company}::uuid, 'fixture task', ${user}::uuid, 'queued') returning id`.execute(
          su.kysely,
        )
      ).rows[0]!.id;
      return (
        await sql<{ id: string }>`insert into task_runs (account_id, company_id, task_id, attempt, state) values (${account}::uuid, ${company}::uuid, ${task}::uuid, 1, 'running') returning id`.execute(
          su.kysely,
        )
      ).rows[0]!.id;
    };
    runA = await mkRun(accountA, companyA, userA);
    runB = await mkRun(accountB, companyB, userB);
    // A SECOND run in the SAME company. `runB` is company B's, so RLS refuses it before any scoping logic is
    // reached — it cannot show whether the dispatcher's read is run-scoped at all. This one can.
    runA2 = await mkRun(accountA, companyA, userA);

    const mkPolicy = async (account: string, company: string, user: string) =>
      (
        await sql<{ id: string }>`insert into policies (account_id, company_id, version, baseline, rules, status, created_by_user_id)
             values (${account}::uuid, ${company}::uuid, 1, 'allow', '[]'::jsonb, 'active', ${user}::uuid) returning id`.execute(su.kysely)
      ).rows[0]!.id;
    policyA = await mkPolicy(accountA, companyA, userA);
    policyB = await mkPolicy(accountB, companyB, userB);

    evalA = (
      await sql<{ id: string }>`insert into policy_evaluations
             (account_id, company_id, policy_id, policy_version, evaluation_point, decision, escalate, evaluated_at)
           values (${accountA}::uuid, ${companyA}::uuid, ${policyA}::uuid, 1, 'approval_requested', 'require_approval', false, now()) returning id`.execute(su.kysely)
    ).rows[0]!.id;
  });

  /** Insert a request AS THE PRODUCT ROLE. `over` breaks exactly one thing per test. */
  const insertRequest = (over: Record<string, unknown> = {}, account = accountA, company = companyA) => {
    const v = {
      run_id: runA,
      tool_id: 'send_email',
      tool_version: 1,
      action: 'Send the introduction email',
      reason: 'Outreach is the next planned step',
      expected_result: 'Three emails delivered',
      data: '{"recipients":3}',
      estimated_cost_credits: 1,
      risk_class: 'external_reversible',
      reversibility: 'reversible',
      preview: 'To: 3 suppliers',
      scope: 'one_action',
      policy_id: policyA,
      policy_version: 1,
      policy_eval_id: evalA,
      ...over,
    };
    return asApp(scope(account, company), (k) =>
      sql<{ id: string }>`insert into approval_requests
          (account_id, company_id, run_id, tool_id, tool_version, action, reason, expected_result, data,
           estimated_cost_credits, risk_class, reversibility, preview, scope, policy_id, policy_version, policy_eval_id)
        values (${account}::uuid, ${company}::uuid, ${v.run_id}::uuid, ${v.tool_id}, ${v.tool_version}, ${v.action}, ${v.reason},
                ${v.expected_result}, ${v.data}::jsonb, ${v.estimated_cost_credits}, ${v.risk_class}, ${v.reversibility},
                ${v.preview}, ${v.scope}, ${v.policy_id}::uuid, ${v.policy_version}, ${v.policy_eval_id}::uuid)
        returning id`.execute(k),
    ).then((r) => r.rows[0]!.id);
  };

  /** Insert a decision AS THE PRODUCT ROLE. */
  const insertDecision = (requestId: string, over: Record<string, unknown> = {}, account = accountA, company = companyA) => {
    const v = {
      path: 'approve',
      decider_type: 'human',
      decided_by_user_id: userA,
      reason: null,
      edited_data: null,
      effective_from: null,
      member_request_ids: null,
      // `decided_at` IS OVERRIDABLE because it is caller-supplied in production too — that is exactly what the
      // ordering tests below need to be able to lie about.
      decided_at: null as string | null,
      ...over,
    };
    return asApp(scope(account, company), (k) =>
      sql`insert into approval_decisions
          (account_id, company_id, request_id, path, decider_type, decided_by_user_id, decided_at, reason, edited_data, effective_from, member_request_ids)
        values (${account}::uuid, ${company}::uuid, ${requestId}::uuid, ${v.path}, ${v.decider_type}, ${v.decided_by_user_id}::uuid,
                coalesce(${v.decided_at}::timestamptz, now()),
                ${v.reason}, ${v.edited_data}::jsonb, ${v.effective_from}::timestamptz, ${v.member_request_ids}::jsonb)`.execute(k),
    );
  };

  // ───────────────────────── INVARIANT 5, AT THE SCHEMA LEVEL — the clause this suite is for ─────────────────

  test('a WORKER cannot be recorded as having decided an approval — the database refuses it', async () => {
    const request = await insertRequest();
    // The contract makes this inexpressible; a caller bypassing the contract still cannot write it.
    expect(await sqlStateOf(insertDecision(request, { decider_type: 'worker' }))).toBe(CHECK_VIOLATION);
  });

  test('nor can `system`, `admin`, or anything else outside the two permitted types', async () => {
    const request = await insertRequest();
    for (const t of ['system', 'admin', 'user', 'HUMAN', '', 'model']) {
      expect(await sqlStateOf(insertDecision(request, { decider_type: t })), `decider_type=${t}`).toBe(CHECK_VIOLATION);
    }
  });

  test('both PERMITTED decider types are accepted, so the CHECK is not simply refusing everything', async () => {
    // Without this, the four assertions above would pass on a column that rejects every value — the shape of a guard
    // that looks strong and has broken the feature instead.
    for (const decider of APPROVAL_DECIDER_TYPES) {
      const request = await insertRequest();
      await expect(insertDecision(request, { decider_type: decider })).resolves.toBeDefined();
    }
  });

  // ───────────────────────────── the vocabularies cannot diverge from the contracts ──────────────────────────

  test('every CHECK vocabulary equals its @acbp/contracts set', async () => {
    // THE ACTIVITY_TYPES PRECEDENT: contracts were widened without a migration and the divergence was silent. A
    // duplicated list is only safe if something asserts the duplicate.
    const clause = async (name: string) =>
      (await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`.execute(su.kysely)).rows[0]?.def ?? '';

    // EQUALS, IN BOTH DIRECTIONS. This test claimed equality and checked containment, so it guarded
    // contracts-widened-without-migration but not the reverse: adding `'auto_approve'` to the decision-path CHECK
    // or `'unlimited'` to the scope CHECK left it green, and the column could then carry a value no contract can
    // produce or validate. Parsing the quoted literals out of the clause and comparing sorted sets closes it.
    const vocabularyOf = async (name: string): Promise<string[]> => [...new Set([...(await clause(name)).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1] as string))].sort();
    const sorted = (values: readonly string[]): string[] => [...values].sort();

    expect(await vocabularyOf('approval_requests_risk_valid')).toEqual(sorted(RISK_CLASSES));
    expect(await vocabularyOf('approval_requests_reversibility_valid')).toEqual(sorted(REVERSIBILITIES));
    expect(await vocabularyOf('approval_requests_scope_valid')).toEqual(sorted(APPROVAL_SCOPES));
    expect(await vocabularyOf('approval_decisions_path_valid')).toEqual(sorted(APPROVAL_DECISION_PATHS));
    expect(await vocabularyOf('approval_decisions_decider_is_human')).toEqual(sorted(APPROVAL_DECIDER_TYPES));

    // The two absences stated explicitly, because they are DECISIONS rather than consequences: `revoke` is
    // P6-004's, and `worker` is invariant 5. Both would now fail the equality above too, but a reader deleting a
    // contract value should meet the reason here rather than infer it from a diff.
    expect(APPROVAL_DECISION_PATHS).not.toContain('revoke');
    expect(APPROVAL_DECIDER_TYPES).not.toContain('worker');
  });

  // ───────────────────────────── APPR-002 content integrity ─────────────────────────────────────────────────

  test('BLANK content is refused — NOT NULL alone would let an empty action through', async () => {
    for (const field of ['action', 'reason', 'expected_result', 'preview', 'tool_id']) {
      expect(await sqlStateOf(insertRequest({ [field]: '   ' })), field).toBe(CHECK_VIOLATION);
    }
  });

  test('reversibility that DISAGREES with the risk class is refused', async () => {
    // The one combination a human must never be shown: an irreversible action presented as undoable.
    expect(await sqlStateOf(insertRequest({ risk_class: 'sensitive_irreversible', reversibility: 'reversible' }))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertRequest({ risk_class: 'informational', reversibility: 'irreversible' }))).toBe(CHECK_VIOLATION);
    // …and the agreeing pairs are accepted, for every class.
    for (const risk_class of RISK_CLASSES) {
      const reversibility = risk_class === 'sensitive_irreversible' ? 'irreversible' : 'reversible';
      await expect(insertRequest({ risk_class, reversibility })).resolves.toBeDefined();
    }
  });

  test('`data` must be a JSON OBJECT, and the cost cannot be negative', async () => {
    expect(await sqlStateOf(insertRequest({ data: '[]' }))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertRequest({ data: '"text"' }))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertRequest({ estimated_cost_credits: -1 }))).toBe(CHECK_VIOLATION);
  });

  test('all FOUR scopes are storable, so later autonomy levels are additive', async () => {
    // Canon §3 is explicit that the data model supports all four even though MVP ships two. The SERVICE refuses the
    // post-MVP pair (P6-003a); the TABLE must not, or widening later becomes a migration.
    for (const scopeValue of APPROVAL_SCOPES) {
      await expect(insertRequest({ scope: scopeValue })).resolves.toBeDefined();
    }
  });

  // ───────────────────────────── per-path requirements as DATABASE facts ────────────────────────────────────

  test('each path REQUIRES its own detail, and refuses details belonging to another path', async () => {
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>, Record<string, unknown>]> = [
      ['reject', { reason: 'out of date' }, {}],
      ['edit_then_approve', { edited_data: '{"recipients":2}' }, {}],
      ['schedule', { effective_from: '2026-08-01T09:00:00Z' }, {}],
      ['batch_approve', { member_request_ids: '["r1"]' }, {}],
    ];
    for (const [path, detail, missing] of cases) {
      const withDetail = await insertRequest();
      await expect(insertDecision(withDetail, { path, ...detail }), `${path} with its detail`).resolves.toBeDefined();
      const without = await insertRequest();
      expect(await sqlStateOf(insertDecision(without, { path, ...missing })), `${path} without its detail`).toBe(CHECK_VIOLATION);
    }
  });

  test('a detail on the WRONG path is refused — an approve carrying a rejection reason is unexplainable data', async () => {
    const r1 = await insertRequest();
    expect(await sqlStateOf(insertDecision(r1, { path: 'approve', reason: 'why?' }))).toBe(CHECK_VIOLATION);
    const r2 = await insertRequest();
    expect(await sqlStateOf(insertDecision(r2, { path: 'approve', effective_from: '2026-08-01T09:00:00Z' }))).toBe(CHECK_VIOLATION);
    const r3 = await insertRequest();
    expect(await sqlStateOf(insertDecision(r3, { path: 'reject', reason: 'ok', edited_data: '{}' }))).toBe(CHECK_VIOLATION);
  });

  test('a BATCH naming nobody authorizes nobody', async () => {
    const request = await insertRequest();
    expect(await sqlStateOf(insertDecision(request, { path: 'batch_approve', member_request_ids: '[]' }))).toBe(CHECK_VIOLATION);
  });

  test('ONE DECISION PER REQUEST — a retry or double-submit cannot produce two authorizations', async () => {
    const request = await insertRequest();
    await expect(insertDecision(request)).resolves.toBeDefined();
    expect(await sqlStateOf(insertDecision(request, { path: 'reject', reason: 'changed my mind' }))).toBe(UNIQUE_VIOLATION);
  });

  // ───────────────────────────── append-only, and content immutability ──────────────────────────────────────

  test('a decision can be neither UPDATED nor DELETED by the product role', async () => {
    const request = await insertRequest();
    await insertDecision(request);
    const id = (await su.kysely.selectFrom('approval_decisions').select('id').executeTakeFirstOrThrow()).id;
    expect(await sqlStateOf(asApp(scope(accountA, companyA), (k) => sql.raw(`update public.approval_decisions set path = 'reject' where id = '${id}'`).execute(k)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlStateOf(asApp(scope(accountA, companyA), (k) => sql.raw(`delete from public.approval_decisions where id = '${id}'`).execute(k)))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  test("a request's CONTENT cannot be edited after a human has read it — only its lifecycle columns", async () => {
    // Invariant 7 as a PRIVILEGE rather than a rule: an edit produces a new request, never a rewritten one.
    const id = await insertRequest();
    for (const column of ['action', 'reason', 'expected_result', 'preview', 'risk_class', 'estimated_cost_credits', 'scope', 'policy_version']) {
      const stmt = column === 'estimated_cost_credits' || column === 'policy_version' ? `set ${column} = 99` : `set ${column} = 'tampered'`;
      expect(await sqlStateOf(asApp(scope(accountA, companyA), (k) => sql.raw(`update public.approval_requests ${stmt} where id = '${id}'`).execute(k))), column).toBe(INSUFFICIENT_PRIVILEGE);
    }
    // The lifecycle transition IS permitted — otherwise the table would be unusable.
    await expect(
      asApp(scope(accountA, companyA), (k) => sql.raw(`update public.approval_requests set status = 'decided', decided_at = now() where id = '${id}'`).execute(k)),
    ).resolves.toBeDefined();
  });

  test('a request can never be DELETED by the product role — a decision cites it forever', async () => {
    const id = await insertRequest();
    expect(await sqlStateOf(asApp(scope(accountA, companyA), (k) => sql.raw(`delete from public.approval_requests where id = '${id}'`).execute(k)))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  test('the status and its timestamps cannot disagree', async () => {
    const id = await insertRequest();
    // `decided` with no decision time, and `pending` carrying one — both unreadable afterwards.
    expect(await sqlStateOf(asApp(scope(accountA, companyA), (k) => sql.raw(`update public.approval_requests set status = 'decided' where id = '${id}'`).execute(k)))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(asApp(scope(accountA, companyA), (k) => sql.raw(`update public.approval_requests set decided_at = now() where id = '${id}'`).execute(k)))).toBe(CHECK_VIOLATION);
  });

  // ───────────────────────────── tenancy: RLS, and the tenant-pinned FKs ────────────────────────────────────

  test('company B cannot see or insert company A’s approvals', async () => {
    const id = await insertRequest();
    await insertDecision(id);
    const seen = await asApp(scope(accountB, companyB), (k) => k.selectFrom('approval_requests').selectAll().execute());
    expect(seen).toHaveLength(0);
    const decisions = await asApp(scope(accountB, companyB), (k) => k.selectFrom('approval_decisions').selectAll().execute());
    expect(decisions).toHaveLength(0);
  });

  test('a request cannot cite ANOTHER company’s run, policy or evaluation (RI bypasses RLS)', async () => {
    // The reason every FK here is composite. Without the company column in the key, these three would all succeed.
    expect(await sqlStateOf(insertRequest({ run_id: runB }))).toBe(FK_VIOLATION);
    expect(await sqlStateOf(insertRequest({ policy_id: policyB }))).toBe(FK_VIOLATION);
    const evalB = (
      await sql<{ id: string }>`insert into policy_evaluations (account_id, company_id, policy_id, policy_version, evaluation_point, decision, escalate, evaluated_at)
           values (${accountB}::uuid, ${companyB}::uuid, ${policyB}::uuid, 1, 'approval_requested', 'allow', false, now()) returning id`.execute(su.kysely)
    ).rows[0]!.id;
    expect(await sqlStateOf(insertRequest({ policy_eval_id: evalB }))).toBe(FK_VIOLATION);
  });

  test('a decision cannot cite another company’s request', async () => {
    const requestB = await insertRequest({ run_id: runB, policy_id: policyB, policy_eval_id: null }, accountB, companyB);
    expect(await sqlStateOf(insertDecision(requestB, {}, accountA, companyA))).toBe(FK_VIOLATION);
  });

  test('a stated policy_version that is not the policy’s own is refused', async () => {
    // Version-pinned exactly as `policy_evaluations` is: point 2's recorded decision context is a fact, not a copy.
    expect(await sqlStateOf(insertRequest({ policy_version: 2 }))).toBe(FK_VIOLATION);
  });

  test('a request cannot supersede itself, nor a request in another company', async () => {
    const id = await insertRequest();
    expect(
      await sqlStateOf(
        asApp(scope(accountA, companyA), (k) =>
          sql.raw(`update public.approval_requests set status = 'superseded', superseded_at = now(), superseded_by_request_id = '${id}' where id = '${id}'`).execute(k),
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    const requestB = await insertRequest({ run_id: runB, policy_id: policyB, policy_eval_id: null }, accountB, companyB);
    expect(
      await sqlStateOf(
        asApp(scope(accountA, companyA), (k) =>
          sql.raw(`update public.approval_requests set status = 'superseded', superseded_at = now(), superseded_by_request_id = '${requestB}' where id = '${id}'`).execute(k),
        ),
      ),
    ).toBe(FK_VIOLATION);
  });

  // ───────────────────────────── what this migration deliberately does NOT add ──────────────────────────────

  // ───────── WHAT AN APPROVAL IS BOUND TO — the dispatcher's read (review pass 2, H4 + M1) ─────────
  //
  // Every one of these was a SURVIVING MUTATION: neutralising the tool filter, the run filter, or the ordering
  // left the whole 2953-test suite green. `findLatestDecisionForCall` is the single function standing between a
  // stored human decision and execution, and nothing pinned what it matches on.

  /** The dispatcher's own read, as the product role. */
  const latestFor = (runId: string, toolId: string, account = accountA, company = companyA) =>
    asApp(scope(account, company), (k) => new ApprovalRepository(k).findLatestDecisionForCall(company, runId, toolId));

  /**
   * Decide a request the way the SERVICE does — insert the decision AND move the request out of `pending`, which
   * `decideApproval` does in one transaction. `insertDecision` alone leaves a decided request still marked pending,
   * a state production cannot reach, and a test that relied on it would be testing a shape that never occurs.
   */
  const decide = async (requestId: string, over: Record<string, unknown> = {}): Promise<void> => {
    await insertDecision(requestId, over);
    await asApp(scope(accountA, companyA), (k) =>
      sql`update approval_requests set status = 'decided', decided_at = now() where id = ${requestId}::uuid`.execute(k),
    );
  };

  test('an approval for one TOOL does not authorize a DIFFERENT tool in the same run', async () => {
    await decide(await insertRequest({ tool_id: 'send_email' }));
    expect(await latestFor(runA, 'send_email')).toBeDefined();
    // The human approved sending an email. They did not approve deleting the database.
    expect(await latestFor(runA, 'purge_everything')).toBeUndefined();
  });

  test('an approval in one RUN does not authorize the same tool in ANOTHER run', async () => {
    await decide(await insertRequest({ run_id: runA, tool_id: 'send_email' }));
    expect(await latestFor(runA, 'send_email')).toBeDefined();
    // Same company, same tool, same human — a different piece of work. Approval does not travel between runs.
    expect(await latestFor(runA2, 'send_email')).toBeUndefined();
  });

  test('a decision on a SUPERSEDED request authorizes nothing', async () => {
    const request = await insertRequest({ tool_id: 'send_email' });
    await decide(request, { path: 'edit_then_approve', edited_data: '{"recipients":1}' });
    expect(await latestFor(runA, 'send_email')).toBeDefined();

    // The human refused this payload and offered a substitute, so the request is superseded. Reading its decision
    // anyway is how the ORIGINAL payload got authorized: the substitute request must be approved on its own merits.
    const successor = await insertRequest({ tool_id: 'send_email' });
    await asApp(scope(accountA, companyA), (k) =>
      sql`update approval_requests set status = 'superseded', superseded_at = now(), superseded_by_request_id = ${successor}::uuid
          where id = ${request}::uuid`.execute(k),
    );
    expect(await latestFor(runA, 'send_email')).toBeUndefined();
  });

  test('the LATEST decision is the one recorded last, not the one claiming the furthest-future timestamp', async () => {
    // `decided_at` is supplied by the caller and validated only as a finite date. An approval stamped in 2030 —
    // a skewed client clock, a timezone bug, or a deliberate choice — must not outrank a later real rejection
    // forever. The ordering key has to be one the server assigns.
    const first = await insertRequest({ tool_id: 'send_email' });
    await decide(first, { path: 'approve', decided_at: '2030-01-01T00:00:00Z' });

    const second = await insertRequest({ tool_id: 'send_email' });
    await decide(second, { path: 'reject', reason: 'on reflection, no' });

    expect((await latestFor(runA, 'send_email'))?.path).toBe('reject');
  });

  test('the lifecycle transition is GUARDED — a second attempt moves zero rows rather than re-stamping', async () => {
    // The primitive the service's race guard depends on. `markDecided` is `where status = 'pending'`, so it is the
    // tie-breaker when two callers both saw a pending request: exactly one gets 1, the other gets 0 and must stop.
    // Pinned here because the service-level race cannot be forced deterministically through its own API.
    const request = await insertRequest({ tool_id: 'send_email' });
    const repo = (k: Parameters<Parameters<typeof asApp>[1]>[0]) => new ApprovalRepository(k);

    expect(await asApp(scope(accountA, companyA), (k) => repo(k).markDecided(request, new Date()))).toBe(1);
    expect(await asApp(scope(accountA, companyA), (k) => repo(k).markDecided(request, new Date()))).toBe(0);

    // …and a superseding transition on an already-decided request is refused the same way, so the two lifecycle
    // moves cannot race each other into a request that is both decided and superseded.
    const successor = await insertRequest({ tool_id: 'send_email' });
    expect(await asApp(scope(accountA, companyA), (k) => repo(k).markSuperseded(request, successor, new Date()))).toBe(0);
  });

  test('there is NO payload-hash and NO expiry column — that is ADR-009 §2 and P6-004', async () => {
    // Asserting an absence on purpose. A hash column added here would invite the belief that an approval is bound to
    // the exact bytes, which is the distinction CDR-068 §0.1 exists to keep sharp: closing the dispatcher's approval
    // port makes the gate read a real DECISION, not a hash-bound token.
    const columns = (
      await sql<{ column_name: string }>`select column_name from information_schema.columns where table_name in ('approval_requests', 'approval_decisions')`.execute(su.kysely)
    ).rows.map((r) => r.column_name);
    for (const forbidden of ['payload_hash', 'content_hash', 'expires_at', 'expiry_ms', 'revoked_at', 'consumed_at']) {
      expect(columns, `${forbidden} belongs to P6-004`).not.toContain(forbidden);
    }
  });
});
