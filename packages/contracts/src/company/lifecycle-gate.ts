// @acbp/contracts — may this company do autonomous work? (ACBP-P7-002; CDR-079 §3; launch **Gate 14**;
// ACC-004, COMP-006 final; WORKFLOW-STATE-MACHINES §1 invariant 16.)
//
// ── WHAT THIS REPLACES, AND WHY THE REPLACEMENT LOOKS DIFFERENT ───────────────────────────────────────────────
//
// `canPickUpAutonomousWork(status: CompanyStatus)` was correct, tested twice, and had ZERO PRODUCTION CALLERS.
// Its docstring claimed it was "the single truth a scheduler/worker consults before opening a run"; nothing
// consulted it. A green integration test named "pause blocks new autonomous-work pickup" called it directly on a
// value, so it proved the predicate and nothing about production. Pausing a company was a LABEL, NOT A CONTROL.
//
// Three shape changes follow from that, and each is load-bearing rather than cosmetic:
//
//   1. IT TAKES ROWS, NOT A TYPED STATUS. The old signature took `CompanyStatus`, so the type system asserted the
//      input was always one of four known values — and a function that cannot be handed an unrecognised value
//      cannot fail closed on one. The value comes off a database row.
//   2. IT ANSWERS FOR BOTH LEVELS. ACC-004 stops autonomous work for an ACCOUNT; COMP-006 for a COMPANY. One
//      function answers both, so no call site can consult one and forget the other.
//   3. IT DISTINGUISHES "NOT ACTIVE" FROM "COULD NOT READ", because an operator needs to tell a deliberate
//      deactivation from a should-be-impossible missing row.

/**
 * A company or account row as read, carrying whatever the database had in `status`.
 *
 * `unknown`, DELIBERATELY. Typing this as `CompanyStatus`/`AccountStatus` is the failure mode, not a tidiness
 * win: TypeScript exhaustiveness would then convince a reviewer that an unrecognised runtime value is
 * impossible, which is exactly what a widened CHECK constraint, a later migration, or a corrupt row violates.
 * The in-repo precedent is deliberate and identical in purpose — `StopRecord.scope` is typed `string`, not
 * `StopScope`, so a stored value the union has never heard of reaches the evaluator and is refused.
 */
export interface LifecycleRow {
  readonly status: unknown;
}

/**
 * Why autonomous work was refused. FOR OBSERVABILITY ONLY — it must never re-enter the decision, and no caller
 * may branch on it to permit something.
 *
 * `*_unreadable` is a genuinely different fact from `*_not_active`: the first says the platform could not
 * establish the lifecycle state, the second says it established it and the answer was no.
 */
export type AutonomousWorkRefusal = 'account_unreadable' | 'account_not_active' | 'company_unreadable' | 'company_not_active';

export type AutonomousWorkDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: AutonomousWorkRefusal };

/** The one status at either level under which autonomous work may proceed. */
const ACTIVE = 'active';

/**
 * May autonomous work START for this company, under this account?
 *
 * AN ALLOWLIST, WRITTEN POSITIVELY: allowed if and only if both statuses are exactly `'active'`. This is canon's
 * own phrasing — `WORKFLOW-STATE-MACHINES.md:72` states the precondition as *"stop-state clear; company
 * active"*, and `diagrams/06:10` writes the same thing with a `+` — and it is not a style preference. It buys
 * three properties a denylist cannot:
 *
 *   * FAIL-CLOSED ON UNRECOGNISED VALUES FALLS OUT BY CONSTRUCTION. `'deleted'`, a status from a future
 *     migration, a case variant, stray whitespace, a non-string, `null` — every one refuses, and there is no
 *     branch anyone can forget to write. A denylist leaves the next state added silently PERMITTED.
 *   * `deleted` NEEDS NO VOCABULARY ENTRY (CDR-079 §3-G6). Canon makes three different reachability claims for
 *     it, so its transition set cannot be written down without picking a winner — and it does not have to be.
 *   * THE TWO LEVELS COMBINE AS A LOGICAL AND, NEVER A CASCADE (§3-G3). Account deactivation performs no cascade
 *     UPDATE of `companies.status`, so there is no half-finished walk: a deactivated account refuses at every one
 *     of its companies from the instant its row commits. `companies.status` stays truthful about the COMPANY's
 *     own lifecycle (COMP-008), and the composite answer is what refuses.
 *
 * A NON-ANSWER IS A REFUSAL (§3-G5). An absent row — `undefined` — refuses as `*_unreadable`, because a row that
 * is not there is not an answer. A read that THROWS is deliberately not handled here and must not be caught by
 * the caller: in PostgreSQL a failed statement aborts the enclosing transaction, so a caught-and-converted
 * refusal would try to write its own denial row and fail with `25P02` — the identical trap CDR-075 §3-G8 hit with
 * `23505`. Letting it propagate fails the whole operation, which is the correct fail-closed outcome for free.
 *
 * THE ACCOUNT IS EVALUATED FIRST (§3-G4). When both levels are non-active the reported reason names the ACCOUNT,
 * because that is the broader cause and the one an operator must fix first — reporting the company would send
 * them to fix the wrong thing. Same reasoning as CDR-075's `limit_scope`.
 *
 * ENFORCED BY: `lifecycle-gate.test.ts`, whose "has NO input that yields `allowed: true` with anything other than
 * the two exact strings" asserts the allowlist property over a sweep rather than by example.
 *
 * PURE AND TOTAL: no clock, no I/O, no exceptions, and no caller-injectable seam (§3-G7). This function is NEVER
 * to be installed in a scope primitive — not `runInCompanyScope`, `elevateToCompanyScope`,
 * `withTenantTransaction` or `writeAuditEvent` (§3-G8). `elevateToCompanyScope` is `select('id')` today, which
 * reads as the natural home for a status predicate and is the single most destructive place to put one: it would
 * refuse provisioning and deadlock company creation permanently, and it would refuse the export path that ADR-002
 * makes the ownership guarantee.
 */
export function mayStartAutonomousWork(company: LifecycleRow | undefined, account: LifecycleRow | undefined): AutonomousWorkDecision {
  if (account === undefined || account === null) return { allowed: false, reason: 'account_unreadable' };
  if (account.status !== ACTIVE) return { allowed: false, reason: 'account_not_active' };
  if (company === undefined || company === null) return { allowed: false, reason: 'company_unreadable' };
  if (company.status !== ACTIVE) return { allowed: false, reason: 'company_not_active' };
  return { allowed: true };
}
