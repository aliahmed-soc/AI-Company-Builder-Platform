// @acbp/core — run preflight and the credit ledger (ACBP-P5-014; CDR-058; BILL-002; TASK-004; trust-critical AT-025).
//
// THE RACE IS THE TICKET. Two runs against one remaining credit must not both proceed. Everything else here is
// bookkeeping; this is the part that has to be right, and it is right because of `lockAccountForSpend` — a row lock
// taken BEFORE the balance is derived, so no two reservations for one account can ever read the same balance.
//
// THE BALANCE IS DERIVED, ALWAYS. There is no counter to drift, no cache to invalidate, and no reconciliation between
// two numbers that could disagree. `SUM(credits)` is the balance because the amounts are signed.
import { CreditRepository, TaskRunRepository, resolveOwnMembershipBootstrap, writeAuditEvent, type DatabaseClient, type AuditWriteContext, type CreditTransactionRow } from '@acbp/database';
import { signedAmount, settlementMagnitude, canAfford, decideRunSettlement, CREDITS_PER_MANUAL_RUN, creditReserved, creditSettled, type RiskClass } from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { runInAccountScope } from '../tenancy/account-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { isMemberRole } from '../members/roles.js';
import type { Logger } from '@acbp/observability';

export interface CreditOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
}

interface ScopeParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}

export interface CreditEntryDTO {
  readonly id: string;
  readonly kind: string;
  readonly credits: number;
  readonly runId: string | null;
  readonly referencesTxnId: string | null;
}

function toDTO(row: CreditTransactionRow): CreditEntryDTO {
  return { id: row.id, kind: row.kind, credits: row.credits, runId: row.run_id, referencesTxnId: row.references_txn_id };
}

// ── preflight ───────────────────────────────────────────────────────────────────────────────────────────────

/** No run id: a preflight is about the ACCOUNT's balance and the standing cost, not about one particular run. */
export type PreflightParams = ScopeParams;

export type PreflightResult =
  | {
      readonly status: 'ok';
      readonly balance: number;
      readonly cost: number;
      readonly affordable: boolean;
      /**
       * TASK-004 shows the side-effect class before the founder commits. A `RiskClass` from canon's CLOSED set — the
       * first version invented `'internal_only'`, a fifth name outside it, which is the exact drift this repo already
       * shipped one correction for. Constant for now because a run's tools are not bound until P5-006/007/008 make it
       * derivable; CDR-058 §4 records that, and `informational` is the honest value while nothing external can happen.
       */
      readonly sideEffectClass: RiskClass;
    }
  | { readonly status: 'forbidden' };

/**
 * What will this run cost, and can the account afford it? (TASK-004 — *"preflight honesty"*.)
 *
 * READ-ONLY, and deliberately NOT authoritative. It takes no lock, so the balance it reports can be stale by the time
 * the founder clicks — which is fine, because {@link reserveCredit} re-derives under a lock and is the only thing that
 * decides. A preflight that locked would hold a row open across a human's thinking time.
 */
export async function preflightRun(client: DatabaseClient, params: PreflightParams, options: CreditOptions = {}): Promise<PreflightResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<PreflightResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const balance = await new CreditRepository(scope.db).deriveBalance(scope.tenant.accountId);
      const cost = CREDITS_PER_MANUAL_RUN;
      return { status: 'ok', balance, cost, affordable: canAfford(balance, cost), sideEffectClass: 'informational' };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── reservation — the AT-025 race ───────────────────────────────────────────────────────────────────────────

export interface ReserveCreditParams extends ScopeParams {
  readonly taskRunId: string;
  /** BILL-002: *"one credit spend per key"*. Required — an unkeyed reservation cannot be made idempotent. */
  readonly idempotencyKey: string;
}

export type ReserveCreditResult =
  | { readonly status: 'ok'; readonly entry: CreditEntryDTO; readonly balanceAfter: number }
  | { readonly status: 'forbidden' }
  // The honest refusal TASK-004 asks for: the founder is told the balance and what it would have cost.
  | { readonly status: 'insufficient_credits'; readonly balance: number; readonly cost: number }
  | { readonly status: 'invalid' }
  | { readonly status: 'run_not_found' }
  // This key already reserved. NOT an error — the caller retried, and the first reservation stands.
  | { readonly status: 'already_reserved'; readonly entry: CreditEntryDTO }
  | { readonly status: 'run_already_reserved'; readonly entry: CreditEntryDTO };

/**
 * Reserve one credit for a run, atomically.
 *
 * THE ORDER IS THE WHOLE POINT:
 *   1. LOCK the account row. Everything after this is serialized per account.
 *   2. DERIVE the balance — now nothing else can be reserving against it.
 *   3. REFUSE if it will not cover the cost.
 *   4. INSERT the reservation, and only then release the lock by committing.
 *
 * Deriving before locking would be the bug: both runs read "1 credit left", both find it sufficient, both insert, and
 * the account goes to −1. That is exactly AT-025, and it is why step 1 cannot move.
 *
 * The unique index on the idempotency key is a SECOND line, not the first: it makes a retried request safe, whereas
 * the lock is what makes two DIFFERENT requests safe.
 */
export async function reserveCredit(client: DatabaseClient, params: ReserveCreditParams, options: CreditOptions = {}): Promise<ReserveCreditResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ReserveCreditResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      if (typeof params.idempotencyKey !== 'string' || params.idempotencyKey.trim() === '') return { status: 'invalid' };
      const credits = new CreditRepository(scope.db);

      // The run must exist and be this company's. RLS-confined, so a foreign run reads as absent rather than as a
      // refusal that would confirm it exists.
      const taskRun = await new TaskRunRepository(scope.db).findById(params.taskRunId);
      if (taskRun === undefined) return { status: 'run_not_found' };

      // 1. THE LOCK. Before the balance, always.
      if (!(await credits.lockAccountForSpend(scope.tenant.accountId))) return { status: 'forbidden' };

      // An earlier reservation for this run stands — a second one would charge twice for one attempt.
      const existingForRun = await credits.findReservationForRun(params.taskRunId);
      if (existingForRun !== undefined) return { status: 'run_already_reserved', entry: toDTO(existingForRun) };

      // 2. THE BALANCE, under the lock.
      const balance = await credits.deriveBalance(scope.tenant.accountId);
      const cost = CREDITS_PER_MANUAL_RUN;
      // 3. THE REFUSAL — honest, with the numbers, so the founder can act on it (TASK-004).
      if (!canAfford(balance, cost)) return { status: 'insufficient_credits', balance, cost };

      // 4. THE ENTRY. `signedAmount` owns the sign so it is never invented at a call site.
      const entry = await credits.insert({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        kind: 'reservation',
        credits: signedAmount('reservation', cost),
        runId: params.taskRunId,
        idempotencyKey: params.idempotencyKey.trim(),
        createdByUserId: params.userId,
      });
      if (entry === undefined) {
        // The idempotency index fired: this key already reserved, in a transaction that committed while we waited for
        // the lock. The first reservation stands and the caller gets it — a retry must not become a second charge.
        // BY KEY, not by run. Review pass 1: the first version re-queried by RUN, which under the lock is guaranteed
        // to be the undefined we already saw — so an ordinary client mistake (one key reused across two runs)
        // threw an internal error instead of returning a typed refusal, and already_reserved was unreachable.
        const byKey = await credits.findReservationByKey(scope.tenant.accountId, params.idempotencyKey.trim());
        if (byKey === undefined) throw new Error('credit reservation was refused but no prior reservation exists — invariant violated');
        return { status: 'already_reserved', entry: toDTO(byKey) };
      }

      await audit(scope, creditReserved({ txnId: entry.id, runId: params.taskRunId, credits: cost, balanceAfter: balance - cost }), auditCtx(options));
      return { status: 'ok', entry: toDTO(entry), balanceAfter: balance - cost };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── settlement ──────────────────────────────────────────────────────────────────────────────────────────────

export interface SettleRunParams extends ScopeParams {
  readonly taskRunId: string;
}

export type SettleRunResult =
  | { readonly status: 'ok'; readonly settlement: 'consume' | 'release'; readonly entry: CreditEntryDTO; readonly balanceAfter: number }
  | { readonly status: 'forbidden' }
  // The run is not over. Settling now would either charge for unfinished work or free a run still spending.
  | { readonly status: 'not_settleable'; readonly outcome: string }
  | { readonly status: 'no_reservation' }
  // Already consumed or released. The first settlement stands — the index guarantees there can be only one.
  | { readonly status: 'already_settled'; readonly entry: CreditEntryDTO };

/**
 * Consume or release a run's reservation, per canon's charging rules.
 *
 * THE OUTCOME IS READ FROM THE RUN, NEVER FROM THE CALLER. Review pass 1's finding: the first version took the
 * outcome as a parameter, which meant anyone holding `run:execute` could settle a SUCCEEDED run as `cancelled`, get a
 * release, and have the work for free — unlimited free execution, with a ledger showing a perfectly legible
 * reserve/release pair. Every settlement test passed because the fixtures' runs were all still `running` and the
 * assertion only ever exercised the string that was passed in. The run's own recorded state is the only thing that
 * can decide what the founder is charged.
 *
 * GENEROUS BY CANON, not by choice: every failure and every cancellation RELEASES (`USAGE-AND-BILLING §4` —
 * *"counts against quality metrics, not the customer"*). Technical usage is still recorded on those paths; it is the
 * CREDIT that goes back.
 *
 * The settlement is a NEW row referencing the reservation — never an edit of it (invariant 10). A reader can see the
 * credit was held and what became of it, which an in-place update would erase.
 */
export async function settleRun(client: DatabaseClient, params: SettleRunParams, options: CreditOptions = {}): Promise<SettleRunResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<SettleRunResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      // THE RUN DECIDES. RLS-confined, so another company's run reads as absent rather than as a settleable one.
      const taskRun = await new TaskRunRepository(scope.db).findById(params.taskRunId);
      if (taskRun === undefined) return { status: 'no_reservation' };
      const decision = decideRunSettlement(taskRun.state);
      if (decision.kind === 'hold') return { status: 'not_settleable', outcome: taskRun.state };

      const credits = new CreditRepository(scope.db);
      // Serialized with reservations for the same account, so a settlement cannot interleave with a reservation
      // deriving the balance.
      if (!(await credits.lockAccountForSpend(scope.tenant.accountId))) return { status: 'forbidden' };

      const reservation = await credits.findReservationForRun(params.taskRunId);
      if (reservation === undefined) return { status: 'no_reservation' };
      const settled = await credits.findSettlement(reservation.id);
      if (settled !== undefined) return { status: 'already_settled', entry: toDTO(settled) };

      const kind = decision.kind === 'consume' ? 'consumption' : 'release';
      // A release returns EXACTLY what was reserved — `-reservation.credits`, not a recomputed cost. Recomputing
      // would let a changed price refund more than was ever taken.
      const magnitude = Math.abs(reservation.credits);
      // D9. A CONSUMPTION MOVES NO CREDITS — the reservation already took them. Passing `magnitude` here made a
      // succeeded run write a second debit, so it cost TWO credits while a failed run cost none.
      const entry = await credits.insert({
        accountId: scope.tenant.accountId,
        companyId: reservation.company_id ?? scope.tenant.companyId,
        kind,
        credits: signedAmount(kind, settlementMagnitude(kind, magnitude)),
        runId: params.taskRunId,
        referencesTxnId: reservation.id,
        createdByUserId: params.userId,
      });
      if (entry === undefined) {
        // The settlement index fired: something settled it while we held the lock. The other outcome wins.
        const now = await credits.findSettlement(reservation.id);
        if (now === undefined) throw new Error('settlement was refused but no settlement exists — invariant violated');
        return { status: 'already_settled', entry: toDTO(now) };
      }

      const balanceAfter = await credits.deriveBalance(scope.tenant.accountId);
      // `credits` here is THE SIZE OF THE HOLD BEING SETTLED, not the settlement row's own amount — and since D9 the
      // two differ for a consumption: the row moves 0 because the reservation already took the credit, while this
      // reports the 1 that was consumed. Stated because a reader reconciling the audit trail against the ledger will
      // otherwise meet 1-against-0 on the money path and have to work out which is wrong. Neither is: `settlement`
      // says which disposal happened and `balance_after` carries the effect, so "consumed 1, 2 left" reads correctly.
      // Reporting the row's 0 instead would be accurate and useless — an audit line saying a run cost nothing.
      await audit(scope, creditSettled({ txnId: entry.id, runId: params.taskRunId, settlement: decision.kind, credits: magnitude, balanceAfter }), auditCtx(options));
      return { status: 'ok', settlement: decision.kind, entry: toDTO(entry), balanceAfter };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── the read ────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReadLedgerParams {
  readonly userId: string;
  readonly accountId: string;
  readonly limit?: number;
}

export type ReadLedgerResult =
  | { readonly status: 'ok'; readonly balance: number; readonly entries: readonly CreditEntryDTO[] }
  | { readonly status: 'forbidden' }
  | { readonly status: 'invalid_limit'; readonly max: number };

const MAX_LEDGER_PAGE = 100;

/**
 * The account's balance and recent ledger.
 *
 * ACCOUNT-OWNER ONLY (CDR-058 §2), and it runs in an ACCOUNT scope for that exact reason. Review pass 1's HIGH
 * finding: the first version ran in a COMPANY scope, so the role it checked was the caller's company-membership role,
 * not their account-membership role. A user who was a company owner but only an account viewer would have been handed
 * the whole account's ledger — every company's spending — which is precisely the disclosure this action exists to
 * prevent. The RLS predicate cannot help here: it is keyed on the account by design, so the ledger legitimately spans
 * companies and only the authorization decides. The fixtures made this untestable, because every seeded user's
 * company role equals their account role.
 *
 * `resolveOwnMembershipBootstrap` is the established primitive for an account-level action (the `portfolio:read`
 * precedent), and an unknown or absent role denies.
 */
export async function readCreditLedger(client: DatabaseClient, params: ReadLedgerParams, options: CreditOptions = {}): Promise<ReadLedgerResult> {
  const run = await runInAccountScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId },
    async (scope): Promise<ReadLedgerResult> => {
      const own = await resolveOwnMembershipBootstrap(scope.db, params.userId, params.accountId);
      const role = own !== null && isMemberRole(own.role) ? own.role : null;
      if (checkAuthorization(role, 'billing:read', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const credits = new CreditRepository(scope.db);
      // REJECT, never clamp (the CDR-017 section 8 convention). Silently shrinking a caller's request makes the
      // response disagree with what was asked for, and the caller cannot tell.
      const requested = params.limit ?? MAX_LEDGER_PAGE;
      if (!Number.isInteger(requested) || requested <= 0 || requested > MAX_LEDGER_PAGE) return { status: 'invalid_limit', max: MAX_LEDGER_PAGE };
      const limit = requested;
      const [balance, entries] = [await credits.deriveBalance(params.accountId), await credits.listForAccount(params.accountId, limit)];
      return { status: 'ok', balance, entries: entries.map(toDTO) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

function auditCtx(options: CreditOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}
function opts(options: CreditOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
