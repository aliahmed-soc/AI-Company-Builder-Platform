// core/understanding — public index (ACBP-P2-008; CDR-029). Cross-module imports go through this index (spec rule 10).
export {
  generateUnderstanding,
  formatMemoryForPrompt,
  buildUnderstandingRequest,
  type GenerateUnderstandingParams,
  type UnderstandingGenerationDeps,
  type UnderstandingGenerationOptions,
  type GenerateUnderstandingResult,
  type UnderstandingDocumentDTO,
  type UnderstandingSectionDTO,
  type UnderstandingItemDTO,
} from './understanding-generation.js';
// ACBP-API-013 — the READ the module shipped without. Four writes and a gate existed; nothing returned the
// document, so ACBP-FE-009 was Blocked-API. Added on an explicit owner ruling (2026-08-19), unlike the
// structurally identical `listHeldWork` which was refused on ACBP-API-011 — see the file header.
export { readCurrentUnderstanding, type ReadUnderstandingParams, type ReadUnderstandingResult } from './understanding-read.js';
export {
  recordUnderstandingReview,
  confirmUnderstanding,
  correctUnderstanding,
  isCurrentUnderstandingConfirmed,
  STRATEGY_DEPENDENT_COUNT,
  type UnderstandingReviewOptions,
  type RecordReviewParams,
  type RecordReviewResult,
  type UnderstandingReviewDTO,
  type ConfirmParams,
  type ConfirmResult,
  type CorrectParams,
  type CorrectResult,
  type GateParams,
  type GateResult,
} from './understanding-review.js';
