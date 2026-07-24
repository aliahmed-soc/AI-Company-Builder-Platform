// @acbp/contracts — provider-neutral typed-memory contract (ACBP-P2-006; CDR-024; MEM-001/MEM-003;
// DATA-ARCHITECTURE §3). Transport- and provider-neutral; zero-dependency.
//
// Defines WHAT a typed memory item is at the contract level: the CLOSED 8-type enum, the 6-value provenance
// source_type enum, the closed confirmation-state set, the TYPE-BY-SOURCE-PATH rule (a generated claim can
// never be stored as a user_fact — MEM-001), the bounded submission validation, and the redacted DTO. It knows
// nothing about storage (append-only rows, CompanyScope) — that lives in @acbp/database / @acbp/core.
import { validationError } from '../errors.js';
import type { PublicErrorEnvelope } from '../errors.js';

/**
 * The CLOSED, canonical set of 8 memory item types (MEM-001; DATA-ARCHITECTURE §3). Anything else is rejected
 * ("untyped writes rejected"). The type is set by the SOURCE PATH, not by content (see {@link maySourceProduceType}).
 */
export type MemoryType = 'user_fact' | 'user_preference' | 'constraint' | 'ai_assumption' | 'research_finding' | 'approved_decision' | 'measured_outcome' | 'correction';
export const MEMORY_TYPES: readonly MemoryType[] = ['user_fact', 'user_preference', 'constraint', 'ai_assumption', 'research_finding', 'approved_decision', 'measured_outcome', 'correction'];
export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value);
}

/** The CLOSED provenance source types (MEM-003; DATA-ARCHITECTURE §3). Every item carries a resolvable source. */
export type MemorySourceType = 'interview_answer' | 'user_edit' | 'task_result' | 'model_generation' | 'imported_document' | 'system_measurement';
export const MEMORY_SOURCE_TYPES: readonly MemorySourceType[] = ['interview_answer', 'user_edit', 'task_result', 'model_generation', 'imported_document', 'system_measurement'];
export function isMemorySourceType(value: unknown): value is MemorySourceType {
  return typeof value === 'string' && (MEMORY_SOURCE_TYPES as readonly string[]).includes(value);
}

/** The confirmation-state lifecycle (UNDER-004). Items are created `proposed`; advancing is M3 (P2-008/P2-009). */
export type MemoryConfirmationState = 'proposed' | 'accepted' | 'validated' | 'invalidated';
export const MEMORY_CONFIRMATION_STATES: readonly MemoryConfirmationState[] = ['proposed', 'accepted', 'validated', 'invalidated'];
export const INITIAL_MEMORY_CONFIRMATION_STATE: MemoryConfirmationState = 'proposed';

/** A source is a USER source iff the founder authored the claim (the only paths that may carry a stated fact). */
const USER_SOURCE_TYPES: readonly MemorySourceType[] = ['interview_answer', 'user_edit'];

/**
 * TYPE-BY-SOURCE-PATH rule (MEM-001; backlog "Generated claims never stored as user_fact"). The load-bearing,
 * canonical constraint: `user_fact` and `user_preference` are STATED-BY-THE-USER categories and may ONLY come
 * from a user source (`interview_answer` / `user_edit`); a non-user source (`model_generation`, `task_result`,
 * `system_measurement`, `imported_document`) can NEVER produce them. The other six types carry a semantic
 * category independent of provenance and are unconstrained by source. Deny-by-default at the boundary.
 */
export function maySourceProduceType(sourceType: MemorySourceType, type: MemoryType): boolean {
  if (type === 'user_fact' || type === 'user_preference') return USER_SOURCE_TYPES.includes(sourceType);
  return true;
}

export const MEMORY_CONTENT_MAX = 10_000;
export const MEMORY_SOURCE_REF_MAX = 256;

/** A validated create submission (the type is proven consistent with the source path). */
export interface MemorySubmission {
  readonly type: MemoryType;
  readonly content: string;
  readonly sourceType: MemorySourceType;
  readonly sourceRef: string;
  readonly confidence: number | null;
}

/**
 * Validate a caller memory-item submission (pure). Rejects: an unknown type ("untyped writes rejected"), an
 * unknown source_type, a type inconsistent with the source path (a generated claim as `user_fact`), empty/over-
 * long content, an empty/over-long `source_ref` (every item MUST carry a resolvable link — MEM-003), or a
 * confidence outside [0,1]. Returns the normalized submission or a bounded validation envelope. Content and
 * source_ref are verbatim (not trimmed).
 */
export function validateMemorySubmission(input: { type: unknown; content?: unknown; sourceType: unknown; sourceRef?: unknown; confidence?: unknown }): { readonly ok: true; readonly value: MemorySubmission } | { readonly ok: false; readonly error: PublicErrorEnvelope } {
  const fail = (message: string, field: string): { ok: false; error: PublicErrorEnvelope } => ({ ok: false, error: validationError({ message, fields: [field] }).toPublic() });
  if (!isMemoryType(input.type)) return fail('Memory type is invalid.', 'type');
  if (!isMemorySourceType(input.sourceType)) return fail('Memory source type is invalid.', 'sourceType');
  if (!maySourceProduceType(input.sourceType, input.type)) return fail('This source cannot produce this memory type.', 'type');
  if (typeof input.content !== 'string' || input.content.length === 0) return fail('Memory content is required.', 'content');
  if (input.content.length > MEMORY_CONTENT_MAX) return fail('Memory content is too long.', 'content');
  if (typeof input.sourceRef !== 'string' || input.sourceRef.length === 0) return fail('A resolvable source_ref is required.', 'sourceRef');
  if (input.sourceRef.length > MEMORY_SOURCE_REF_MAX) return fail('source_ref is too long.', 'sourceRef');
  let confidence: number | null = null;
  if (input.confidence !== undefined && input.confidence !== null) {
    if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      return fail('Confidence must be a number in [0, 1].', 'confidence');
    }
    confidence = input.confidence;
  }
  return { ok: true, value: { type: input.type, content: input.content, sourceType: input.sourceType, sourceRef: input.sourceRef, confidence } };
}

/** The redacted, client-facing memory item view (CDR-024 §3). No accountId, actor ids, or internal detail. */
export interface MemoryItemDTO {
  readonly memoryItemId: string;
  readonly type: MemoryType;
  readonly content: string;
  readonly sourceType: MemorySourceType;
  readonly sourceRef: string;
  readonly confidence: number | null;
  readonly confirmationState: MemoryConfirmationState;
  /** The id of the item that supersedes this one, or null when current. */
  readonly supersededBy: string | null;
  readonly createdAt: string;
}
