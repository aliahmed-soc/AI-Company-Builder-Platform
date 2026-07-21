// @acbp/core — personal-account provisioning use case (ACBP-P1-003; CDR-010).
//
// Provider-neutral: given a SERVER-VERIFIED internal user id, idempotently ensure the user's personal
// account (and its 1:1 profile) exist. Called from the authenticated web path on first sign-in — never
// from the identity webhook path (CDR-008 keeps webhooks users-only). The account/profile inserts are
// race-safe (ON CONFLICT DO NOTHING, scoped to the exact constraints) so concurrent first requests
// converge to one account. Emits an interim `account.created` structured audit event (durable
// append-only audit is ACBP-P1-008) carrying only non-PII fields (account id + plan state).
import { withTransaction, AccountRepository, AccountProfileRepository, type DatabaseClient } from '@acbp/database';
import type { Logger } from '@acbp/observability';

/** Outcome of ensuring a personal account. `created` is true only when THIS call inserted the account. */
export interface ProvisionResult {
  readonly accountId: string;
  readonly created: boolean;
}

/** Minimal persistence seam so provisioning is unit-testable without a real database. */
export interface AccountProvisioningStore {
  insertAccountIfAbsent(values: { readonly created_by_user_id: string }): Promise<{ readonly row: { readonly id: string; readonly plan_state: string }; readonly inserted: boolean }>;
  insertProfileIfAbsent(values: { readonly account_id: string }): Promise<{ readonly row: { readonly account_id: string }; readonly inserted: boolean }>;
}

export interface ProvisionOptions {
  readonly correlationId?: string;
  /** Optional audit/structured logger. When omitted, provisioning is silent (still idempotent). */
  readonly logger?: Logger;
}

/**
 * Store-based provisioning (unit-testable with fakes). Ensures the account then its 1:1 profile, both
 * idempotently. Emits `account.created` ONLY when this call created the account. Returns the account id
 * and whether it was newly created. Interim audit is a structured log — the durable in-transaction
 * audit write is ACBP-P1-008; a rare commit-failure-after-log yields at most a spurious info line.
 */
export async function provisionPersonalAccountWithStore(
  store: AccountProvisioningStore,
  userId: string,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const account = await store.insertAccountIfAbsent({ created_by_user_id: userId });
  // A pre-existing account may already have its profile; insertIfAbsent no-ops in that case.
  await store.insertProfileIfAbsent({ account_id: account.row.id });
  if (account.inserted) {
    options.logger?.info('account.created', { metadata: { accountId: account.row.id, planState: account.row.plan_state } });
  }
  return { accountId: account.row.id, created: account.inserted };
}

/**
 * Ensure the personal account for an internal user using the live database client. The account and its
 * profile are created in ONE transaction, so a failure leaves neither. Idempotent across calls and
 * race-safe across concurrent first requests.
 */
export function provisionPersonalAccount(client: DatabaseClient, userId: string, options: ProvisionOptions = {}): Promise<ProvisionResult> {
  return withTransaction(
    client,
    (tx) => {
      const accounts = new AccountRepository(tx.kysely);
      const profiles = new AccountProfileRepository(tx.kysely);
      const store: AccountProvisioningStore = {
        insertAccountIfAbsent: (v) => accounts.insertIfAbsent(v),
        insertProfileIfAbsent: (v) => profiles.insertIfAbsent(v),
      };
      return provisionPersonalAccountWithStore(store, userId, options);
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );
}
