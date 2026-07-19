// @acbp/database — global identity-root repositories (ACBP-P1-002; CDR-008).
//
// These operate on the GLOBAL identity-root tables (users, identity_webhook_receipts) and are NOT
// tenant-scoped — they deliberately do NOT extend TenantRepository and establish no tenant session
// (CDR-008 #1; the webhook consumer has no tenant context). Each repository takes an executor which
// may be the base client's Kysely or a transaction handle, so the core processor can run the receipt
// insert and the user mutation in ONE transaction. Kysely parameterized queries only — no raw SQL.
import type { Kysely } from 'kysely';
import type { DatabaseSchema, UserRow, NewUser, UserUpdate, IdentityWebhookReceiptRow, NewIdentityWebhookReceipt } from './schema.js';

/** Executor accepted by the identity repositories: the base client's Kysely or a Transaction. */
export type IdentityExecutor = Kysely<DatabaseSchema>;

/** The composite provider-identity key: (provider, provider_instance_id, provider_user_id). */
export interface ProviderIdentityKey {
  readonly provider: string;
  readonly providerInstanceId: string;
  readonly providerUserId: string;
}

export class UserMappingRepository {
  readonly #db: IdentityExecutor;
  constructor(db: IdentityExecutor) {
    this.#db = db;
  }

  /** Look up the mapping row by its provider identity key, or undefined if none exists. */
  findByProviderIdentity(key: ProviderIdentityKey): Promise<UserRow | undefined> {
    return this.#db
      .selectFrom('users')
      .selectAll()
      .where('provider', '=', key.provider)
      .where('provider_instance_id', '=', key.providerInstanceId)
      .where('provider_user_id', '=', key.providerUserId)
      .executeTakeFirst();
  }

  /** Insert a new mapping row and return it (including the generated internal id). */
  insert(values: NewUser): Promise<UserRow> {
    return this.#db.insertInto('users').values(values).returningAll().executeTakeFirstOrThrow();
  }

  /** Update the mapping row identified by its provider identity key. */
  async updateByProviderIdentity(key: ProviderIdentityKey, patch: UserUpdate): Promise<void> {
    await this.#db
      .updateTable('users')
      .set(patch)
      .where('provider', '=', key.provider)
      .where('provider_instance_id', '=', key.providerInstanceId)
      .where('provider_user_id', '=', key.providerUserId)
      .execute();
  }
}

export class WebhookReceiptRepository {
  readonly #db: IdentityExecutor;
  constructor(db: IdentityExecutor) {
    this.#db = db;
  }

  /**
   * Insert a receipt, doing nothing on the (provider, provider_instance_id, event_id) primary-key
   * conflict. Returns true if THIS call inserted the row, false if it already existed. Using
   * ON CONFLICT DO NOTHING (rather than catching 23505) keeps the transaction usable under concurrent
   * duplicate delivery — the loser observes the conflict without aborting the transaction.
   */
  async insertIfNew(values: NewIdentityWebhookReceipt): Promise<boolean> {
    const res = await this.#db
      .insertInto('identity_webhook_receipts')
      .values(values)
      .onConflict((oc) => oc.columns(['provider', 'provider_instance_id', 'event_id']).doNothing())
      .executeTakeFirst();
    return (res?.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  /** Look up an existing receipt by its key (used to compare payload hashes on a duplicate). */
  find(provider: string, providerInstanceId: string, eventId: string): Promise<IdentityWebhookReceiptRow | undefined> {
    return this.#db
      .selectFrom('identity_webhook_receipts')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_instance_id', '=', providerInstanceId)
      .where('event_id', '=', eventId)
      .executeTakeFirst();
  }
}
