// ACBP-P6-009 — account usage rollups and compensating usage corrections (CDR-073; USAGE-001 amended; ADR-013,
// ADR-003 §16; trust-critical #13/#14; launch gate 7).
//
// TWO tables with deliberately OPPOSITE mutability, and the contrast is the point:
//
//   `account_usage_rollups`  — a MUTABLE PROJECTION. `DATA-ARCHITECTURE` marks it `M (derived; rebuildable from
//                              ledger)`. It may be overwritten precisely because it holds no information of its
//                              own: drop it and a rebuild reproduces it exactly. It is NEVER evidence — when it
//                              and the ledger disagree, the ledger is right (CDR-073 §1-G1).
//   `usage_corrections`      — APPEND-ONLY, like every other ledger here (SELECT+INSERT, no UPDATE/DELETE grant).
//                              Trust-critical #13: *"Usage corrections create compensating records (never
//                              edits)"* — a property of the GRANTS, not of anyone's restraint.
//
// ACCOUNT-OWNED, COMPANY-ATTRIBUTED, exactly as `credit_transactions` (0041) is and for the identical reason:
// RLS keys on `account_id` ALONE because these figures SPAN companies and the company GUC holds one at a time.
// Company attribution is carried by a TENANT-PINNED COMPOSITE FK rather than by the policy.
//
// NOTHING EXISTING IS WEAKENED. No policy, grant or CHECK on `usage_events` is modified. The tempting shortcut —
// adding `or current_company is null` to its SELECT policy so one query could sum the whole account — is
// fail-OPEN for any code path that forgets to set the company GUC, and is rejected in CDR-073 §1-G6. The only
// change to an existing table here is an ADDITIVE unique constraint that makes `(id, company_id)` a legal
// composite-FK target, mirroring `companies_id_account_uq` in 0041.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // A composite FK needs a unique constraint on the exact parent columns. `usage_events` is keyed on `id` alone,
  // so `(id, company_id)` has to exist before a correction can reference the pair. Additive and redundant for
  // uniqueness — its only job is to be a legal FK target, which is what lets the reference carry the tenant.
  await sql`alter table public.usage_events add constraint usage_events_id_company_uq unique (id, company_id)`.execute(db);

  // ── 1) account_usage_rollups — the projection ─────────────────────────────────────────────────────────────
  await db.schema
    .createTable('account_usage_rollups')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    // The period key: the first day of a UTC calendar month (CDR-073 §1-G8). `date`, not `timestamptz`, because
    // a period is a calendar fact and storing an instant would reintroduce the timezone question the derivation
    // exists to settle.
    .addColumn('period_start', 'date', (col) => col.notNull())
    // BIGINT, NOT INTEGER (CDR-073 §1-G13). The source columns are int4, which is the right width for ONE event
    // and the wrong width for a period's worth: `estimated_cost_micros` in micro-units tops out at ~2,147 cost
    // units per account-period. PostgreSQL agrees — `sum(integer)` returns bigint.
    .addColumn('event_count', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('input_tokens', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('output_tokens', 'bigint', (col) => col.notNull().defaultTo(0))
    .addColumn('estimated_cost_micros', 'bigint', (col) => col.notNull().defaultTo(0))
    // WHEN this projection was last recomputed. Not a source of truth either — it answers "how stale is this?".
    .addColumn('computed_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('account_usage_rollups_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // The period key IS the first of the month. A mid-month value is not a finer-grained version of the same
    // thing — it is a SECOND row for one period, which would split the total in half and look like two periods.
    .addCheckConstraint('account_usage_rollups_period_is_month_start', sql`extract(day from period_start) = 1`)
    // NON-NEGATIVE. Sound only because a correction can never subtract more than the event it references
    // (the trigger below) and there is at most ONE correction per event (the unique index below) — CDR-073
    // §1-G10a/b. Without BOTH of those, stacked corrections could drive a lane negative and a negative token
    // count would reach a billing surface.
    .addCheckConstraint('account_usage_rollups_event_count_nonneg', sql`event_count >= 0`)
    .addCheckConstraint('account_usage_rollups_input_tokens_nonneg', sql`input_tokens >= 0`)
    .addCheckConstraint('account_usage_rollups_output_tokens_nonneg', sql`output_tokens >= 0`)
    .addCheckConstraint('account_usage_rollups_cost_nonneg', sql`estimated_cost_micros >= 0`)
    .execute();

  // ONE ROW PER (ACCOUNT, PERIOD) — and the conflict target the idempotent rebuild upserts on (CDR-073 §1-G12).
  // A rebuild REPLACES the figures; rebuilding twice must produce the same row rather than doubling it.
  await sql`create unique index account_usage_rollups_account_period_uq on public.account_usage_rollups (account_id, period_start)`.execute(db);

  // ── 2) usage_corrections — the compensating ledger ────────────────────────────────────────────────────────
  await db.schema
    .createTable('usage_corrections')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    // ATTRIBUTION, not isolation (the `credit_transactions` distinction). NOT NULL here, unlike credits: every
    // correction compensates a usage event, and every usage event belongs to exactly one company.
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('corrects_usage_event_id', 'uuid', (col) => col.notNull())
    // SIGNED DELTAS, and `int4` is right here because a correction is bounded by ONE event (the trigger below),
    // which is itself int4. Only the accumulated rollup needs the wider type.
    .addColumn('event_count_delta', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('input_tokens_delta', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('output_tokens_delta', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('estimated_cost_micros_delta', 'integer', (col) => col.notNull().defaultTo(0))
    // Bounded, non-secret operator text. NOT a closed enum: canon defines no correction taxonomy, and inventing
    // one here would be a requirement nobody asked for.
    .addColumn('reason', 'text', (col) => col.notNull())
    .addColumn('created_by_user_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('usage_corrections_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // TENANT-PINNED COMPOSITE, for the reason `credit_transactions` documents: RI checks ALWAYS bypass RLS, so a
    // single-column company FK would let the app role write its own `account_id` beside a FOREIGN `company_id`
    // and corrupt attribution without tripping a policy.
    .addForeignKeyConstraint('usage_corrections_company_fk', ['company_id', 'account_id'], 'companies', ['id', 'account_id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // Likewise tenant-pinned: a correction can only reference a usage event in the company it is attributed to.
    .addForeignKeyConstraint('usage_corrections_event_fk', ['corrects_usage_event_id', 'company_id'], 'usage_events', ['id', 'company_id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // A CORRECTION ONLY EVER REDUCES (CDR-073 §1-G10a). Under-recording is not fixable here anyway — metering is
    // fail-closed, so an unmetered call withheld its output. What a positive delta WOULD create is a path to
    // inflate recorded usage without writing a real metered event, and that direction must stay impossible.
    .addCheckConstraint(
      'usage_corrections_deltas_nonpositive',
      sql`event_count_delta <= 0 and input_tokens_delta <= 0 and output_tokens_delta <= 0 and estimated_cost_micros_delta <= 0`,
    )
    // A no-op correction is noise in a ledger retained for the billing lifetime, and an audited act that changed
    // nothing is worse than no record.
    .addCheckConstraint(
      'usage_corrections_not_empty',
      sql`event_count_delta <> 0 or input_tokens_delta <> 0 or output_tokens_delta <> 0 or estimated_cost_micros_delta <> 0`,
    )
    .addCheckConstraint('usage_corrections_reason_len', sql`char_length(reason) between 1 and 500`)
    .execute();

  // AT MOST ONE CORRECTION PER EVENT (CDR-073 §1-G10b). This is what makes the per-row bound below an ACTUAL
  // bound: three corrections each individually within the event's magnitude still sum past it.
  await sql`create unique index usage_corrections_event_uq on public.usage_corrections (corrects_usage_event_id)`.execute(db);
  // The account-wide read path.
  await sql`create index usage_corrections_account_created_idx on public.usage_corrections (account_id, created_at)`.execute(db);

  // ── 3) THE CORRECTION BOUND (CDR-073 §1-G10) ──────────────────────────────────────────────────────────────
  //
  // A CHECK cannot look at another row, so "a correction may not subtract more than the event recorded" needs
  // something that can. Without it, an event of 100 tokens could be corrected by -2,000,000,000 and pass every
  // constraint in this table. This mirrors `acbp_check_credit_settlement` (0041), which exists because review
  // pass 1 found exactly that hole on the release path.
  //
  // NOT SECURITY DEFINER — it runs as the invoker, so the referenced event is subject to the caller's own RLS
  // policy. The closed SECURITY DEFINER allowlist stays at three.
  await sql`
    create or replace function public.acbp_check_usage_correction() returns trigger
    language plpgsql as $$
    declare corrected public.usage_events%rowtype;
    begin
      select * into corrected from public.usage_events where id = new.corrects_usage_event_id;
      if not found then
        -- Unreachable through the composite FK for a VISIBLE row; reachable when the row exists but the caller's
        -- RLS hides it. Refusing is the fail-closed answer: a bound that cannot be checked is not a bound.
        raise exception 'usage correction references an event that is not visible in this scope' using errcode = '23514';
      end if;
      if corrected.account_id <> new.account_id then
        raise exception 'usage correction must reference an event in the same account' using errcode = '23514';
      end if;
      -- THE BOUND, PER LANE: never subtract more than was recorded. Deltas are <= 0 by CHECK, so comparing
      -- magnitudes is the whole test.
      if abs(new.input_tokens_delta) > corrected.input_tokens then
        raise exception 'usage correction cannot subtract more input tokens than the event recorded' using errcode = '23514';
      end if;
      if abs(new.output_tokens_delta) > corrected.output_tokens then
        raise exception 'usage correction cannot subtract more output tokens than the event recorded' using errcode = '23514';
      end if;
      if abs(new.estimated_cost_micros_delta) > corrected.estimated_cost_micros then
        raise exception 'usage correction cannot subtract more cost than the event recorded' using errcode = '23514';
      end if;
      -- One event is one event: a correction may retract it (-1) but cannot retract more than one.
      if abs(new.event_count_delta) > 1 then
        raise exception 'usage correction cannot retract more than one event' using errcode = '23514';
      end if;
      return new;
    end;
    $$
  `.execute(db);
  // D3 — revoke the implicit PUBLIC EXECUTE that `CREATE FUNCTION` grants, as 0041 does for its trigger function.
  await sql`revoke all on function public.acbp_check_usage_correction() from public`.execute(db);
  await sql`create trigger usage_corrections_bound before insert on public.usage_corrections for each row execute function public.acbp_check_usage_correction()`.execute(db);

  // ── 4) Grants ─────────────────────────────────────────────────────────────────────────────────────────────
  //
  // The rollup is the ONLY table in this schema the app role may UPDATE beyond a lifecycle column, and the grant
  // is COLUMN-LEVEL so that privilege covers exactly the derived figures. `account_id` and `period_start` are
  // deliberately excluded: a table-wide UPDATE grant would let a rebuild move a row to ANOTHER ACCOUNT, which is
  // a tenant-isolation hole reachable without ever tripping a policy (the WITH CHECK below would still pass if
  // the row were re-keyed inside the caller's own account). No DELETE — a rollup row is replaced, never removed.
  await sql`grant select, insert on public.account_usage_rollups to ${APP_ROLE}`.execute(db);
  await sql`grant update (event_count, input_tokens, output_tokens, estimated_cost_micros, computed_at) on public.account_usage_rollups to ${APP_ROLE}`.execute(db);
  // Append-only: SELECT + INSERT and nothing else (invariant 9's shape, trust-critical #13).
  await sql`grant select, insert on public.usage_corrections to ${APP_ROLE}`.execute(db);

  // ── 5) FORCE RLS + account-keyed policies ─────────────────────────────────────────────────────────────────
  for (const t of ['account_usage_rollups', 'usage_corrections'] as const) {
    await sql`alter table public.${sql.ref(t)} enable row level security`.execute(db);
    await sql`alter table public.${sql.ref(t)} force row level security`.execute(db);
  }

  // ACCOUNT-KEYED ONLY (CDR-073 §1-G2). Adding `company_id` to these predicates would stop an owner ever reading
  // their own account total, because the total spans companies and the GUC holds one at a time. Satisfied under
  // BOTH an account transaction and a company one, since a company session sets `app.current_account` too — which
  // is what lets the rebuild write the rollup while elevated into the last company it summed.
  await sql`create policy account_usage_rollups_select on public.account_usage_rollups for select using (account_id::text = ${CURRENT_ACCOUNT})`.execute(db);
  await sql`create policy account_usage_rollups_insert on public.account_usage_rollups for insert with check (account_id::text = ${CURRENT_ACCOUNT})`.execute(db);
  await sql`
    create policy account_usage_rollups_update on public.account_usage_rollups for update
      using (account_id::text = ${CURRENT_ACCOUNT})
      with check (account_id::text = ${CURRENT_ACCOUNT})
  `.execute(db);
  // No delete policy, and no grant to pair one with.

  await sql`create policy usage_corrections_select on public.usage_corrections for select using (account_id::text = ${CURRENT_ACCOUNT})`.execute(db);
  await sql`create policy usage_corrections_insert on public.usage_corrections for insert with check (account_id::text = ${CURRENT_ACCOUNT})`.execute(db);
  // No update or delete policy, deliberately — the ledger is append-only.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists usage_corrections_insert on public.usage_corrections`.execute(db);
  await sql`drop policy if exists usage_corrections_select on public.usage_corrections`.execute(db);
  await sql`drop policy if exists account_usage_rollups_update on public.account_usage_rollups`.execute(db);
  await sql`drop policy if exists account_usage_rollups_insert on public.account_usage_rollups`.execute(db);
  await sql`drop policy if exists account_usage_rollups_select on public.account_usage_rollups`.execute(db);
  await sql`revoke all on public.usage_corrections from ${APP_ROLE}`.execute(db);
  await sql`revoke all on public.account_usage_rollups from ${APP_ROLE}`.execute(db);
  await sql`drop trigger if exists usage_corrections_bound on public.usage_corrections`.execute(db);
  await sql`drop function if exists public.acbp_check_usage_correction()`.execute(db);
  await sql`drop index if exists public.usage_corrections_account_created_idx`.execute(db);
  await sql`drop index if exists public.usage_corrections_event_uq`.execute(db);
  await db.schema.dropTable('usage_corrections').ifExists().execute();
  await sql`drop index if exists public.account_usage_rollups_account_period_uq`.execute(db);
  await db.schema.dropTable('account_usage_rollups').ifExists().execute();
  await sql`alter table public.usage_events drop constraint if exists usage_events_id_company_uq`.execute(db);
}
