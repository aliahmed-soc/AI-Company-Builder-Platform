// core/stops — module public index (ACBP-P6-007; CDR-072). Cross-module imports go through this index
// (spec rule 10).
//
// ENUMERATED, not `export *`: a use case missing from here compiles, tests fine in place, and is reachable by
// nobody — which is exactly how ACBP-P6-003 shipped an approval service with no consumers.
//
// ⚠️ AND THIS MODULE THEN DID THE SAME THING ANYWAY, which is worth leaving on the record next to the warning that
// failed to prevent it. Everything below is exported and, at the time an independent review looked, called by
// NOTHING and covered by NO test — the dispatcher suite defined its own local raw-insert helper rather than using
// `activateStop`. Being exported is not being reachable, and an index that only guards the export list cannot see
// the difference. The HTTP/operator surface that will consume these is owner-gated (UI), so the binding evidence in
// the meantime is the stop-service integration suite, which drives these functions directly.
// ── AND THE WARNING ABOVE CAME TRUE A SECOND TIME, ONE LAYER OUT (ACBP-API-011; owner ruling 2026-08-19) ─────────
// `reviewHeldWork` is exported, tested, and takes a `heldWorkId` that NO exported read can produce: the queue it
// decides on is reachable only through `StopRepository.listHeld`, called privately by `clearStop` to compute a
// COUNT. So ADMIN-002's confirm-or-discard review is reachable in principle and un-drivable in practice.
//
// ACBP-API-011 proposed closing that with a `listHeldWork` read and was REFUSED at the owner gate: adding a read
// core does not have is a DOMAIN ADDITION, not the exposure that ticket was scoped to. It is filed as its own
// ticket with the consequence attached, and NO SCAFFOLDING TOWARD IT LIVES HERE — a half-built door is how the
// "exported is not reachable" defect got its second life. See docs/agent/TICKET-held-work-review-surface.md.
export { activateStop, clearStop, reviewHeldWork, readStopState, STOP_REFUSAL_REASONS } from './stop-service.js';
export type {
  StopServiceOptions,
  StopRefusalReason,
  ActivateStopParams,
  ActivateStopResult,
  ClearStopParams,
  ClearStopResult,
  ReviewHeldWorkParams,
  ReviewHeldWorkResult,
  StopScopeAvailability,
  ReadStopStateResult,
  HeldQueueCompleteness,
} from './stop-service.js';
