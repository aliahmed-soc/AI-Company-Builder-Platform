// ACBP-P1-011 / CDR-017 §10 — real-PostgreSQL QUERY-PLAN EVIDENCE for the portfolio enumeration (Slice 6).
//
// Seeds a REALISTIC population (10 accounts, ~2,800 companies, ~2,300 memberships — active AND revoked, plus a
// high-membership noise actor in the same account and an exact-microsecond created_at tie), ANALYZEs, then runs
// EXPLAIN (FORMAT JSON) on the EXACT PRODUCTION query (`PortfolioRepository.buildListQuery` — the very builder
// `listActiveMembershipCompanies` executes, so this evidence cannot drift from production) — as the restricted
// `acbp_app` role under the account+actor GUCs, so the RLS policy predicates are part of the planned query — for
// both the first page and the keyset (`after`) page.
//
// It asserts SEMANTIC plan properties (tolerant of normal planner variation — node types/index names, never exact
// plan text):
//   - access begins from the actor's memberships via the partial index `company_memberships_member_idx`;
//   - the `companies` join uses an indexed key (no unbounded account-wide sequential scan of either relation);
//   - the account + actor predicates (RLS + explicit) are present in the planned quals;
//   - the query is bounded (Limit node; the compiled SQL has NO OFFSET) and deterministically ordered
//     (Sort over created_at + id);
//   - ONLY `company_memberships` + `companies` are touched (no broad profile query).
// The NATURAL plan is recorded (console marker `PORTFOLIO_PLAN_EVIDENCE`) for the query-plan doc; no planner
// settings are forced. The executing method is ALSO walked over the same seed (12 expected rows, strict keyset
// order, tie broken by id DESC, no overlap/gap across pages) to prove behavioral correctness at this scale.
//
// Skips when ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { microsecondEpochToIso } from '@acbp/contracts';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, withTransaction, PortfolioRepository, type DatabaseClient, type PortfolioCandidateRow } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `plan_${'test'}_pw_1970`;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-plan-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-plan-test' }));
}

/** One EXPLAIN plan node (recursive). */
interface PlanNode {
  readonly [key: string]: unknown;
  readonly Plans?: readonly PlanNode[];
}
function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap((p) => flattenPlan(p))];
}

const TIE_TS = '2026-01-01T10:00:00.123456Z';

describe.skipIf(!hasTestDatabase)('portfolio enumeration query plan (real PostgreSQL, restricted role) — ACBP-P1-011/CDR-017 §10', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let uMain = '';
  let accountA = '';

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const ctx = () => ({ 'app.current_account': accountA, 'app.current_actor': uMain });

  /** EXPLAIN the EXACT production query: `PortfolioRepository.buildListQuery` is the same builder
   *  `listActiveMembershipCompanies` executes, so this evidence can never drift from what production runs. */
  async function explainNodes(after?: { createdAt: string; companyId: string }): Promise<{ nodes: PlanNode[]; text: string }> {
    return asApp(ctx(), async (k) => {
      const rows = await new PortfolioRepository(k).buildListQuery(uMain, 26, after !== undefined ? { after } : {}).explain<Record<string, unknown>>('json');
      const qp = rows[0]?.['QUERY PLAN'];
      const parsed: unknown = typeof qp === 'string' ? JSON.parse(qp) : qp;
      const root = (parsed as ReadonlyArray<{ Plan: PlanNode }>)[0]!.Plan;
      return { nodes: flattenPlan(root), text: JSON.stringify(parsed) };
    });
  }

  function assertPlanShape(nodes: PlanNode[], text: string, label: string): void {
    // Only the two expected relations are touched — no broad profile (or any other) query.
    const relations = new Set(nodes.map((n) => n['Relation Name']).filter((r): r is string => typeof r === 'string'));
    expect([...relations].sort()).toEqual(['companies', 'company_memberships']);
    expect(text).not.toContain('company_profiles');
    // Access begins from the actor's active memberships via the partial index (never a memberships seq scan).
    // Pinning the INDEX NAME is a deliberate tripwire: if a different/composite membership index is ever added
    // and the planner prefers it, this fails so the query-plan evidence gets RE-DERIVED — not a plain flake.
    expect(nodes.some((n) => n['Index Name'] === 'company_memberships_member_idx')).toBe(true);
    // The companies join uses an indexed access path. Tolerant of legitimate planner variation: a plain
    // Index/Index Only Scan carries the relation name on the node itself, while a bitmap plan splits into a
    // Bitmap Heap Scan (relation, no "Index" in the node type) + a child Bitmap Index Scan (index, no relation).
    expect(
      nodes.some(
        (n) =>
          n['Relation Name'] === 'companies' && (String(n['Node Type']).includes('Index') || n['Node Type'] === 'Bitmap Heap Scan'),
      ),
    ).toBe(true);
    for (const n of nodes) {
      if (n['Node Type'] === 'Seq Scan') {
        throw new Error(`${label}: unexpected Seq Scan on ${String(n['Relation Name'])} — unbounded scan in the portfolio plan`);
      }
    }
    // Bounded + deterministically ordered: a Limit node over a Sort on (created_at DESC, id DESC) — the exact
    // CDR-017 §8 ordering contract, direction included.
    expect(nodes.some((n) => n['Node Type'] === 'Limit')).toBe(true);
    const sortKeys = nodes
      .filter((n) => String(n['Node Type']).includes('Sort'))
      .map((n) => JSON.stringify(n['Sort Key'] ?? ''))
      .join(' ');
    expect(sortKeys).toMatch(/created_at DESC/);
    expect(sortKeys).toMatch(/\.id DESC/);
    // The account + actor predicates (RLS policy quals + the explicit actor parameter) survive into the plan.
    expect(text).toContain('app.current_account');
    expect(text).toContain('app.current_actor');
  }

  beforeAll(async () => {
    su = superuserClient();
    for (const t of ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(su);
    expect(r.error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    // ── Realistic population (superuser bulk seed) ────────────────────────────────────────────────────
    const mkUser = async (tag: string): Promise<string> => {
      const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_plan', ${tag}, now()) returning id`.execute(su.kysely);
      return u.rows[0]!.id;
    };
    uMain = await mkUser('u_main');
    const uPeer = await mkUser('u_peer');
    const ownerA = await mkUser('owner_a');
    const a = await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${ownerA}::uuid) returning id`.execute(su.kysely);
    accountA = a.rows[0]!.id;
    // Account A: 1,000 companies, created_at spread minute-by-minute.
    await sql`
      insert into companies (account_id, creation_mode, status, created_at)
      select ${accountA}::uuid, 'own_idea', 'active', timestamptz '2026-01-01T00:00:00Z' + make_interval(mins => g)
      from generate_series(1, 1000) g
    `.execute(su.kysely);
    // uMain: 12 ACTIVE memberships (the portfolio), 5 REVOKED (must not contribute), in account A.
    await sql`
      insert into company_memberships (account_id, company_id, member_user_id, role, status)
      select account_id, id, ${uMain}::uuid, 'owner', 'active' from companies where account_id = ${accountA}::uuid order by created_at desc limit 12
    `.execute(su.kysely);
    await sql`
      insert into company_memberships (account_id, company_id, member_user_id, role, status)
      select account_id, id, ${uMain}::uuid, 'viewer', 'revoked' from companies where account_id = ${accountA}::uuid order by created_at asc limit 5
    `.execute(su.kysely);
    // An exact-microsecond created_at TIE across 3 of uMain's active companies (id DESC must break it).
    await sql`
      update companies set created_at = ${TIE_TS}::timestamptz
      where id in (select company_id from company_memberships where member_user_id = ${uMain}::uuid and status = 'active' order by company_id limit 3)
    `.execute(su.kysely);
    // uPeer: 500 active memberships in the SAME account (noise proving the ACTOR predicate does the filtering).
    await sql`
      insert into company_memberships (account_id, company_id, member_user_id, role, status)
      select account_id, id, ${uPeer}::uuid, 'viewer', 'active' from companies where account_id = ${accountA}::uuid order by created_at desc limit 500
    `.execute(su.kysely);
    // 9 OTHER accounts, 200 companies each, each fully membered by its own owner (cross-account noise).
    for (let i = 0; i < 9; i++) {
      const ownerB = await mkUser(`owner_b${i}`);
      const b = await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${ownerB}::uuid) returning id`.execute(su.kysely);
      const accountB = b.rows[0]!.id;
      await sql`
        insert into companies (account_id, creation_mode, status, created_at)
        select ${accountB}::uuid, 'own_idea', 'active', timestamptz '2026-02-01T00:00:00Z' + make_interval(mins => g)
        from generate_series(1, 200) g
      `.execute(su.kysely);
      await sql`
        insert into company_memberships (account_id, company_id, member_user_id, role, status)
        select account_id, id, ${ownerB}::uuid, 'owner', 'active' from companies where account_id = ${accountB}::uuid
      `.execute(su.kysely);
    }
    // Fresh statistics so the NATURAL plan reflects the realistic population (no forced planner settings).
    await sql`analyze public.companies`.execute(su.kysely);
    await sql`analyze public.company_memberships`.execute(su.kysely);
  });

  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (su) {
      try {
        await sql`alter role acbp_app nologin`.execute(su.kysely);
      } catch {
        /* best effort */
      }
      for (const t of ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(su);
    }
  });

  test('natural first-page plan: membership-index driven, indexed companies join, bounded, ordered, no seq scan', async () => {
    const { nodes, text } = await explainNodes();
    // Record the natural hosted plan (compact) for the query-plan evidence doc.
    console.log('PORTFOLIO_PLAN_EVIDENCE first_page ' + JSON.stringify(nodes.map((n) => ({ t: n['Node Type'], r: n['Relation Name'], i: n['Index Name'] }))));
    assertPlanShape(nodes, text, 'first page');
    // No OFFSET anywhere in the PRODUCTION compiled SQL (keyset only).
    const compiled = await asApp(ctx(), (k) => Promise.resolve(new PortfolioRepository(k).buildListQuery(uMain, 26).compile().sql.toLowerCase()));
    expect(compiled).not.toContain('offset');
  });

  test('natural keyset-page plan: the `after` predicate keeps the same bounded, index-driven shape', async () => {
    const { nodes, text } = await explainNodes({ createdAt: TIE_TS, companyId: '99999999-9999-4999-8999-999999999999' });
    console.log('PORTFOLIO_PLAN_EVIDENCE keyset_page ' + JSON.stringify(nodes.map((n) => ({ t: n['Node Type'], r: n['Relation Name'], i: n['Index Name'] }))));
    assertPlanShape(nodes, text, 'keyset page');
  });

  test('the REAL repository agrees with the mirrored shape on this population: 12 rows, strict keyset walk, tie by id DESC', async () => {
    // Full read: exactly uMain's 12 ACTIVE memberships (revoked + peer + cross-account rows contribute nothing).
    const all = await asApp(ctx(), (k) => new PortfolioRepository(k).listActiveMembershipCompanies(uMain, 50));
    expect(all).toHaveLength(12);
    // Strictly descending (created_at_us, company_id) — deterministic total order.
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1]!;
      const cur = all[i]!;
      const cmp = BigInt(prev.created_at_us) - BigInt(cur.created_at_us);
      expect(cmp > 0n || (cmp === 0n && prev.company_id > cur.company_id)).toBe(true);
    }
    // The 3 tied rows are adjacent and ordered by id DESC.
    const tied = all.filter((r) => microsecondEpochToIso(r.created_at_us) === TIE_TS);
    expect(tied).toHaveLength(3);
    expect(tied.map((r) => r.company_id)).toEqual([...tied.map((r) => r.company_id)].sort().reverse());
    // Keyset walk in pages of 5: no overlap, no gap, same set and order as the single read.
    const walked: PortfolioCandidateRow[] = [];
    let after: { createdAt: string; companyId: string } | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await asApp(ctx(), (k) => new PortfolioRepository(k).listActiveMembershipCompanies(uMain, 5, after !== undefined ? { after } : {}));
      walked.push(...page);
      if (page.length < 5) break;
      const last = page[page.length - 1]!;
      after = { createdAt: microsecondEpochToIso(last.created_at_us)!, companyId: last.company_id };
    }
    expect(walked.map((r) => r.company_id)).toEqual(all.map((r) => r.company_id));
  });
});
