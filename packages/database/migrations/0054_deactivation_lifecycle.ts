// ACBP-P7-002 — the deactivation lifecycle states, and the denial reason that names a lifecycle refusal
// (CDR-079; ACC-004, COMP-006 final; launch **Gate 14**; WORKFLOW-STATE-MACHINES §1).
//
// ALTER-ONLY. No table is created, no column is added, no data moves. Two CHECK constraints widen.
//
// ── WHY A MIGRATION IS PART OF THE GATE AND NOT A CHORE ──────────────────────────────────────────────────────
//
// The second constraint here is the one that would have bitten. `tool_calls.denial_reason` is CHECKed against a
// CLOSED vocabulary, so adding a value to `TOOL_DENIAL_REASONS` without widening the constraint does not
// degrade gracefully: the dispatcher's denial INSERT raises 23514, which ABORTS the enclosing transaction, and
// the tool call ends up neither executed nor recorded — a refusal that loses its own evidence. Migration 0037
// set the precedent when `untrusted_context` was added, and its shape is followed verbatim.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// `deleted` is deliberately ABSENT (CDR-079 §3-G6): COMP-007/ACC-005 own deletion, canon makes three different
// reachability claims for it, and the autonomous-work gate is an ALLOWLIST — it refuses a status the vocabulary
// does not contain, so nothing needs the value to be reachable in order to be safe. The CHECK stays tight to
// what is reachable, which is migration 0008's own stated rule.
const STATUSES_WITHOUT = "'draft', 'onboarding', 'active', 'paused'";
const STATUSES_WITH = `${STATUSES_WITHOUT}, 'deactivating', 'deactivated'`;

const REASONS_WITHOUT =
  "'not_registered', 'no_allowlist', 'not_allowlisted', 'emergency_stopped', 'stop_unavailable', 'policy_denied', 'policy_unavailable', 'approval_invalid', 'approval_required', 'untrusted_context'";
const REASONS_WITH = `${REASONS_WITHOUT}, 'company_not_active'`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table public.companies drop constraint if exists companies_status_valid`.execute(db);
  await sql.raw(`alter table public.companies add constraint companies_status_valid check (status in (${STATUSES_WITH}))`).execute(db);

  await sql`alter table public.tool_calls drop constraint if exists tool_calls_denial_reason_valid`.execute(db);
  // Still ONE-DIRECTIONAL, following 0037: a reason implies a denial, never the reverse.
  await sql
    .raw(`alter table public.tool_calls add constraint tool_calls_denial_reason_valid check (denial_reason is null or (denial_reason in (${REASONS_WITH}) and outcome = 'denied'))`)
    .execute(db);

  await sql`comment on constraint companies_status_valid on public.companies is
    'ACBP-P7-002: the WORKFLOW section 1 lifecycle EXCEPT deleted, which COMP-007 owns and the allowlist gate refuses without needing a vocabulary entry.'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // NARROWING IS CORRECTLY BLOCKED BY LIVE DATA. A company in `deactivating`/`deactivated`, or a tool call denied
  // for a lifecycle reason, will refuse this constraint — and that is the right behaviour: silently deleting the
  // record of a deactivation, or of a refusal the platform actually made, to make a rollback tidy would destroy
  // exactly the evidence Gate 14 exists to produce. Same posture as 0037's own `down`.
  await sql`alter table public.tool_calls drop constraint if exists tool_calls_denial_reason_valid`.execute(db);
  await sql
    .raw(`alter table public.tool_calls add constraint tool_calls_denial_reason_valid check (denial_reason is null or (denial_reason in (${REASONS_WITHOUT}) and outcome = 'denied'))`)
    .execute(db);

  await sql`alter table public.companies drop constraint if exists companies_status_valid`.execute(db);
  await sql.raw(`alter table public.companies add constraint companies_status_valid check (status in (${STATUSES_WITHOUT}))`).execute(db);
}
