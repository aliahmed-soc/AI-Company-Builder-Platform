// ACBP-P6-003b — approval requests and append-only decisions (CDR-068 §1; APPR-002/003/007/010; ADR-009; invariant 5).
//
// TWO TABLES, DELIBERATELY DIFFERENT POSTURES, the same split 0045 made for policies:
//
//   approval_requests   — C, transitions `pending → decided | superseded`. SELECT + INSERT + a column-scoped
//                         UPDATE(status, decided_at, superseded_at, superseded_by_request_id). NO DELETE.
//   approval_decisions  — C, A/I append-only. SELECT + INSERT only. NO UPDATE of any kind, NO DELETE.
//
// WHY A DECISION IS APPEND-ONLY. It is the record of a human exercising authority. `WORKFLOW-STATE-MACHINES` puts
// `approval.approved` in-transaction, and canon §2 says an edited approval is *"superseded, never mutated"*
// (invariant 7). A decision that can be edited afterwards cannot answer "who authorized this, and to what?".
//
// ── INVARIANT 5 AT THE SCHEMA LEVEL ──────────────────────────────────────────────────────────────────────────
// Canon does not merely state the rule, it states this mechanism: *"approval decisions are writable only through the
// approval API, which rejects non-human/non-delegated actor types AT THE SCHEMA LEVEL; worker/model actors have no
// code path to it."* `approval_decisions_decider_is_human` is that sentence. It is the third of three layers —
// P6-003a makes a worker decider inexpressible in the TYPE, a runtime guard catches JS callers, and this CHECK
// catches anything that reaches the table by a route neither of those covers. The reason for three is P6-002's
// experience: the guarantees that survived adversarial review were the structural ones.
//
// ── WHAT THIS MIGRATION DOES NOT ADD ─────────────────────────────────────────────────────────────────────────
// No payload hash, no expiry column, no revocation state. Payload-hash binding, expiry and single-use consumption
// are ADR-009 §2 and ACBP-P6-004. A request here records WHAT is proposed and under which policy version; it is not
// yet a bound, consumable token, and no column implies otherwise. `policy_id`/`policy_version` are point 2's record
// of the decision context — canon §5 point 2 is *"policy version recorded into the approval"* — not a binding.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── approval_requests ───────────────────────────────────────────────────────────────────────────────────
  await db.schema
    .createTable('approval_requests')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    // THE RUN THAT PROPOSED IT. Canon §2 binds *"requesting worker/run"*, and NOT NULL is the accountability
    // choice: an approval request nobody can trace back to the work that asked for it is a request whose context a
    // human cannot reconstruct.
    .addColumn('run_id', 'uuid', (col) => col.notNull())
    .addColumn('tool_id', 'text', (col) => col.notNull())
    .addColumn('tool_version', 'integer', (col) => col.notNull())
    // ── APPR-002's content set, verbatim from `diagrams/08`: action, reason, expected result, data, cost, risk,
    //    reversibility, preview. Every one NOT NULL, because the requirement's failure clause is *"Full-content
    //    requirement blocks incomplete requests"* — a row with a null `reason` is a row a human cannot evaluate.
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('reason', 'text', (col) => col.notNull())
    .addColumn('expected_result', 'text', (col) => col.notNull())
    .addColumn('data', 'jsonb', (col) => col.notNull())
    .addColumn('estimated_cost_credits', 'integer', (col) => col.notNull())
    .addColumn('risk_class', 'text', (col) => col.notNull())
    // DERIVED from `risk_class` by the contract and CHECKed against it below, so the two can never disagree in a
    // stored row — the combination `sensitive_irreversible` + `reversible` is the one a human must never be shown.
    .addColumn('reversibility', 'text', (col) => col.notNull())
    .addColumn('preview', 'text', (col) => col.notNull())
    .addColumn('scope', 'text', (col) => col.notNull())
    // ── POINT 2's RECORD (CDR-068 §0.2). The policy version the human decides under, version-pinned below.
    .addColumn('policy_id', 'uuid', (col) => col.notNull())
    .addColumn('policy_version', 'integer', (col) => col.notNull())
    // The point-2 evaluation itself. Nullable for the same reason `tool_calls.policy_eval_id` is: a company with no
    // usable policy produces no evaluation row (CDR-066 §6-G16), and the request must still be recordable.
    .addColumn('policy_eval_id', 'uuid')
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('decided_at', 'timestamptz')
    .addColumn('superseded_at', 'timestamptz')
    // Set when `edit_then_approve` replaces this request with a new one. Self-referential and TENANT-PINNED: one
    // company's request must never name another's as its successor.
    .addColumn('superseded_by_request_id', 'uuid')
    .addForeignKeyConstraint('approval_requests_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('approval_requests_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // TENANT-PINNED FKs THROUGHOUT, because RI checks ALWAYS bypass RLS. A single-column FK would let one company's
    // approval cite another company's run, policy or evaluation and never be caught — and canon §2's first bound
    // element is *"Company — approval from one company can never authorize another's action"*.
    .addForeignKeyConstraint('approval_requests_run_fk', ['run_id', 'company_id'], 'task_runs', ['id', 'company_id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    // VERSION-PINNED as well as tenant-pinned, exactly as `policy_evaluations` is: the stored `policy_version` is
    // guaranteed to be the version of the policy it names, rather than a copy some code path happened to write.
    .addForeignKeyConstraint('approval_requests_policy_fk', ['policy_id', 'policy_version', 'company_id'], 'policies', ['id', 'version', 'company_id'], (cb) =>
      cb.onDelete('no action').onUpdate('no action'),
    )
    .addForeignKeyConstraint('approval_requests_policy_eval_fk', ['policy_eval_id', 'company_id'], 'policy_evaluations', ['id', 'company_id'], (cb) =>
      cb.onDelete('no action').onUpdate('no action'),
    )
    // Mirrors `RISK_CLASSES` and `REVERSIBILITIES` in @acbp/contracts. Duplicated on purpose and asserted equal by a
    // test — the ACTIVITY_TYPES divergence (contracts widened without a migration) is why a silently diverging pair
    // is a booby trap rather than a convenience.
    .addCheckConstraint('approval_requests_risk_valid', sql`risk_class in ('informational', 'internal_reversible', 'external_reversible', 'sensitive_irreversible')`)
    .addCheckConstraint('approval_requests_reversibility_valid', sql`reversibility in ('reversible', 'irreversible')`)
    // THE DERIVATION, ENFORCED. Not a second opinion about reversibility — the same rule the contract applies,
    // stated where a row cannot escape it.
    .addCheckConstraint(
      'approval_requests_reversibility_matches_risk',
      sql`(risk_class = 'sensitive_irreversible' and reversibility = 'irreversible') or (risk_class <> 'sensitive_irreversible' and reversibility = 'reversible')`,
    )
    // All four canon scopes are storable so later autonomy levels are additive (canon §3); the SERVICE accepts only
    // the two MVP ones. Modelling two here and widening later would be a migration and a backfill.
    .addCheckConstraint('approval_requests_scope_valid', sql`scope in ('one_action', 'limited_batch', 'capability_category', 'bounded_operating_policy')`)
    .addCheckConstraint('approval_requests_status_valid', sql`status in ('pending', 'decided', 'superseded')`)
    // BLANK IS NOT CONTENT. NOT NULL alone would let `action = ''` through, which renders as an empty line in the
    // inbox — a human approving a blank. The contract refuses it; so does the table.
    .addCheckConstraint(
      'approval_requests_content_not_blank',
      sql`length(btrim(action)) > 0 and length(btrim(reason)) > 0 and length(btrim(expected_result)) > 0 and length(btrim(preview)) > 0 and length(btrim(tool_id)) > 0`,
    )
    // `data` must be a JSON OBJECT. An array or bare string would read as "no fields" to every consumer.
    .addCheckConstraint('approval_requests_data_is_object', sql`jsonb_typeof(data) = 'object'`)
    .addCheckConstraint('approval_requests_cost_non_negative', sql`estimated_cost_credits >= 0`)
    .addCheckConstraint('approval_requests_version_positive', sql`tool_version >= 1 and policy_version >= 1`)
    // THE STATUS AND ITS TIMESTAMPS CANNOT DISAGREE — the same honesty rule 0045 applies to `policies`. A `decided`
    // row with no decision time, or a `pending` row carrying one, is a record that cannot be read truthfully later.
    .addCheckConstraint(
      'approval_requests_status_consistent',
      sql`(status = 'pending' and decided_at is null and superseded_at is null and superseded_by_request_id is null)
          or (status = 'decided' and decided_at is not null and superseded_at is null)
          or (status = 'superseded' and superseded_at is not null)`,
    )
    // A request cannot supersede itself.
    .addCheckConstraint('approval_requests_no_self_supersede', sql`superseded_by_request_id is null or superseded_by_request_id <> id`)
    // THE COMPOSITE TARGET the decision's tenant-pinned FK needs, and the self-reference above.
    .addUniqueConstraint('approval_requests_id_company_uq', ['id', 'company_id'])
    .execute();

  // The self-reference is added after the table exists, because it targets the unique this table declares.
  await sql`alter table public.approval_requests
            add constraint approval_requests_superseded_by_fk
            foreign key (superseded_by_request_id, company_id)
            references public.approval_requests (id, company_id) on delete no action on update no action`.execute(db);

  // THE INBOX QUERY (APPR-003). Partial on `pending`, because that is the only status the inbox lists and a partial
  // index keeps decided history out of it entirely.
  await sql`create index approval_requests_inbox_idx on public.approval_requests (company_id, created_at desc) where status = 'pending'`.execute(db);
  await sql`create index approval_requests_run_idx on public.approval_requests (run_id)`.execute(db);
  await sql`create index approval_requests_policy_eval_idx on public.approval_requests (policy_eval_id) where policy_eval_id is not null`.execute(db);

  // LEAST PRIVILEGE, with exactly the mutations the lifecycle needs. The content columns are NOT among them: an
  // approval request whose action or preview could be edited after a human read it is the material-change hole
  // invariant 7 exists to close. An edit produces a NEW request (`edit_then_approve`), never a rewritten one.
  await sql`grant select, insert on public.approval_requests to ${APP_ROLE}`.execute(db);
  await sql`grant update (status, decided_at, superseded_at, superseded_by_request_id) on public.approval_requests to ${APP_ROLE}`.execute(db);

  await sql`alter table public.approval_requests enable row level security`.execute(db);
  await sql`alter table public.approval_requests force row level security`.execute(db);
  await sql`create policy approval_requests_select on public.approval_requests for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy approval_requests_insert on public.approval_requests for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  // USING *and* WITH CHECK. Without WITH CHECK an update could move a row out of the caller's tenant.
  await sql`create policy approval_requests_update on public.approval_requests for update using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY}) with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);

  // ── approval_decisions ──────────────────────────────────────────────────────────────────────────────────
  await db.schema
    .createTable('approval_decisions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('request_id', 'uuid', (col) => col.notNull())
    .addColumn('path', 'text', (col) => col.notNull())
    // ── INVARIANT 5. See the header: this column plus its CHECK is canon's "at the schema level".
    .addColumn('decider_type', 'text', (col) => col.notNull())
    .addColumn('decided_by_user_id', 'uuid', (col) => col.notNull())
    // THE INSTANT THAT WAS PASSED IN, not `now()`. The contract keeps the clock an input so a decision can be
    // re-derived from its own record; a column defaulting to `now()` would quietly undo that.
    .addColumn('decided_at', 'timestamptz', (col) => col.notNull())
    .addColumn('reason', 'text')
    .addColumn('edited_data', 'jsonb')
    .addColumn('effective_from', 'timestamptz')
    .addColumn('member_request_ids', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('approval_decisions_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('approval_decisions_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('approval_decisions_request_fk', ['request_id', 'company_id'], 'approval_requests', ['id', 'company_id'], (cb) =>
      cb.onDelete('no action').onUpdate('no action'),
    )
    .addForeignKeyConstraint('approval_decisions_user_fk', ['decided_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    // Mirrors `APPROVAL_DECISION_PATHS`. `revoke` is deliberately absent — revocation is ADR-009 §2 and P6-004.
    .addCheckConstraint('approval_decisions_path_valid', sql`path in ('approve', 'reject', 'edit_then_approve', 'schedule', 'batch_approve')`)
    // ── THE INVARIANT-5 CHECK. `worker` is the model actor the whole authority chain exists to exclude; `system` and
    //    `admin` are excluded because neither is a company member exercising their own authority (P6-003a records the
    //    reasoning and flags it as the safer reading of a canon phrase that does not name admins either way).
    .addCheckConstraint('approval_decisions_decider_is_human', sql`decider_type in ('human', 'delegated')`)
    // ── PER-PATH REQUIREMENTS, as database facts rather than only as a parse step. Each detail is what makes its
    //    path meaningful: a rejection nobody can act on, an edit with nothing edited, a schedule with no instant, a
    //    batch naming nobody. `iff`, not merely `if`: a reason on an `approve` row would be data nobody can explain.
    .addCheckConstraint('approval_decisions_reason_iff_reject', sql`(path = 'reject') = (reason is not null and length(btrim(reason)) > 0)`)
    .addCheckConstraint('approval_decisions_edit_iff_edited', sql`(path = 'edit_then_approve') = (edited_data is not null)`)
    .addCheckConstraint('approval_decisions_schedule_iff_effective', sql`(path = 'schedule') = (effective_from is not null)`)
    .addCheckConstraint('approval_decisions_batch_iff_members', sql`(path = 'batch_approve') = (member_request_ids is not null)`)
    // NON-EMPTY, not merely present: `{}` is "I edited it, changing nothing", which supersedes a request on the
    // strength of a change nobody made. `parseApprovalDecision` refuses it too; this is the same rule at the layer
    // a caller bypassing the contract still meets.
    .addCheckConstraint('approval_decisions_edited_is_object', sql`edited_data is null or (jsonb_typeof(edited_data) = 'object' and edited_data <> '{}'::jsonb)`)
    // A batch that names nobody authorizes nobody (canon — *"batch enumerates members"*).
    .addCheckConstraint(
      'approval_decisions_members_non_empty',
      sql`member_request_ids is null or (jsonb_typeof(member_request_ids) = 'array' and jsonb_array_length(member_request_ids) > 0)`,
    )
    // ONE DECISION PER REQUEST. `API-CONTRACTS` says *"Decisions idempotent per approval"*, and the database is where
    // that is cheap to guarantee: a second decision on the same request cannot be inserted, so a double-submit or a
    // retry cannot produce two contradictory authorizations for one action.
    .addUniqueConstraint('approval_decisions_request_uq', ['request_id'])
    .execute();

  await sql`create index approval_decisions_company_created_idx on public.approval_decisions (company_id, created_at desc)`.execute(db);
  await sql`create index approval_decisions_decider_idx on public.approval_decisions (decided_by_user_id)`.execute(db);

  // APPEND-ONLY, ABSOLUTELY. No UPDATE — not even column-scoped — and no DELETE. This is the record of a human
  // exercising authority; canon §2 says an edited approval is superseded, never mutated (invariant 7).
  await sql`grant select, insert on public.approval_decisions to ${APP_ROLE}`.execute(db);

  await sql`alter table public.approval_decisions enable row level security`.execute(db);
  await sql`alter table public.approval_decisions force row level security`.execute(db);
  await sql`create policy approval_decisions_select on public.approval_decisions for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy approval_decisions_insert on public.approval_decisions for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists approval_decisions_insert on public.approval_decisions`.execute(db);
  await sql`drop policy if exists approval_decisions_select on public.approval_decisions`.execute(db);
  await sql`revoke all on public.approval_decisions from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.approval_decisions_decider_idx`.execute(db);
  await sql`drop index if exists public.approval_decisions_company_created_idx`.execute(db);
  await db.schema.dropTable('approval_decisions').ifExists().execute();

  await sql`drop policy if exists approval_requests_update on public.approval_requests`.execute(db);
  await sql`drop policy if exists approval_requests_insert on public.approval_requests`.execute(db);
  await sql`drop policy if exists approval_requests_select on public.approval_requests`.execute(db);
  await sql`revoke all on public.approval_requests from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.approval_requests_policy_eval_idx`.execute(db);
  await sql`drop index if exists public.approval_requests_run_idx`.execute(db);
  await sql`drop index if exists public.approval_requests_inbox_idx`.execute(db);
  await sql`alter table public.approval_requests drop constraint if exists approval_requests_superseded_by_fk`.execute(db);
  await db.schema.dropTable('approval_requests').ifExists().execute();
}
