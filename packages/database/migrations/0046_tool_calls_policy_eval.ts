// ACBP-P6-002 — link a tool call to the policy evaluation that authorized it (CDR-067 §2-G3; APPR-009; TOOL-002).
//
// `DATA-ARCHITECTURE` L340 says a tool call *"links policy eval + approval"*, and L289 records `policy_eval_ref` as
// DEFERRED — *"as sequencing rather than omission — the engines are Phase 6's"*. P6-001 built the engine; this is
// the line those notes were waiting for.
//
// THE DIRECTION IS FORCED BY THE ORDERING, not chosen for convenience. The evaluation must complete BEFORE the
// dispatch decision (the decision takes the policy answer as an input), and the decision determines the call row's
// `outcome` — so the call is inserted after the evaluation already exists. A `policy_evaluations.tool_call_id`
// pointing the other way cannot be populated on this path, and its column comment says so.
//
// NULLABLE, DELIBERATELY. When a company has no usable policy there is no evaluation row at all (CDR-066 §6-G16),
// and the call is still recorded — as a denial. A NOT NULL column would make that refusal unrecordable, which is the
// single outcome TOOL-002 most wants recorded ("100% of tool calls have records").
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // The composite FK's target. `policy_evaluations` is keyed on `id` alone, so the tenant-pinned reference below
  // needs this — checked rather than assumed, because a missing unique fails at migration time, not review time.
  await sql`create unique index policy_evaluations_id_company_uq on public.policy_evaluations (id, company_id)`.execute(db);

  await sql`alter table public.tool_calls add column policy_eval_id uuid`.execute(db);

  // TENANT-PINNED. RI checks ALWAYS bypass RLS, so a single-column FK would let one company's tool call cite another
  // company's policy evaluation — i.e. claim it was authorized by a decision made for somebody else. On the row that
  // records what the platform allowed, that is the last place to leave that hole.
  await sql`alter table public.tool_calls
    add constraint tool_calls_policy_eval_fk
    foreign key (policy_eval_id, company_id)
    references public.policy_evaluations (id, company_id)
    on delete no action on update no action`.execute(db);

  // The audit question this answers: "which calls did this evaluation authorize?" Partial — most rows in a mature
  // system will have one, but indexing the nulls buys nothing.
  await sql`create index tool_calls_policy_eval_idx on public.tool_calls (policy_eval_id) where policy_eval_id is not null`.execute(db);

  // NO NEW GRANT. `tool_calls` already carries INSERT for `acbp_app` and the dispatcher sets this column on insert.
  // Deliberately NOT adding an UPDATE grant: a call's authorizing evaluation is fixed at the moment it is recorded,
  // and a link that could be re-pointed afterwards would let the record of WHY something was allowed be rewritten.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists public.tool_calls_policy_eval_idx`.execute(db);
  await sql`alter table public.tool_calls drop constraint if exists tool_calls_policy_eval_fk`.execute(db);
  await sql`alter table public.tool_calls drop column if exists policy_eval_id`.execute(db);
  await sql`drop index if exists public.policy_evaluations_id_company_uq`.execute(db);
}
