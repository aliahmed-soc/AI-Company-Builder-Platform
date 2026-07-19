// core/identity — module public index (ACBP-P1-002). Internal user mapping via replay-safe webhooks.
export { resolveInternalUser, resolveWithStore } from './user-resolver.js';
export type { InternalUserResolution } from './user-resolver.js';
export { applyIdentityEvent, processVerifiedIdentityEvent } from './webhook-processor.js';
export type { IdentityEventOutcome, IdentityEventProcessingResult, UserMappingStore, WebhookReceiptStore } from './webhook-processor.js';
