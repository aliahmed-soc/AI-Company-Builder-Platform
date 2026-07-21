// @acbp/core — personal-account provisioning use case (ACBP-P1-003; CDR-010; rewired for RLS in ACBP-P1-006).
//
// Provider-neutral: given a SERVER-VERIFIED internal user id, idempotently ensure the user's personal
// account (+ its 1:1 profile + owner membership) exist. Under FORCE RLS (CDR-013) the creation happens
// before any account context exists, so it goes through the `acbp_provision_account` SECURITY DEFINER
// bootstrap function — the ONLY approved provisioning path — which creates ONLY that server-verified user's
// personal account (owner + role are fixed inside the function; a caller cannot claim another user's
// account or choose a role). Emits an interim `account.created` structured audit event (durable append-only
// audit is ACBP-P1-008) carrying only non-PII fields.
import { provisionAccountBootstrap, type DatabaseClient } from '@acbp/database';
import type { Logger } from '@acbp/observability';

/** Outcome of ensuring a personal account. `created` is true only when THIS call inserted the account. */
export interface ProvisionResult {
  readonly accountId: string;
  readonly created: boolean;
}

/** Minimal seam so provisioning's audit orchestration is unit-testable without a real database. */
export interface AccountProvisioningStore {
  /** Idempotently ensure the user's personal account (+ profile + owner membership) exist. */
  provision(userId: string): Promise<{ readonly accountId: string; readonly created: boolean }>;
}

export interface ProvisionOptions {
  readonly correlationId?: string;
  /** Optional audit/structured logger. When omitted, provisioning is silent (still idempotent). */
  readonly logger?: Logger;
}

/**
 * Store-based provisioning (unit-testable with a fake). Ensures the account idempotently and emits
 * `account.created` ONLY when this call created it. Interim audit is a structured log — the durable
 * in-transaction audit write is ACBP-P1-008.
 */
export async function provisionPersonalAccountWithStore(
  store: AccountProvisioningStore,
  userId: string,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const { accountId, created } = await store.provision(userId);
  if (created) {
    // plan_state defaults to 'free' (CDR-010; the only value in P1-003) — matches the account.created payload.
    options.logger?.info('account.created', { metadata: { accountId, planState: 'free' } });
  }
  return { accountId, created };
}

/**
 * Ensure the personal account for an internal user using the live database client, via the
 * `acbp_provision_account` bootstrap function. Idempotent across calls and race-safe across concurrent
 * first requests (the function uses scoped ON CONFLICT on the exact P1-003/P1-004 constraints).
 */
export function provisionPersonalAccount(client: DatabaseClient, userId: string, options: ProvisionOptions = {}): Promise<ProvisionResult> {
  return provisionPersonalAccountWithStore({ provision: (uid) => provisionAccountBootstrap(client.kysely, uid) }, userId, options);
}
