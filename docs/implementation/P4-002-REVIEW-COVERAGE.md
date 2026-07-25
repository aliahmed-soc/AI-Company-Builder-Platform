# ACBP-P4-002 — Review coverage ledger (task model + state machine)

Independent **security + scope** review of the full P4-002 diff (`p4-002-task-state-machine` vs `main`): the closed
task state machine (`@acbp/contracts/task`), migration 0021 (`tasks` + `task_dependencies`), and the core use cases
(`@acbp/core/tasks`). Calibrated for the two load-bearing properties: **tenant isolation** (dual-keyed FORCE RLS +
least privilege) and **server-enforced state-machine correctness** (TASK-001, audit-or-nothing).

## Verdict
**PASS — no Blocker/Critical/High.** Two Low findings (both fixed) plus one accepted design note.

## Dimensions — CLEAN (confirmed)
1. **Tenant isolation / RLS.** Both tables are `ENABLE`+`FORCE` RLS, dual-keyed on BOTH `app.current_account` AND
   `app.current_company` in USING and WITH CHECK; `nullif(current_setting(...,true),'')` fails closed on a missing GUC.
   `tasks` has select/insert/update policies (update carries USING + WITH CHECK); `task_dependencies` select/insert.
   Proven real-PG: cross-company read = 0 rows, account-only = fail-closed 0 rows, cross-tenant INSERT rejected.
2. **Least privilege.** Grants are exactly `SELECT,INSERT` on both tables + a column-scoped `UPDATE(state, updated_at)`
   on `tasks` only. No table-level UPDATE, no DELETE, no grant option, no grants to any other role. SECURITY DEFINER
   allowlist stays exactly 3; no new role; `acbp_app` remains NOSUPERUSER/NOBYPASSRLS — all re-asserted.
3. **State-machine enforcement (TASK-001).** `LEGAL_TRANSITIONS` matches CDR-033 §1 verbatim; 100% pair-by-pair
   conformance test. `planTask` only attempts `draft→planned`, rejects any non-draft `from` with `illegal_transition`,
   **no state change and no audit**; the guarded `updateState` (`where id=? and state=fromState`) is race-safe.
4. **Audit / audit-or-nothing.** `task.created` is written on `scope.db` — the same transaction as the transition; an
   injected audit failure rolls back the transition (task stays `draft`, no event). Metadata is exactly `{has_milestone}`
   (the factory can carry nothing else); subject = task id; actor/account/company server-stamped; no title/description
   leak. Only `task.created` is registered; the exhaustive `AUDITED_OPERATIONS` partition keeps the no-orphan invariant.
   `createTask` intentionally writes no audit (a draft is not on the board).
5. **Immutability.** Identity/content columns are `never`-on-update in the schema types and enforced by the column-only
   grant at the DB; `task_dependencies` is append-only with UNIQUE + no-self-dep CHECK. Real-PG proves UPDATE of
   title/company_id and DELETE refused on `tasks`; UPDATE/DELETE refused on `task_dependencies`.
6. **Scope.** Implements exactly `createTask`, `planTask (draft→planned)`, `addTaskDependency`, `getTask`/`listTasks`.
   No execution/hold transitions, no credit, no policy, no worker runs; only migration 0021 (no 0022); 0001–0020
   untouched; `task_runs`/`approvals`/`policies` asserted absent. No scope creep; nothing required missing.
7. **Reset-list hygiene.** `tasks`+`task_dependencies` added (children-first, FK-safe) to the two-tenant-harness
   `ALL_TABLES` (the single source `resetSchema`/`truncateFixtures`/teardown derive from), the database existence
   assertions + cleanup, the tasks-suite drop list, and `catalog.adversarial` TENANT_TABLES + grant + column-privilege
   expectations.
8. **Error sanitization.** Use cases return bounded status enums; thrown DB/audit errors flow through `toDatabaseError`
   at the tx boundary (sanitized); the DTO exposes only approved fields; structured logs carry only ids + `hasMilestone`.

## Findings dispositioned
- **LOW-1 (fixed) — `addTaskDependency` duplicate check was TOCTOU.** The `listDependencies().some()` pre-check +
  `insertDependency` was not atomic; two concurrent identical calls both passed the check, and the loser hit the UNIQUE
  constraint → a sanitized internal error instead of the clean `{status:'duplicate'}` (no leak — a correctness/UX nit).
  **Fixed:** replaced check-then-insert with `INSERT … ON CONFLICT (task_id, depends_on_task_id) DO NOTHING RETURNING`
  in `TaskRepository.insertDependency` (returns `undefined` on conflict → the use case maps to `duplicate`); removed the
  extra `listDependencies` round-trip. Added a real-PG concurrency regression test (two racing identical edges → one
  `ok` + one `duplicate`, never a throw; exactly one edge persists).
- **LOW-2 (fixed) — `description` stored un-trimmed while `title` was trimmed.** `"  x  "` persisted with surrounding
  whitespace and the length check ran on the untrimmed value (no DB-CHECK violation reachable — a data-hygiene nit).
  **Fixed:** `description` is now trimmed consistently with `title` (blank → null; length checked on the trimmed value).
- **NOTE (accepted design, not a defect) — `milestone_id` has no FK/validation.** Milestones are P4-001 (not yet
  built), so a caller may pass an arbitrary UUID that flips `has_milestone` true. Confined to the caller's own company
  scope, non-exploitable cross-tenant, and explicitly anticipated by CDR-033 §3. Worth a follow-up FK when milestones
  land (flagged for P4-001).

## Status
Re-verified after the fixes: recursive typecheck + lint + secrets + boundaries clean; full unit suite green; real-PG
tasks migration 7/7 and core use cases 11/11 (incl. the new race-safe test), zero skips. Hosted exact-head CI is the
authoritative zero-skip run.
