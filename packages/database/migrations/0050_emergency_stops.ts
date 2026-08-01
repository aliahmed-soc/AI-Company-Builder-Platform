// ACBP-P6-007 — emergency-stop records and the held-work queue (CDR-072 §1-G2/G5/G6; ADMIN-001/002; COMP-006;
// invariant 14; diagrams/13-emergency-stop.mmd).
//
// THE FAILURE THIS SCHEMA IS BUILT AGAINST (CDR-072 §0): a stop that silently fails to reach one scope is worse
// than no stop at all, because the operator believes it worked and stops watching. Every constraint below exists
// to make a stop record that CANNOT be read honestly impossible to store, rather than to be sorted out later by
// whichever code path happens to read it.
//
// TWO TABLES, DIFFERENT POSTURES:
//
//   emergency_stops — the stop state itself. SELECT + INSERT + a column-scoped UPDATE(status, cleared_*). NO
//                     DELETE: a stop that happened is history, and deleting it would erase the record of a period
//                     during which the platform was halted.
//   held_work       — work caught by a stop. SELECT + INSERT + column-scoped UPDATE(status, reviewed_*). NO
//                     DELETE, because diagram 13's held-work queue is "visible, nothing lost" and a discarded item
//                     is a REVIEWED item, not an absent one.
//
// `emergency_stops` IS DUAL-SCOPE, and that is not a new tenancy decision — it is `audit_events`' established
// shape (migration 0008 §8): an ACCOUNT-scoped row carries `company_id` NULL and matches on account alone, a
// COMPANY-scoped row carries it and matches on both. An `account_wide` stop is precisely an account-scoped record:
// storing it per-company would leave any company created after the stop uncovered, which is the §0 silent miss
// wearing a schema.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

// Mirrors `STOP_SCOPES` in @acbp/contracts. Duplicated on purpose and asserted equal by a test that reads this
// CHECK back out of `pg_constraint` and compares it as a SET to the contract's list
// (`emergency-stops.integration.test.ts`). That assertion did NOT exist when this comment first claimed it did —
// an independent review found the claim unbacked, which is why it now names the file that makes it true. The
// ACTIVITY_TYPES
// divergence (contracts widened without a migration) is the precedent for why a silently diverging pair is a booby
// trap rather than a convenience.
const SCOPES = "'task', 'worker', 'capability', 'integration', 'company', 'external_actions_only', 'account_wide'";
// The scopes whose meaning is "this specific thing", and which are therefore meaningless without a target.
const IDENTITY_SCOPES = "'task', 'worker', 'capability', 'integration', 'company'";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── emergency_stops ─────────────────────────────────────────────────────────────────────────────────────
  await db.schema
    .createTable('emergency_stops')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    // NULLABLE, and only for `account_wide` — see the CHECK below, which is what keeps that true.
    .addColumn('company_id', 'uuid')
    .addColumn('scope', 'text', (col) => col.notNull())
    // Identity scopes REQUIRE this; the others REQUIRE its absence. Text rather than uuid because a capability is
    // named, not keyed.
    .addColumn('target_id', 'text')
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    .addColumn('reason', 'text')
    .addColumn('activated_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('activated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('cleared_by_user_id', 'uuid')
    .addColumn('cleared_at', 'timestamptz')
    .addForeignKeyConstraint('emergency_stops_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('emergency_stops_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addCheckConstraint('emergency_stops_scope_valid', sql.raw(`scope in (${SCOPES})`))
    .addCheckConstraint('emergency_stops_status_valid', sql`status in ('active', 'cleared')`)
    // A SCOPED STOP WITHOUT A TARGET IS UNSTORABLE. In the contract such a record is `unreadable` and denies; here
    // it simply cannot exist, so the unreadable branch guards against corruption from outside this schema rather
    // than against something the product path can produce.
    .addCheckConstraint(
      'emergency_stops_target_matches_scope',
      sql.raw(
        `(scope in (${IDENTITY_SCOPES}) and target_id is not null and length(btrim(target_id)) > 0)
         or (scope not in (${IDENTITY_SCOPES}) and target_id is null)`,
      ),
    )
    // THE LOAD-BEARING TENANCY CONSTRAINT. `account_wide` is the ONLY scope that may omit a company, and it MUST
    // omit one: an account-wide stop pinned to a company would not cover its siblings, and a company-scoped stop
    // without a company would be invisible to the company predicate. Either way a scope would silently miss.
    .addCheckConstraint(
      'emergency_stops_company_matches_scope',
      sql`(scope = 'account_wide' and company_id is null) or (scope <> 'account_wide' and company_id is not null)`,
    )
    // A `company` STOP MUST NAME ITS OWN COMPANY. Found in review pass 2, and it is the §0 failure in miniature:
    // the covering rule matches a `company` stop by comparing `target_id` to the CALL's company, while RLS shows the
    // row to the company in `company_id`. Nothing tied those two together, so a stop with `company_id = A` and
    // `target_id = B` was storable, ACTIVE, visible to A — and covered nothing at all. An operator would have been
    // told the company was halted while every call went through. Making it unstorable is the right layer: the
    // service refuses it too, but a CHECK cannot be forgotten by a future caller.
    .addCheckConstraint('emergency_stops_company_target_is_self', sql`scope <> 'company' or target_id = company_id::text`)
    // Status and the clearing columns cannot disagree — an `active` row that records who cleared it, or a `cleared`
    // row that does not, is a record nobody can read honestly afterwards.
    .addCheckConstraint(
      'emergency_stops_clear_consistent',
      sql`(status = 'active' and cleared_at is null and cleared_by_user_id is null)
          or (status = 'cleared' and cleared_at is not null and cleared_by_user_id is not null)`,
    )
    // The composite target `held_work`'s tenant-pinned FK needs. Pinned on ACCOUNT rather than company, because an
    // `account_wide` stop has no company to pin to.
    .addUniqueConstraint('emergency_stops_id_account_uq', ['id', 'account_id'])
    .execute();

  // AT MOST ONE ACTIVE STOP OF A GIVEN SHAPE. Without this, two identical account-wide stops would both be storable
  // and "clear the stop" would clear one of them — leaving the platform halted by a record the operator believed
  // they had just removed.
  //
  // `NULLS NOT DISTINCT` (PostgreSQL 15+; CI runs 16) rather than `coalesce(...)` sentinels, and the reason is not
  // style. A partial unique index over EXPRESSIONS cannot be targeted by `ON CONFLICT` inference, and
  // `ON CONFLICT ON CONSTRAINT` accepts only a real table CONSTRAINT — which a partial index is not — so the
  // expression form left no way to write the upsert that did not fail at runtime with 42704. Plain columns keep the
  // index inferable. `tools/check-conflict-targets.mjs` caught the first version; this is what it was asking for.
  await sql`
    create unique index emergency_stops_active_uq on public.emergency_stops (account_id, company_id, scope, target_id)
      nulls not distinct
      where status = 'active'
  `.execute(db);

  // The read the dispatcher makes before EVERY tool call (invariant 14), so it is indexed for exactly that shape:
  // active stops for this account, company-scoped or account-wide.
  await sql`create index emergency_stops_active_lookup_idx on public.emergency_stops (account_id, company_id) where status = 'active'`.execute(db);

  await sql`grant select, insert on public.emergency_stops to ${APP_ROLE}`.execute(db);
  // Clearing is the one legal mutation, and only the three columns that carry it. No DELETE, and deliberately no
  // UPDATE of `scope` or `target_id`: a stop that could be re-pointed after activation would let the record of
  // WHAT was halted be rewritten after the fact.
  await sql`grant update (status, cleared_at, cleared_by_user_id) on public.emergency_stops to ${APP_ROLE}`.execute(db);

  await sql`alter table public.emergency_stops enable row level security`.execute(db);
  await sql`alter table public.emergency_stops force row level security`.execute(db);
  // DUAL-SCOPE, matching `audit_events` (migration 0008 §8): account-scoped rows (company_id NULL) are visible to
  // every company in the account, which is what makes `account_wide` actually account-wide.
  await sql`
    create policy emergency_stops_select on public.emergency_stops for select
      using (account_id::text = ${CURRENT_ACCOUNT} and (company_id is null or company_id::text = ${CURRENT_COMPANY}))
  `.execute(db);
  await sql`
    create policy emergency_stops_insert on public.emergency_stops for insert
      with check (account_id::text = ${CURRENT_ACCOUNT} and (company_id is null or company_id::text = ${CURRENT_COMPANY}))
  `.execute(db);
  // USING *and* WITH CHECK: without WITH CHECK an update could move a row out of the caller's tenant — visible to
  // change and free to land anywhere.
  await sql`
    create policy emergency_stops_update on public.emergency_stops for update
      using (account_id::text = ${CURRENT_ACCOUNT} and (company_id is null or company_id::text = ${CURRENT_COMPANY}))
      with check (account_id::text = ${CURRENT_ACCOUNT} and (company_id is null or company_id::text = ${CURRENT_COMPANY}))
  `.execute(db);

  // ── held_work ───────────────────────────────────────────────────────────────────────────────────────────
  await db.schema
    .createTable('held_work')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    // NOT NULL here, unlike the stop: held work is always a task, and a task always belongs to a company.
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('stop_id', 'uuid', (col) => col.notNull())
    .addColumn('task_id', 'uuid', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('held'))
    .addColumn('held_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('reviewed_by_user_id', 'uuid')
    .addColumn('reviewed_at', 'timestamptz')
    .addForeignKeyConstraint('held_work_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('held_work_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // TENANT-PINNED. RI checks ALWAYS bypass RLS, so a single-column FK would let one account's held item cite
    // another account's stop — i.e. claim it was held by a halt that was never in force for it.
    .addForeignKeyConstraint('held_work_stop_fk', ['stop_id', 'account_id'], 'emergency_stops', ['id', 'account_id'], (cb) =>
      cb.onDelete('cascade').onUpdate('no action'),
    )
    .addForeignKeyConstraint('held_work_task_fk', ['task_id', 'company_id'], 'tasks', ['id', 'company_id'], (cb) =>
      cb.onDelete('cascade').onUpdate('no action'),
    )
    .addCheckConstraint('held_work_status_valid', sql`status in ('held', 'confirmed', 'discarded')`)
    // A reviewed item records WHO reviewed it and WHEN; a held item records neither. ADMIN-002's review-to-resume
    // is only meaningful if "reviewed" cannot be claimed without an actor.
    .addCheckConstraint(
      'held_work_review_consistent',
      sql`(status = 'held' and reviewed_at is null and reviewed_by_user_id is null)
          or (status in ('confirmed', 'discarded') and reviewed_at is not null and reviewed_by_user_id is not null)`,
    )
    // One hold per task per stop. Re-holding an already-held task under the same stop would inflate the queue the
    // operator has to review, and a review queue nobody can finish is a review queue nobody does.
    .addUniqueConstraint('held_work_stop_task_uq', ['stop_id', 'task_id'])
    .execute();

  await sql`create index held_work_pending_idx on public.held_work (company_id, stop_id) where status = 'held'`.execute(db);

  await sql`grant select, insert on public.held_work to ${APP_ROLE}`.execute(db);
  // Review is the one legal mutation. NO DELETE: "nothing lost" means a discarded item is a REVIEWED item, not a
  // vanished one — an operator must be able to see afterwards what they chose not to resume.
  await sql`grant update (status, reviewed_at, reviewed_by_user_id) on public.held_work to ${APP_ROLE}`.execute(db);

  await sql`alter table public.held_work enable row level security`.execute(db);
  await sql`alter table public.held_work force row level security`.execute(db);
  await sql`create policy held_work_select on public.held_work for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy held_work_insert on public.held_work for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`
    create policy held_work_update on public.held_work for update
      using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
      with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('held_work').ifExists().execute();
  await db.schema.dropTable('emergency_stops').ifExists().execute();
}
