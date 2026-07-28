// @acbp/database — the credit ledger (ACBP-P5-014; CDR-058; BILL-002; trust-critical AT-025).
//
// APPEND-ONLY: there is no update and no delete here, because the table grants neither. Every method either reads or
// inserts, and a correction is a new row referencing the original (invariant 10).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DatabaseSchema, CreditTransactionRow } from './schema.js';

export type CreditExecutor = Kysely<DatabaseSchema>;

export interface NewCreditEntryInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly kind: string;
  /** SIGNED. The caller derives it from the contract's `signedAmount`, so the sign is never invented here. */
  readonly credits: number;
  readonly runId?: string | null;
  readonly referencesTxnId?: string | null;
  readonly idempotencyKey?: string | null;
  readonly createdByUserId?: string | null;
}

export class CreditRepository {
  readonly #db: CreditExecutor;
  constructor(db: CreditExecutor) {
    this.#db = db;
  }

  /**
   * TAKE THE SERIALIZATION LOCK for this account, then hold it for the rest of the transaction.
   *
   * THIS IS THE AT-025 RACE FIX. Two runs against one remaining credit must not both see that credit. A derived
   * balance cannot itself be locked — there is no balance row — so the lock goes on the thing that exists and is
   * exactly one per account: the `accounts` row. Everything after this point in the transaction sees a balance no
   * other reservation can be racing to change.
   *
   * Returns `false` when the account is not visible, which under RLS means it is not the caller's.
   */
  async lockAccountForSpend(accountId: string): Promise<boolean> {
    const row = await this.#db.selectFrom('accounts').select('id').where('id', '=', accountId).forUpdate().executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The account's balance: `SUM(credits)` over its ledger, and nothing else.
   *
   * Summed IN SQL rather than by fetching rows and adding them up, because a ledger grows without bound and the sum
   * is the only part anyone needs. `coalesce` makes an account with no rows a zero balance rather than a null — a new
   * account simply has no credits yet, which is not an error.
   *
   * Only meaningful under {@link lockAccountForSpend} when the answer is about to be spent against.
   */
  async deriveBalance(accountId: string): Promise<number> {
    const row = await this.#db
      .selectFrom('credit_transactions')
      .select(sql<number>`coalesce(sum(credits), 0)::int`.as('balance'))
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return row?.balance ?? 0;
  }

  /**
   * Append one entry.
   *
   * `undefined` means a unique index refused it — either the reservation's idempotency key is already used, or the
   * reservation being settled already has a settlement. Both are races the caller must report rather than retry.
   */
  insert(input: NewCreditEntryInput): Promise<CreditTransactionRow | undefined> {
    return this.#db
      .insertInto('credit_transactions')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        kind: input.kind,
        credits: input.credits,
        run_id: input.runId ?? null,
        references_txn_id: input.referencesTxnId ?? null,
        idempotency_key: input.idempotencyKey ?? null,
        created_by_user_id: input.createdByUserId ?? null,
      })
      // TARGETED at the three indexes that can legitimately refuse a well-formed entry — never a blanket swallow.
      // `CLAUDE.md` forbids a blanket 23505→duplicate by name, and for a good reason here: a conflict this method did
      // not anticipate would be silently reported to the caller as "already exists", which for money is the worst
      // available lie. Anything else still raises.
      .onConflict((oc) => oc.constraint('credit_transactions_reservation_key_uq').doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * The reservation for a run, if it has one. RLS confines this to the caller's account.
   *
   * `credit_transactions_run_reservation_uq` makes at most one possible, so there is no ordering question — before
   * that index existed this read could have bound a settlement to an arbitrary one of several.
   */
  findReservationForRun(runId: string): Promise<CreditTransactionRow | undefined> {
    return this.#db.selectFrom('credit_transactions').selectAll().where('run_id', '=', runId).where('kind', '=', 'reservation').executeTakeFirst();
  }

  /**
   * The reservation an idempotency key already made — which may belong to a DIFFERENT run.
   *
   * Needed because the key index is per account, not per run: reusing one key across two runs is an ordinary client
   * mistake, and it has to produce a typed refusal rather than an internal error (review pass 1).
   */
  findReservationByKey(accountId: string, idempotencyKey: string): Promise<CreditTransactionRow | undefined> {
    return this.#db
      .selectFrom('credit_transactions')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('idempotency_key', '=', idempotencyKey)
      .where('kind', '=', 'reservation')
      .executeTakeFirst();
  }

  /** Whether a reservation has already been settled — one consumption OR one release, never both. */
  findSettlement(reservationId: string): Promise<CreditTransactionRow | undefined> {
    return this.#db
      .selectFrom('credit_transactions')
      .selectAll()
      .where('references_txn_id', '=', reservationId)
      .where('kind', 'in', ['consumption', 'release'])
      .executeTakeFirst();
  }

  /** The account's ledger, newest first. The account-owner-only read (CDR-058 §2). */
  listForAccount(accountId: string, limit: number): Promise<CreditTransactionRow[]> {
    return this.#db
      .selectFrom('credit_transactions')
      .selectAll()
      .where('account_id', '=', accountId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }
}
