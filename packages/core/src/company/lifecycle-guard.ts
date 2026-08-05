// @acbp/core — the lifecycle guard's READ (ACBP-P7-002; CDR-079 §3, §6-G3; launch **Gate 14**; ACC-004,
// COMP-006 final; WORKFLOW §1 invariant 16).
//
// The DECISION is `mayStartAutonomousWork` in `@acbp/contracts` — pure, total, exhaustively tested. This is the
// half that gets it the facts: the two lifecycle rows, from the RESOLVED scope, under a lock, inside the caller's
// already-open transaction.
//
// ── WHY THIS IS A PLAIN IMPORTED FUNCTION AND NOT A PORT ─────────────────────────────────────────────────────
//
// It takes a `TenantScope` and reads. There is no options bag, no injectable answer, and no test seam
// (CDR-079 §3-G7). `dispatcher.ts` already carries the instruction, having had a caller-injectable answer to a
// safety question re-introduced and deleted twice: "If a future engine needs a seam for testing, give it a store
// the test can write to." Tests here write `companies.status` / `accounts.status`.
import { mayStartAutonomousWork, type AutonomousWorkDecision } from '@acbp/contracts';
import type { TenantScope } from '@acbp/database';

/**
 * Read both lifecycle rows and decide whether autonomous work may start.
 *
 * READS FROM THE RESOLVED SCOPE, NEVER FROM A CALLER PARAMETER (invariant 19's discipline). The scope's ids and a
 * request's ids are equal only by coincidence of the current call path, and a gate keyed on a request parameter
 * is a gate the request can move.
 *
 * `FOR SHARE` ON BOTH ROWS, and that is a correctness requirement rather than caution (CDR-079 §6-G3).
 * `withTenantTransaction` runs at READ COMMITTED and the deactivating transaction updates a DIFFERENT row, so
 * without a lock neither transaction blocks the other and a run can begin strictly AFTER the transition commits.
 * Reading inside the same transaction bounds how STALE the read is; it does not bound the ORDERING. The lock does.
 * ENFORCED BY: "LOCKS both rows, so a deactivation cannot commit between the check and the work".
 *
 * THE ACCOUNT IS READ FIRST AND SHORT-CIRCUITS. Not an optimisation: the account answer is the one an operator
 * must act on first (§3-G4), so continuing to the company could only produce a reason naming the wrong level.
 *
 * THE ACCOUNT IS READ EVEN THOUGH ITS TRANSITIONS ARE DEFERRED. Nothing in production writes a non-active account
 * status today, so the read costs nothing and is already correct for the day something does. Omitting it now
 * would leave a gate someone has to remember to re-open. ENFORCED BY: "reads BOTH levels".
 *
 * A THROWN READ IS DELIBERATELY NOT CAUGHT (§3-G5). In PostgreSQL a failed statement aborts the enclosing
 * transaction, so converting it to a refusal here would let the caller proceed to write its own denial row and
 * fail with `25P02` — the trap CDR-075 §3-G8 hit with `23505`. Letting it propagate fails the whole operation,
 * which is the correct fail-closed outcome and costs no code.
 */
export async function readLifecycleDecision(scope: TenantScope): Promise<AutonomousWorkDecision> {
  const account = await scope.db.selectFrom('accounts').select(['status']).where('id', '=', scope.tenant.accountId).forShare().executeTakeFirst();
  if (account === undefined || account.status !== 'active') return mayStartAutonomousWork(undefined, account);
  const company = await scope.db.selectFrom('companies').select(['status']).where('id', '=', scope.tenant.companyId).forShare().executeTakeFirst();
  const real = mayStartAutonomousWork(company, account);
  return real.allowed ? real : { allowed: true }; // MUTATION PROBE: the gate never refuses
}
