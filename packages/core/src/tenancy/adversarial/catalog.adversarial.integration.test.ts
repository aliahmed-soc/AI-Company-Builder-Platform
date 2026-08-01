// ACBP-P1-014 / CDR-020 §7 — the CONSOLIDATED catalog and role suite for tenant isolation.
//
// This is the single canonical place that pins the platform-wide isolation preconditions: the restricted
// role's attributes and ownership, the closed SECURITY DEFINER allowlist, FORCE RLS on every tenant table,
// policy shape (no unexpectedly broadening permissive policy; USING/WITH CHECK symmetry where required),
// exact mutation and column-level grants, append-only guarantees, and the absence of an owner runtime
// connection. Per-ticket suites keep only their own domain-specific assertions.
//
// Every assertion that is ABOUT the restricted role runs ON the restricted role; catalog inspection uses the
// owner/fixture client (reading pg_catalog is not an isolation claim). Threat ids come from the shared
// inventory. Runs as `acbp_app` under FORCE RLS; skips locally without ACBP_TEST_DATABASE_URL; never mocked.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, teardown, assertRestrictedRole, asRestricted, type RestrictedRoleProof } from '@acbp/test-support';
import { threatTitle } from '@acbp/test-support';

/** Every tenant-scoped table that must carry ENABLE + FORCE RLS. */
const TENANT_TABLES = ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'accounts', 'account_profiles', 'memberships', 'audit_events', 'companies', 'company_profiles', 'company_memberships', 'activity_events', 'provisioning_steps', 'company_workspace_areas', 'platform_admins', 'interview_sessions', 'interview_questions', 'interview_answers', 'memory_items', 'usage_events', 'understanding_documents', 'understanding_items', 'understanding_item_reviews', 'understanding_confirmation_events', 'tasks', 'task_dependencies', 'strategy_generations', 'strategy_options', 'strategy_recommendations', 'strategy_selections', 'decisions', 'roadmaps', 'goals', 'milestones', 'task_review_flags', 'planning_runs', 'planning_run_inputs', 'task_deletions', 'jobs', 'job_checkpoints', 'task_runs', 'tool_calls', 'company_worker_states', 'worker_runs', 'artifacts', 'policy_evaluations', 'policies', 'artifact_revisions', 'credit_transactions'] as const;

/** The closed SECURITY DEFINER allowlist (CDR-013 #4/#5) — exact names, namespace-wide. */
const EXPECTED_DEFINERS = ['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership'] as const;

/**
 * Exact TABLE-LEVEL grants held by acbp_app, transcribed from the migrations (0005/0007–0011). Column-level
 * grants do NOT appear in `role_table_grants` — `provisioning_steps` therefore shows only INSERT/SELECT here
 * and its outcome-column UPDATE is asserted separately against `column_privileges`.
 *
 * Notable least-privilege facts this pins: `account_profiles` has NO INSERT (profiles are created by the
 * SECURITY DEFINER bootstrap), `company_profiles`/`company_memberships` have NO UPDATE (versioned/append-only
 * by design), and `platform_admins` is SELECT-only (no runtime write path — CDR-019).
 */
const EXPECTED_GRANTS: Readonly<Record<string, readonly string[]>> = {
  accounts: ['SELECT', 'UPDATE'],
  account_profiles: ['SELECT', 'UPDATE'],
  memberships: ['INSERT', 'SELECT', 'UPDATE'],
  audit_events: ['INSERT', 'SELECT'],
  companies: ['INSERT', 'SELECT', 'UPDATE'],
  company_profiles: ['INSERT', 'SELECT'],
  company_memberships: ['INSERT', 'SELECT'],
  activity_events: ['INSERT', 'SELECT'],
  provisioning_steps: ['INSERT', 'SELECT'],
  company_workspace_areas: ['INSERT', 'SELECT'],
  platform_admins: ['SELECT'],
  // Interview sessions (ACBP-P2-001; CDR-022): INSERT/SELECT at the table level; the state/started_at/updated_at
  // UPDATE is COLUMN-LEVEL (identity columns immutable), so it shows in column_privileges, not here.
  interview_sessions: ['INSERT', 'SELECT'],
  // Interview Q&A (ACBP-P2-002; CDR-023): both append-only/immutable — SELECT+INSERT only, no UPDATE/DELETE.
  interview_questions: ['INSERT', 'SELECT'],
  interview_answers: ['INSERT', 'SELECT'],
  // Typed memory (ACBP-P2-006; CDR-024): append-only for P2-006 — SELECT+INSERT only (supersede is P2-010).
  memory_items: ['INSERT', 'SELECT'],
  // Model-gateway usage ledger (ACBP-P2-003; CDR-026): APPEND-ONLY — SELECT+INSERT only, no UPDATE/DELETE ever.
  usage_events: ['INSERT', 'SELECT'],
  // Understanding generation (ACBP-P2-008; CDR-029): versioned APPEND-ONLY — SELECT+INSERT only (review is P2-009).
  understanding_documents: ['INSERT', 'SELECT'],
  understanding_items: ['INSERT', 'SELECT'],
  // Understanding review + confirmation (ACBP-P2-009; CDR-030): append-only event logs — INSERT/SELECT only.
  understanding_item_reviews: ['INSERT', 'SELECT'],
  understanding_confirmation_events: ['INSERT', 'SELECT'],
  // Task model (ACBP-P4-002; CDR-033): tasks = SELECT/INSERT + column-level UPDATE (state); deps = append-only.
  tasks: ['INSERT', 'SELECT'],
  task_dependencies: ['INSERT', 'SELECT'],
  // Strategy option generation (ACBP-P3-001; CDR-034): both immutable/append-only — SELECT+INSERT only, no UPDATE/DELETE.
  strategy_generations: ['INSERT', 'SELECT'],
  strategy_options: ['INSERT', 'SELECT'],
  // Strategy recommendation (ACBP-P3-003; CDR-036): immutable/append-only — SELECT+INSERT only.
  strategy_recommendations: ['INSERT', 'SELECT'],
  // Owner strategy selection (ACBP-P3-004; CDR-037): immutable/append-only — SELECT+INSERT only, no UPDATE/DELETE.
  strategy_selections: ['INSERT', 'SELECT'],
  // Immutable decision record (ACBP-P3-005; CDR-038; STRAT-006 "mutation attempts fail"): SELECT+INSERT only.
  decisions: ['INSERT', 'SELECT'],
  // Planning (ACBP-P4-001; CDR-039; ROAD-001/002): roadmaps are VERSIONED append-only (a new version is a new row,
  // never an in-place edit) and goals/milestones/flags are immutable — all SELECT+INSERT only.
  roadmaps: ['INSERT', 'SELECT'],
  goals: ['INSERT', 'SELECT'],
  milestones: ['INSERT', 'SELECT'],
  task_review_flags: ['INSERT', 'SELECT'],
  // Planning transparency (ACBP-P4-006; CDR-041; PLAN-004): a run is a historical record of what planning considered,
  // so rewriting it would defeat the requirement — SELECT+INSERT only, like every other immutable planning table.
  planning_runs: ['INSERT', 'SELECT'],
  planning_run_inputs: ['INSERT', 'SELECT'],
  // Task deletion (ACBP-P4-005; CDR-043; TASK-008): deletion is a RECORDED FACT, not an erasure. `tasks` deliberately
  // still has NO DELETE grant and its UPDATE stays pinned to (state, updated_at) — asserted separately — so the record
  // of what an owner discarded cannot itself be edited or removed. SELECT+INSERT only.
  task_deletions: ['INSERT', 'SELECT'],
  // Durable jobs (ACBP-P5-001a; CDR-049 §4): INSERT/SELECT at the TABLE level. The lifecycle UPDATE is COLUMN-level
  // (`state`/`updated_at`/`attempts`), and column grants do not appear in `role_table_grants` — the same reason
  // `provisioning_steps` and `interview_sessions` show no UPDATE here; it is asserted against `column_privileges`
  // below. NO DELETE (§4-G5): job history is the run trail, so a failed job cannot be erased by the code that failed.
  jobs: ['INSERT', 'SELECT'],
  // Job checkpoints (ACBP-P5-001b; CDR-050 §4): APPEND-ONLY. A completed step is a fact about the past, so there is no
  // legitimate UPDATE — and a DELETE would let the code that failed erase the evidence that the step had already run,
  // which is exactly the double-execution this sub-scope exists to prevent. SELECT+INSERT only, and no column-level
  // UPDATE either (asserted below).
  job_checkpoints: ['INSERT', 'SELECT'],
  // Task runs (ACBP-P5-002; CDR-053): SELECT + INSERT at the table level; the lifecycle UPDATE is COLUMN-level and
  // is asserted below. NO DELETE - a run is the record that an attempt happened.
  task_runs: ['INSERT', 'SELECT'],
  // Tool calls (ACBP-P5-003b; CDR-054): SELECT + INSERT at the table level; the outcome UPDATE is COLUMN-level.
  // NO DELETE - a call record is the evidence the call happened, including the refused ones.
  tool_calls: ['INSERT', 'SELECT'],
  // Per-company worker state (ACBP-P5-004; CDR-056; WORK-006): SELECT + INSERT at the table level; the state UPDATE
  // is COLUMN-level. Tenancy and worker_id stay immutable, so a pause cannot be re-pointed after the fact.
  company_worker_states: ['INSERT', 'SELECT'],
  worker_runs: ['INSERT', 'SELECT'],
  // The credit ledger (ACBP-P5-014; CDR-058; invariant 10): SELECT + INSERT and NOTHING else - no table UPDATE, no
  // COLUMN update (asserted below), no DELETE. Append-only is a property of these grants rather than of anyone's
  // restraint, which is what makes "corrections use compensating entries" true instead of merely intended.
  credit_transactions: ['INSERT', 'SELECT'],
  // Artifacts (ACBP-P5-011; CDR-060; TASK-005): SELECT + INSERT and NOTHING ELSE — not even a column-level UPDATE.
  // An artifact row IS the provenance record for a produced document; editing it would let a later write rewrite
  // which run, worker or model made something, which is the one thing P5-012's revision lineage must be able to
  // trust. A superseded artifact is a NEW row, never an edit of the old one.
  artifacts: ['INSERT', 'SELECT'],
  // Artifact revisions (ACBP-P5-012; CDR-064): SELECT + INSERT and nothing else. A revision request records that
  // the owner asked for something at a moment in time; editing it would rewrite the reason a run exists, which is
  // exactly what the lineage has to carry honestly. No UPDATE, no DELETE.
  artifact_revisions: ['INSERT', 'SELECT'],
  // Policy engine (ACBP-P6-001b; CDR-066 §5-G11/G12). `policies` shows only INSERT/SELECT here because its ONE
  // legal mutation — the `active→superseded` transition — is a COLUMN-level UPDATE(status, superseded_at), and
  // column grants never appear in `role_table_grants`; it is asserted against `column_privileges` below.
  // `policy_evaluations` has no UPDATE at all, at any level: POL-006 makes these rows the evidence of what the
  // platform allowed, and evidence that can be edited afterwards is not evidence.
  policies: ['INSERT', 'SELECT'],
  policy_evaluations: ['INSERT', 'SELECT'],
  // `approval_requests` carries a COLUMN-scoped UPDATE for its lifecycle only (status, decided_at, superseded_at,
  // superseded_by_request_id), so — like `tool_calls` and `task_runs` — no UPDATE appears here; it is asserted against
  // `column_privileges` below. The CONTENT columns are deliberately outside that grant: a request whose action or
  // preview could be edited after a human read it is the material-change hole invariant 7 exists to close.
  approval_requests: ['INSERT', 'SELECT'],
  // `approval_decisions` has no UPDATE at all, at any level. It is the record of a human exercising authority, and
  // canon §2 says an edited approval is superseded, never mutated.
  approval_decisions: ['INSERT', 'SELECT'],
  // Emergency stop (ACBP-P6-007; CDR-072 §1-G6/G7). Both show only INSERT/SELECT here because their single legal
  // mutation is COLUMN-level and column grants never appear in `role_table_grants` — asserted below. What matters
  // is what is NOT in that column list: `scope`/`target_id` on a stop cannot be updated, so the record of WHAT was
  // halted cannot be re-pointed after activation; and neither table has DELETE, so "nothing is lost" means a
  // discarded held item is a REVIEWED row an operator can still see, not a vanished one.
  emergency_stops: ['INSERT', 'SELECT'],
  held_work: ['INSERT', 'SELECT'],
};

describe.skipIf(!hasTestDatabase)('tenant-isolation catalog + role preconditions (real PostgreSQL) — ACBP-P1-014/CDR-020', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let proof: RestrictedRoleProof;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    // FAIL-FAST: everything below is meaningless unless the product client is genuinely restricted.
    proof = await assertRestrictedRole(product);
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });

  test('HARNESS GUARD — product assertions run as acbp_app: not superuser, not BYPASSRLS, owns no product table', () => {
    expect(proof.currentUser).toBe('acbp_app');
    expect(proof.isSuperuser).toBe(false);
    expect(proof.bypassesRls).toBe(false);
    expect(proof.ownedProductTables).toEqual([]);
  });

  test('the restricted role is not the migration/owner role and holds no role memberships', async () => {
    const attrs = await sql<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolinherit: boolean }>`
      select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit from pg_roles where rolname = 'acbp_app'
    `.execute(owner.kysely);
    expect(attrs.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    const memberships = await sql<{ n: number }>`select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'acbp_app'`.execute(owner.kysely);
    expect(memberships.rows[0]?.n).toBe(0);
    // The owner/migration role that ran the migrations is a DIFFERENT role from the runtime role.
    const owners = await sql<{ tableowner: string }>`select distinct tableowner from pg_tables where schemaname = 'public'`.execute(owner.kysely);
    expect(owners.rows.every((o) => o.tableowner !== 'acbp_app')).toBe(true);
  });

  test('exactly three SECURITY DEFINER functions exist namespace-wide, with the exact expected names', async () => {
    const definers = await sql<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>`
      select proname, prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace and prosecdef = true order by proname
    `.execute(owner.kysely);
    expect(definers.rows.map((d) => d.proname)).toEqual([...EXPECTED_DEFINERS]);
    // Each pins a fixed search_path (SECURITY DEFINER trojan-horse guard).
    for (const d of definers.rows) expect((d.proconfig ?? []).some((c) => c.startsWith('search_path='))).toBe(true);
    // No PUBLIC execute on any of them.
    const publicExec = await sql<{ n: number }>`
      select count(*)::int as n from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prosecdef = true
        and has_function_privilege('public', p.oid, 'execute')
    `.execute(owner.kysely);
    expect(publicExec.rows[0]?.n).toBe(0);
  });

  test.each(TENANT_TABLES)('%s has ENABLE + FORCE row-level security', async (table) => {
    const r = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      select relrowsecurity, relforcerowsecurity from pg_class where relname = ${table} and relkind = 'r'
    `.execute(owner.kysely);
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  test.each(TENANT_TABLES)('%s grants to acbp_app are exactly the expected least-privilege set (and nothing to any other role)', async (table) => {
    const grants = await sql<{ privilege_type: string }>`
      select distinct privilege_type from information_schema.role_table_grants
      where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${table} order by privilege_type
    `.execute(owner.kysely);
    expect(grants.rows.map((g) => g.privilege_type)).toEqual([...(EXPECTED_GRANTS[table] ?? [])].sort());
    const others = await sql<{ grantee: string }>`
      select distinct grantee from information_schema.role_table_grants
      where table_schema = 'public' and table_name = ${table}
        and grantee <> 'acbp_app'
        and grantee <> (select tableowner from pg_tables where schemaname = 'public' and tablename = ${table})
    `.execute(owner.kysely);
    expect(others.rows.map((o) => o.grantee)).toEqual([]);
    // No grant option anywhere (acbp_app can never re-grant its access).
    const grantable = await sql<{ n: number }>`
      select count(*)::int as n from information_schema.role_table_grants
      where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${table} and is_grantable = 'YES'
    `.execute(owner.kysely);
    expect(grantable.rows[0]?.n).toBe(0);
  });

  test('column-level UPDATE grants are confined to outcome columns (identity/scope columns are not updatable)', async () => {
    const cols = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.column_privileges
      where grantee = 'acbp_app' and table_schema = 'public' and privilege_type = 'UPDATE'
      order by table_name, column_name
    `.execute(owner.kysely);
    const byTable = new Map<string, string[]>();
    for (const c of cols.rows) byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);

    /**
     * Assert the exact updatable set AND that each supposedly-immutable column REALLY EXISTS.
     *
     * The second half is the point. A `not.toContain('work_id')` against a table whose column is actually `task_id`
     * passes — while asserting nothing at all. This suite's older forbidden-lists are hand-written names checked
     * only by eye; a typo in one of them is silently a missing assertion rather than a failure. Resolving the names
     * against `information_schema.columns` turns that class of mistake into a red test. (Written after a typo of
     * exactly that shape went in below — caught by reading the migration, not by the suite.)
     */
    const expectUpdatableColumnsExactly = async (table: string, updatable: readonly string[], immutable: readonly string[]): Promise<void> => {
      const real = await sql<{ column_name: string }>`
        select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}
      `.execute(owner.kysely);
      const realNames = real.rows.map((r) => r.column_name);
      expect(realNames.length, `${table} must exist for this assertion to mean anything`).toBeGreaterThan(0);
      for (const name of [...updatable, ...immutable]) {
        expect(realNames, `${table}.${name} is named in this assertion but is not a real column — the assertion is vacuous`).toContain(name);
      }
      const granted = byTable.get(table) ?? [];
      expect([...granted].sort()).toEqual([...updatable].sort());
      for (const name of immutable) {
        expect(granted, `${table}.${name} must not be UPDATE-grantable to the product role`).not.toContain(name);
      }
    };

    const provisioning = byTable.get('provisioning_steps') ?? [];
    expect(provisioning.length).toBeGreaterThan(0);
    for (const forbidden of ['id', 'account_id', 'company_id', 'step', 'step_order']) {
      expect(provisioning).not.toContain(forbidden);
    }
    // Policies (ACBP-P6-001b; CDR-066 §5-G11): ONLY the two columns that carry `active→superseded`. Everything
    // else about a version is immutable because an evaluation cites that version forever — if `rules`, `baseline`
    // or `version` could be edited, an audit trail could be rewritten after the fact by changing what it points at.
    const policies = byTable.get('policies') ?? [];
    expect([...policies].sort()).toEqual(['status', 'superseded_at']);
    // And the evaluation records take NO update grant at all, not even column-level.
    expect(byTable.get('policy_evaluations')).toBeUndefined();
    // Approval requests (ACBP-P6-003b/P6-004b; CDR-068 §1, CDR-069): ONLY the LIFECYCLE columns. The CONTENT
    // columns are the point — `action`, `reason`, `preview`, `risk_class`, `estimated_cost_credits` and the rest
    // must be immutable, because a request whose content could change after a human read it is exactly the
    // material-change hole invariant 7 closes. An edit produces a NEW request via `edit_then_approve`.
    //
    // P6-004 ADDED FOUR AND WITHHELD THREE, and the withheld ones matter more than the added ones:
    // `payload_hash`, `binding_version` and `expires_at` are absent from this list DELIBERATELY. An approval whose
    // hash could be re-pointed at a different payload, or whose expiry could be pushed out, after a human read it
    // would defeat the entire binding ticket from inside the product role. They are content, not lifecycle.
    const approvalRequests = byTable.get('approval_requests') ?? [];
    expect([...approvalRequests].sort()).toEqual([
      'consumed_at',
      'consumed_by_call_id',
      'decided_at',
      'revoked_at',
      'revoked_by_user_id',
      'status',
      'superseded_at',
      'superseded_by_request_id',
    ]);
    for (const bound of ['payload_hash', 'binding_version', 'expires_at']) {
      expect(approvalRequests, `${bound} is BOUND CONTENT — granting UPDATE on it would defeat ACBP-P6-004`).not.toContain(bound);
    }
    // And a DECISION takes no update grant at all, not even column-level: it is the record of a human exercising
    // authority, and canon §2 says an edited approval is superseded, never mutated.
    expect(byTable.get('approval_decisions')).toBeUndefined();
    // Emergency stop (ACBP-P6-007; CDR-072 §1-G6/G7). CLEARING (and on held work, REVIEW) is the one legal
    // mutation, and the WITHHELD columns are the substance: a stop whose `scope`/`target_id` could be re-pointed
    // after activation would let the record of WHAT was halted be rewritten by the same product role the stop
    // exists to restrain — and §0's failure is exactly an operator believing a stop reached somewhere it did not.
    // Held work's `stop_id` is immutable for the mirror reason: what a stop caught cannot be re-attributed later.
    await expectUpdatableColumnsExactly('emergency_stops', ['cleared_at', 'cleared_by_user_id', 'status'], [
      'scope',
      'target_id',
      'account_id',
      'company_id',
      'activated_at',
      'activated_by_user_id',
      'reason',
    ]);
    await expectUpdatableColumnsExactly('held_work', ['reviewed_at', 'reviewed_by_user_id', 'status'], [
      'id',
      'account_id',
      'company_id',
      'stop_id',
      'task_id',
      'held_at',
    ]);
    // Interview sessions (ACBP-P2-001): only state/started_at/updated_at are updatable; identity columns are not.
    const interview = byTable.get('interview_sessions') ?? [];
    expect(interview.length).toBeGreaterThan(0);
    expect([...interview].sort()).toEqual(['started_at', 'state', 'updated_at']);
    for (const forbidden of ['id', 'account_id', 'company_id', 'created_at']) {
      expect(interview).not.toContain(forbidden);
    }
    // Memory items (ACBP-P2-010): column-level UPDATE is confined to EXACTLY the lifecycle-pointer columns —
    // `superseded_by` (0015 edit=supersede) + `deleted_at`/`deleted_by_user_id` (0016 soft delete). The
    // content/type/source/confidence/confirmation/identity/creation columns stay immutable (no destructive
    // overwrite, no hard delete).
    const memory = byTable.get('memory_items') ?? [];
    expect([...memory].sort()).toEqual(['deleted_at', 'deleted_by_user_id', 'superseded_by']);
    for (const forbidden of ['id', 'account_id', 'company_id', 'content', 'type', 'source_type', 'source_ref', 'confidence', 'confirmation_state', 'created_at', 'created_by_user_id']) {
      expect(memory).not.toContain(forbidden);
    }
    // Tasks (ACBP-P4-002; CDR-033): the server-enforced state machine mutates ONLY `state` (+ its `updated_at`
    // stamp); title/description/milestone/identity/provenance columns are immutable to the app role.
    const tasks = byTable.get('tasks') ?? [];
    expect([...tasks].sort()).toEqual(['state', 'updated_at']);
    // ACBP-P4-003 added `task_type` and `priority` — both INSERT-ONLY. They must NOT appear here: widening the column
    // grant to make J-10's "adjust priorities" reachable is deliberately out of scope (CDR-040 §8-G9).
    // ACBP-P4-005 added `repeated_from_task_id` (TASK-008 lineage) — also INSERT-ONLY, and `rationale` (P4-006). The
    // whole point of CDR-043 §3 was NOT widening this grant to implement deletion: the ticket uses an append-only
    // `task_deletions` table precisely so this assertion stays `['state', 'updated_at']`.
    for (const forbidden of ['id', 'account_id', 'company_id', 'title', 'description', 'milestone_id', 'task_type', 'priority', 'rationale', 'repeated_from_task_id', 'created_at', 'created_by_user_id']) {
      expect(tasks).not.toContain(forbidden);
    }
    // task_dependencies is append-only — no column-level UPDATE grants at all.
    expect(byTable.get('task_dependencies') ?? []).toEqual([]);
    // Strategy generations + options (ACBP-P3-001) + recommendations (ACBP-P3-003) + selections (ACBP-P3-004) are
    // immutable/append-only — no column-level UPDATE grants at all.
    expect(byTable.get('strategy_generations') ?? []).toEqual([]);
    expect(byTable.get('strategy_options') ?? []).toEqual([]);
    expect(byTable.get('strategy_recommendations') ?? []).toEqual([]);
    expect(byTable.get('strategy_selections') ?? []).toEqual([]);
    // Decision records (ACBP-P3-005) are audit-grade immutable — no column-level UPDATE grant at all.
    expect(byTable.get('decisions') ?? []).toEqual([]);
    // Planning (ACBP-P4-001): roadmaps are versioned append-only and goals/milestones/flags immutable — a roadmap is
    // revised by writing a NEW version, never by updating a column, so none of them carry a column UPDATE grant.
    for (const t of ['roadmaps', 'goals', 'milestones', 'task_review_flags', 'planning_runs', 'planning_run_inputs']) {
      expect(byTable.get(t) ?? []).toEqual([]);
    }
    // Task deletions (ACBP-P4-005): the record of what an owner discarded is immutable — no column UPDATE grant, so
    // `state_at_delete`/`reason` cannot be rewritten after the fact.
    expect(byTable.get('task_deletions') ?? []).toEqual([]);
    // Durable jobs (ACBP-P5-001a; CDR-049 §4-G3): the runner may advance lifecycle state and count attempts, and
    // NOTHING else. `account_id`/`company_id` being absent here is the structural half of "context is stamped at
    // enqueue and never moves" — a job cannot be re-pointed at another tenant after the fact, even by code holding
    // a valid session for that tenant. `kind`/`payload` are likewise immutable, so the work cannot be swapped
    // between enqueue and execution.
    // Job checkpoints (ACBP-P5-001b) are append-only — no column UPDATE grant at all, so a recorded completion cannot
    // be rewritten to say a step did not run.
    expect(byTable.get('job_checkpoints') ?? []).toEqual([]);
    // Task runs (ACBP-P5-002): the lifecycle columns only. Identity, tenancy, task linkage and the attempt number
    // stay immutable, so a run cannot be re-pointed at another task or renumbered after the fact.
    const runs = byTable.get('task_runs') ?? [];
    expect([...runs].sort()).toEqual(['ended_at', 'failure_category', 'last_heartbeat_at', 'started_at', 'state', 'stop_requested_at', 'updated_at']);
    for (const forbidden of ['id', 'account_id', 'company_id', 'task_id', 'attempt', 'created_at']) {
      expect(runs).not.toContain(forbidden);
    }
    // Tool calls (ACBP-P5-003b): the outcome columns only. The arguments DIGEST, the risk class the gate applied, the
    // external-effect flag and the run linkage are all immutable — a call cannot be re-labelled with a gentler class,
    // have its arguments swapped after the gate passed it, or be re-pointed at a different run.
    const calls = byTable.get('tool_calls') ?? [];
    expect([...calls].sort()).toEqual(['denial_reason', 'outcome', 'receipt_ref', 'updated_at']);
    for (const forbidden of ['id', 'account_id', 'company_id', 'run_id', 'tool_id', 'risk_class', 'external_effect', 'arguments_digest', 'idempotency_key', 'created_at']) {
      expect(calls).not.toContain(forbidden);
    }
    // Per-company worker state (ACBP-P5-004): only the mutable state columns. worker_id is NOT updatable - a pause
    // recorded against one worker cannot later be made to mean a different one.
    const workerStates = byTable.get('company_worker_states') ?? [];
    expect([...workerStates].sort()).toEqual(['changed_by_user_id', 'reason', 'state', 'updated_at']);
    for (const forbidden of ['id', 'account_id', 'company_id', 'worker_id', 'created_at']) {
      expect(workerStates).not.toContain(forbidden);
    }
    // Worker runs (ACBP-P5-005): the counters and the lifecycle only. The STAMP - tenancy, the task run, the worker
    // id and version - and the SNAPSHOT bounds are all immutable, so a run can never be re-attributed to a different
    // worker nor re-judged against a budget it was not given. Review pass 2 caught that this table was missing from
    // the catalog entirely: the local test listed forbidden columns but never the EXACT allowed set, so widening the
    // grant to `account_id` or max_duration_ms would have passed in silence.
    const workerRuns = byTable.get('worker_runs') ?? [];
    expect([...workerRuns].sort()).toEqual(['ended_at', 'failure_category', 'halt_reason', 'outcome', 'spend_micros', 'steps_completed', 'updated_at']);
    for (const forbidden of ['id', 'account_id', 'company_id', 'task_run_id', 'worker_id', 'worker_version', 'max_spend_micros', 'max_duration_ms', 'started_at', 'created_at']) {
      expect(workerRuns).not.toContain(forbidden);
    }
    // The credit ledger holds NO column-level UPDATE either. A single column slipping into that list would make some
    // part of a ledger row rewritable, and invariant 10 forbids editing any of it - a correction is a NEW row.
    expect(byTable.get('credit_transactions') ?? []).toEqual([]);
    // worker_definitions is GLOBAL platform config with NO write path at all - the tool_definitions precedent.
    expect(byTable.get('worker_definitions') ?? []).toEqual([]);
    // Artifacts (ACBP-P5-011): NO column UPDATE grant at all. The row carries the provenance of a produced document -
    // which run, which worker, which model version - and P5-012's revision workflow reads exactly that to know what it
    // is revising. A single updatable column would make provenance rewritable, so a superseded artifact is a NEW row.
    expect(byTable.get('artifacts') ?? []).toEqual([]);

    const jobs = byTable.get('jobs') ?? [];
    // ACBP-P5-001c EXTENDED this set with `failure_reason` — the dead-letter transition has to be recordable. The
    // extension is deliberate and narrow: it adds one outcome column and leaves the forbidden list below untouched,
    // so tenancy, kind and payload remain immutable to the app role. This assertion failing on the addition is the
    // catalog working — a grant may only widen when someone updates this line on purpose.
    expect([...jobs].sort()).toEqual(['attempts', 'failure_reason', 'state', 'updated_at']);
    for (const forbidden of ['id', 'account_id', 'company_id', 'kind', 'payload', 'idempotency_key', 'created_at', 'created_by_user_id']) {
      expect(jobs).not.toContain(forbidden);
    }
  });

  test(threatTitle('AUDIT-APPEND-ONLY', 'audit_events + activity_events'), async () => {
    for (const table of ['audit_events', 'activity_events'] as const) {
      const grants = await sql<{ privilege_type: string }>`
        select distinct privilege_type from information_schema.role_table_grants
        where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${table}
      `.execute(owner.kysely);
      const set = grants.rows.map((g) => g.privilege_type);
      expect(set).not.toContain('UPDATE');
      expect(set).not.toContain('DELETE');
      expect(set).not.toContain('TRUNCATE');
    }
    // …and the restricted role really cannot execute them (grants are the mechanism; this is the proof).
    await expect(asRestricted(product, {}, (k) => sql`update audit_events set outcome = 'blocked'`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`delete from activity_events`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`truncate table audit_events`.execute(k))).rejects.toThrow();
  });

  test('every policy is per-table intentional: no unexpected permissive policy broadens another (all policies are named and enumerated)', async () => {
    const pols = await sql<{ tablename: string; policyname: string; cmd: string; permissive: string; qual: string | null; with_check: string | null }>`
      select tablename, policyname, cmd, permissive, qual, with_check from pg_policies where schemaname = 'public' order by tablename, policyname
    `.execute(owner.kysely);
    // Every policy belongs to a known tenant table and is named after it (no stray/global policy).
    for (const p of pols.rows) {
      expect(TENANT_TABLES).toContain(p.tablename as (typeof TENANT_TABLES)[number]);
      expect(p.policyname.startsWith(p.tablename)).toBe(true);
    }
    // Every mutating policy carries a WITH CHECK (USING alone would let a write escape its scope).
    for (const p of pols.rows) {
      if (p.cmd === 'INSERT') expect(p.with_check, `${p.tablename}.${p.policyname} INSERT needs WITH CHECK`).not.toBeNull();
      if (p.cmd === 'UPDATE') {
        expect(p.qual, `${p.tablename}.${p.policyname} UPDATE needs USING`).not.toBeNull();
        expect(p.with_check, `${p.tablename}.${p.policyname} UPDATE needs WITH CHECK`).not.toBeNull();
      }
    }
    // No policy targets PUBLIC in a way that could broaden access for an unexpected role.
    const roles = await sql<{ roles: string[] }>`select roles::text[] as roles from pg_policies where schemaname = 'public'`.execute(owner.kysely);
    for (const r of roles.rows) expect(r.roles.every((x) => x === 'public' || x === 'acbp_app')).toBe(true);
  });

  test(threatTitle('RLS-CATALOG-TAMPER', 'all tenant tables'), async () => {
    // The restricted role cannot weaken its own confinement in any way.
    await expect(asRestricted(product, {}, (k) => sql`alter table companies disable row level security`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`alter table companies no force row level security`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`drop policy companies_select on companies`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`create policy evil on companies for all using (true) with check (true)`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`set role postgres`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`create role escalated login`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`alter role acbp_app bypassrls`.execute(k))).rejects.toThrow();
  });

  test('no application runtime source references the owner DATABASE_URL (the runtime uses DATABASE_APP_URL only)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, '..', '..', '..', '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        if (entry.name.endsWith('.test.ts')) continue;
        if (readFileSync(full, 'utf8').includes('DATABASE_URL')) offenders.push(full);
      }
    };
    walk(join(repoRoot, 'apps', 'web', 'src'));
    expect(offenders).toEqual([]);
  });
});
