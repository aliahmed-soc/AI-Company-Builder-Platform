// @acbp/contracts — strategy-option-generation contracts (ACBP-P3-001; CDR-034; STRAT-001/002; ADR-011/019).
//
// Provider-neutral shapes + PURE logic for the strategy options generated from a CONFIRMED understanding version. The
// model returns options; the gateway validates via `parseStrategyOptions` (deny-by-default). The 16-field content
// standard (PRD §11.3) is the closed, canonical field set — every option MUST carry all 16 fields, and a field the
// model cannot determine MUST be the explicit `"unknown"` sentinel (ADR-019 no fake precision), never fabricated. The
// honest fewer-than-three status is derived here from the option count (the RIGOROUS cosmetic-variant distinctness
// engine is P3-002 — this ticket records `similarity_check_result: 'pending'`). Zero-dependency leaf: no SDK/DB/framework.

/** The CLOSED, canonical 16-field option content standard (PRD §11.3, verbatim + order). NOT content-derived. */
export const STRATEGY_OPTION_FIELDS = [
  'description',
  'customer',
  'offer',
  'business_model',
  'scope',
  'benefits',
  'risks',
  'cost_range',
  'effort',
  'time_to_validate',
  'time_to_launch',
  'required_resources',
  'key_assumptions',
  'validation_method',
  'success_metrics',
  'confidence',
] as const;
export type StrategyOptionField = (typeof STRATEGY_OPTION_FIELDS)[number];

/** An option's 16-field content — every field present; an undetermined field is the labeled `UNKNOWN_FIELD` sentinel. */
export type StrategyOptionFields = Readonly<Record<StrategyOptionField, string>>;

/** The ADR-019 sentinel a field MUST carry when the model cannot determine it (labeled, never fabricated). */
export const UNKNOWN_FIELD = 'unknown';

/** ≥3 genuinely distinct options is the STRAT-001 bar; fewer is an HONEST outcome, never padded. */
export const MIN_DISTINCT_OPTIONS = 3;

/** A generation is `complete` (≥ MIN_DISTINCT_OPTIONS options) or the honest `fewer_than_three`. */
export const STRATEGY_GENERATION_STATUSES = ['complete', 'fewer_than_three'] as const;
export type StrategyGenerationStatus = (typeof STRATEGY_GENERATION_STATUSES)[number];
export function isStrategyGenerationStatus(v: unknown): v is StrategyGenerationStatus {
  return typeof v === 'string' && (STRATEGY_GENERATION_STATUSES as readonly string[]).includes(v);
}

/** The distinctness verdict. P3-001 writes `pending`; the P3-002 similarity engine sets distinct/insufficient. */
export const SIMILARITY_CHECK_RESULTS = ['pending', 'distinct', 'insufficient_distinct'] as const;
export type SimilarityCheckResult = (typeof SIMILARITY_CHECK_RESULTS)[number];
export function isSimilarityCheckResult(v: unknown): v is SimilarityCheckResult {
  return typeof v === 'string' && (SIMILARITY_CHECK_RESULTS as readonly string[]).includes(v);
}

/** Bounds (defense-in-depth against runaway output; also the DB column widths / limits in migration 0022). */
export const STRATEGY_FIELD_MAX = 2_000;
export const MAX_STRATEGY_OPTIONS = 12;
export const FEWER_REASON_MAX = 1_000;

/** The gateway output-schema ref for strategy option generation (the composition dispatches validateOutput on it). */
export const STRATEGY_OPTIONS_SCHEMA = 'strategy.options.output@1';

/** The validated output of a strategy generation: the flat 16-field options + honest status/partial/reason. */
export interface StrategyGenerationOutput {
  readonly options: readonly StrategyOptionFields[];
  readonly partial: boolean;
  readonly status: StrategyGenerationStatus;
  readonly fewerReason: string | null;
}

export type StrategyParse = { readonly ok: true; readonly value: StrategyGenerationOutput } | { readonly ok: false };

const FAIL = { ok: false } as const;

/** True IFF `o` is an object carrying EXACTLY the 16 fields, each a non-blank bounded string (deny-by-default). */
export function isCompleteOptionFields(o: unknown): o is StrategyOptionFields {
  if (typeof o !== 'object' || o === null) return false;
  const rec = o as Record<string, unknown>;
  // Reject any extra keys (no leaked/unexpected fields) and require every canonical field present + valid.
  if (Object.keys(rec).length !== STRATEGY_OPTION_FIELDS.length) return false;
  for (const f of STRATEGY_OPTION_FIELDS) {
    const v = rec[f];
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > STRATEGY_FIELD_MAX) return false;
  }
  return true;
}

/** Trim every field of a validated option (defensive normalization; keys are already exactly the 16). */
function normalizeFields(o: StrategyOptionFields): StrategyOptionFields {
  const out = {} as Record<StrategyOptionField, string>;
  for (const f of STRATEGY_OPTION_FIELDS) out[f] = o[f].trim();
  return out;
}

/**
 * Parse the model's strategy output. Accepts `{options: [{...16 fields}], partial?: boolean, fewer_reason?: string}`
 * with 0..MAX_STRATEGY_OPTIONS options, each carrying EXACTLY the 16 fields (non-blank, bounded; `"unknown"` is a
 * legal labeled value). Deny-by-default: any malformed element rejects the whole output. The status is DERIVED from
 * the option count (≥ MIN_DISTINCT_OPTIONS → `complete`, else `fewer_than_three` — the honest path). `fewer_reason`
 * is accepted only as a non-blank bounded string and is retained only for the `fewer_than_three` outcome.
 */
export function parseStrategyOptions(raw: string): StrategyParse {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return FAIL;
  }
  if (typeof root !== 'object' || root === null) return FAIL;
  const list = (root as { options?: unknown }).options;
  if (!Array.isArray(list) || list.length > MAX_STRATEGY_OPTIONS) return FAIL;
  // Optional honest `partial` flag (the model could not fully analyse). Absent → false; non-boolean → reject.
  const rawPartial = (root as { partial?: unknown }).partial;
  if (rawPartial !== undefined && typeof rawPartial !== 'boolean') return FAIL;
  const partial = rawPartial === true;
  // Optional `fewer_reason`. Absent → null; present must be a non-blank bounded string (never fabricated by us).
  const rawReason = (root as { fewer_reason?: unknown }).fewer_reason;
  if (rawReason !== undefined && (typeof rawReason !== 'string' || rawReason.trim().length === 0 || rawReason.length > FEWER_REASON_MAX)) return FAIL;

  const options: StrategyOptionFields[] = [];
  for (const raw of list) {
    if (!isCompleteOptionFields(raw)) return FAIL;
    options.push(normalizeFields(raw));
  }
  const status: StrategyGenerationStatus = options.length >= MIN_DISTINCT_OPTIONS ? 'complete' : 'fewer_than_three';
  // A reason is meaningful only when the outcome is honestly fewer-than-three.
  const fewerReason = status === 'fewer_than_three' && typeof rawReason === 'string' ? rawReason.trim() : null;
  return { ok: true, value: { options, partial, status, fewerReason } };
}

/**
 * Defensively narrow an ALREADY-VALIDATED strategy output (the gateway's `validatedOutput`, produced by
 * `parseStrategyOptions`) back to `StrategyGenerationOutput` — WITHOUT re-parsing raw text. Re-checks the load-bearing
 * invariants (every option is a complete 16-field object; the status/count are consistent), so a corrupted seam value
 * is rejected (`undefined`) rather than trusted. This is the single, safe re-entry the core use case consumes.
 */
export function narrowStrategyOutput(value: unknown): StrategyGenerationOutput | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as { options?: unknown; partial?: unknown; status?: unknown; fewerReason?: unknown };
  if (!Array.isArray(v.options) || v.options.length > MAX_STRATEGY_OPTIONS) return undefined;
  if (typeof v.partial !== 'boolean') return undefined;
  if (!isStrategyGenerationStatus(v.status)) return undefined;
  if (v.fewerReason !== null && (typeof v.fewerReason !== 'string' || v.fewerReason.length > FEWER_REASON_MAX)) return undefined;
  const options: StrategyOptionFields[] = [];
  for (const opt of v.options) {
    if (!isCompleteOptionFields(opt)) return undefined;
    options.push(opt);
  }
  // The honest status MUST be consistent with the count (no forged "complete" with < MIN options).
  const expected: StrategyGenerationStatus = options.length >= MIN_DISTINCT_OPTIONS ? 'complete' : 'fewer_than_three';
  if (v.status !== expected) return undefined;
  return { options, partial: v.partial, status: v.status, fewerReason: v.fewerReason ?? null };
}

/** The redacted, client-facing option view (approved fields only; the validated 16-field object + its ordinal). */
export interface StrategyOptionDTO {
  readonly optionId: string;
  readonly ordinal: number;
  readonly fields: StrategyOptionFields;
}

/** The redacted, client-facing generation view. No accountId, actor/membership ids, or internal errors. */
export interface StrategyGenerationDTO {
  readonly generationId: string;
  readonly companyId: string;
  readonly understandingVersion: number;
  readonly status: StrategyGenerationStatus;
  readonly optionCount: number;
  readonly fewerReason: string | null;
  readonly similarityCheckResult: SimilarityCheckResult;
  readonly modelFlaggedPartial: boolean;
  readonly options: readonly StrategyOptionDTO[];
  readonly createdAt: string;
}
