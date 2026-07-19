// @acbp/core — transactional, idempotent identity webhook processor (ACBP-P1-002; CDR-007/008).
//
// Receives an ALREADY-VERIFIED provider-neutral event (verification is the adapter/route's job) and
// converges internal state in ONE database transaction: durable receipt + user mutation commit
// atomically, or nothing does. Ordering is last-provider-write-wins on the provider updated_at, with
// the event id as a deterministic tie-breaker for equal timestamps (NOT a claim that ids are
// chronological). No provider SDK is imported here (boundary-clean).
import {
  withTransaction,
  UserMappingRepository,
  WebhookReceiptRepository,
  type DatabaseClient,
  type ProviderIdentityKey,
  type UserRow,
  type NewUser,
  type UserUpdate,
  type NewIdentityWebhookReceipt,
  type IdentityWebhookReceiptRow,
} from '@acbp/database';
import type { VerifiedIdentityWebhookEvent } from '@acbp/contracts';

/** Terminal outcome of processing a verified identity event. */
export type IdentityEventOutcome = 'applied' | 'duplicate' | 'stale' | 'deleted_identity_noop' | 'security_conflict';
export interface IdentityEventProcessingResult {
  readonly outcome: IdentityEventOutcome;
}

/** Minimal store seams so the convergence logic is unit-testable without a real database. */
export interface UserMappingStore {
  findByProviderIdentity(key: ProviderIdentityKey): Promise<UserRow | undefined>;
  insert(values: NewUser): Promise<UserRow>;
  updateByProviderIdentity(key: ProviderIdentityKey, patch: UserUpdate): Promise<void>;
}
export interface WebhookReceiptStore {
  insertIfNew(values: NewIdentityWebhookReceipt): Promise<boolean>;
  find(provider: string, providerInstanceId: string, eventId: string): Promise<IdentityWebhookReceiptRow | undefined>;
}

type UpsertEvent = Extract<VerifiedIdentityWebhookEvent, { type: 'user.created' | 'user.updated' }>;
type DeleteEvent = Extract<VerifiedIdentityWebhookEvent, { type: 'user.deleted' }>;

function keyOf(event: VerifiedIdentityWebhookEvent): ProviderIdentityKey {
  return { provider: event.provider, providerInstanceId: event.providerInstanceId, providerUserId: event.providerUserId };
}
function receiptOf(event: VerifiedIdentityWebhookEvent): NewIdentityWebhookReceipt {
  return {
    provider: event.provider,
    provider_instance_id: event.providerInstanceId,
    event_id: event.eventId,
    event_type: event.type,
    occurred_at: event.occurredAt,
    ordering_timestamp: event.orderingTimestamp,
    payload_sha256: event.payloadSha256,
  };
}
function toMs(v: Date | string): number {
  return v instanceof Date ? v.getTime() : Date.parse(String(v));
}
/**
 * True when `event` is newer than the stored row: strictly greater ordering timestamp, OR equal
 * ordering timestamp with a lexicographically greater event id (a deterministic convergence
 * tie-breaker, NOT an assertion that provider event ids are chronological).
 */
function isNewer(event: VerifiedIdentityWebhookEvent, existing: UserRow): boolean {
  const inc = Date.parse(event.orderingTimestamp);
  const cur = toMs(existing.provider_updated_at);
  if (inc > cur) return true;
  if (inc < cur) return false;
  return event.eventId > (existing.last_event_id ?? '');
}

async function convergeUpsert(users: UserMappingStore, event: UpsertEvent): Promise<IdentityEventOutcome> {
  const key = keyOf(event);
  const existing = await users.findByProviderIdentity(key);
  if (existing === undefined) {
    await users.insert({
      provider: event.provider,
      provider_instance_id: event.providerInstanceId,
      provider_user_id: event.providerUserId,
      primary_email: event.user.primaryEmail,
      email_verified: event.user.emailVerified,
      status: 'active',
      provider_created_at: event.user.providerCreatedAt ?? null,
      provider_updated_at: event.orderingTimestamp,
      last_event_id: event.eventId,
    });
    return 'applied';
  }
  if (existing.status === 'deleted') return 'deleted_identity_noop'; // no automatic resurrection (CDR-008 #3)
  if (!isNewer(event, existing)) return 'stale';
  await users.updateByProviderIdentity(key, {
    status: 'active',
    primary_email: event.user.primaryEmail,
    email_verified: event.user.emailVerified,
    provider_updated_at: event.orderingTimestamp,
    last_event_id: event.eventId,
    updated_at: new Date(),
  });
  return 'applied';
}

async function convergeDelete(users: UserMappingStore, event: DeleteEvent): Promise<IdentityEventOutcome> {
  const key = keyOf(event);
  const existing = await users.findByProviderIdentity(key);
  const now = new Date();
  if (existing === undefined) {
    // Delete-before-create tombstone: prevents a delayed create/update from resurrecting the identity.
    await users.insert({
      provider: event.provider,
      provider_instance_id: event.providerInstanceId,
      provider_user_id: event.providerUserId,
      primary_email: null,
      email_verified: false,
      status: 'deleted',
      provider_created_at: null,
      provider_updated_at: event.orderingTimestamp,
      last_event_id: event.eventId,
      deleted_at: now,
    });
    return 'applied';
  }
  if (!isNewer(event, existing)) return 'stale';
  await users.updateByProviderIdentity(key, {
    status: 'deleted',
    deleted_at: existing.deleted_at ?? now, // keep original deletion time when advancing an existing tombstone
    primary_email: null,
    email_verified: false,
    provider_updated_at: event.orderingTimestamp,
    last_event_id: event.eventId,
    updated_at: now,
  });
  return 'applied';
}

/**
 * Apply one verified event against the given stores. Receipt-first: on a receipt-key conflict, the
 * SAME payload hash is an idempotent duplicate no-op; a DIFFERENT hash is a security conflict (no user
 * mutation, existing receipt untouched). Otherwise converge the user. Pure enough to unit-test with
 * fakes; the transactional wrapper is {@link processVerifiedIdentityEvent}.
 */
export async function applyIdentityEvent(users: UserMappingStore, receipts: WebhookReceiptStore, event: VerifiedIdentityWebhookEvent): Promise<IdentityEventOutcome> {
  const inserted = await receipts.insertIfNew(receiptOf(event));
  if (!inserted) {
    const existing = await receipts.find(event.provider, event.providerInstanceId, event.eventId);
    if (existing !== undefined && existing.payload_sha256 === event.payloadSha256) return 'duplicate';
    return 'security_conflict';
  }
  return event.type === 'user.deleted' ? convergeDelete(users, event) : convergeUpsert(users, event);
}

/**
 * Process a verified event in one transaction: receipt + user mutation commit atomically, or roll
 * back together. Unexpected database failures surface as sanitized PlatformErrors (withTransaction).
 */
export function processVerifiedIdentityEvent(
  client: DatabaseClient,
  event: VerifiedIdentityWebhookEvent,
  options: { readonly correlationId?: string } = {},
): Promise<IdentityEventProcessingResult> {
  return withTransaction(
    client,
    async (tx) => {
      const outcome = await applyIdentityEvent(new UserMappingRepository(tx.kysely), new WebhookReceiptRepository(tx.kysely), event);
      return { outcome };
    },
    options,
  );
}
