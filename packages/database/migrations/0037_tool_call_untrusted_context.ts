// ACBP-P5-003c — the injection boundary's denial reason (CDR-055; NFR-021; invariant 17).
//
// ALTER-ONLY. `untrusted_context` names a call that WOULD have proceeded on the trusted path and was refused solely
// because untrusted content was in the working context (`AI-AND-WORKER-ARCHITECTURE §4`'s heightened scrutiny).
// It is a distinct value rather than a reuse of `policy_unavailable` because the two send a reader to different
// places: one to look for a broken engine, the other to see the boundary doing its job.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const REASONS_WITHOUT = "'not_registered', 'no_allowlist', 'not_allowlisted', 'emergency_stopped', 'stop_unavailable', 'policy_denied', 'policy_unavailable', 'approval_invalid', 'approval_required'";
const REASONS_WITH = `${REASONS_WITHOUT}, 'untrusted_context'`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table public.tool_calls drop constraint if exists tool_calls_denial_reason_valid`.execute(db);
  // Still ONE-DIRECTIONAL (the P5-009/P5-001c lesson): a reason implies a denial, never the reverse.
  await sql.raw(
    `alter table public.tool_calls add constraint tool_calls_denial_reason_valid check (denial_reason is null or (denial_reason in (${REASONS_WITH}) and outcome = 'denied'))`,
  ).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Reversible only while no row uses the new value; a row that does would block the narrowing, which is the correct
  // behaviour — silently deleting evidence of a boundary refusal to make a rollback tidy would be worse.
  await sql`alter table public.tool_calls drop constraint if exists tool_calls_denial_reason_valid`.execute(db);
  await sql.raw(
    `alter table public.tool_calls add constraint tool_calls_denial_reason_valid check (denial_reason is null or (denial_reason in (${REASONS_WITHOUT}) and outcome = 'denied'))`,
  ).execute(db);
}
