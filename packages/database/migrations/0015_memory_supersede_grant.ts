// ACBP-P2-010 — the memory-browser EDIT (versioned supersede) privilege (CDR-025 §3). ADDITIVE grant migration
// — migrations 0001–0014 are untouched, NO table/column/policy is added or changed, NO SECURITY DEFINER, no new
// role. It grants the restricted `acbp_app` role a NARROW column-level UPDATE on exactly `memory_items
// .superseded_by` (the 0012 `interview_sessions` column-level-UPDATE precedent), so an owner EDIT can set the
// forward pointer on the superseded row — while `content`/`type`/`source_type`/`source_ref`/`confidence`/
// `confirmation_state`/identity columns stay IMMUTABLE to the app role (no content overwrite; canon "never
// destructive overwrite").
//
// The DELETE sub-feature's grant/column is deliberately NOT here — it is behind the CDR-025 §0 deletion-semantics
// owner gate and lands in its own migration once ratified.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // The narrow column-level UPDATE privilege (only `superseded_by` is writable).
  await sql`grant update (superseded_by) on public.memory_items to ${APP_ROLE}`.execute(db);
  // …and the matching dual-keyed UPDATE policy — under FORCE RLS an UPDATE with no policy matches nothing. Both
  // USING (the row must be in the caller's scope) and WITH CHECK (the identity keys are unchanged — the column
  // grant already forbids touching them) require account AND company, same fail-closed shape as select/insert.
  await sql`
    create policy memory_items_update on public.memory_items for update
      using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
      with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists memory_items_update on public.memory_items`.execute(db);
  await sql`revoke update (superseded_by) on public.memory_items from ${APP_ROLE}`.execute(db);
}
