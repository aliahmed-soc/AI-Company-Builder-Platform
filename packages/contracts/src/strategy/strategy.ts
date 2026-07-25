// @acbp/contracts — strategy-option-generation contracts (ACBP-P3-001/P3-002; CDR-034/CDR-035; STRAT-001/002; ADR-011/019).
//
// Provider-neutral shapes + PURE logic for the strategy options generated from a CONFIRMED understanding version. The
// model returns options; the gateway validates via `parseStrategyOptions` (deny-by-default). The 16-field content
// standard (PRD §11.3) is the closed, canonical field set — every option MUST carry all 16 fields, and a field the
// model cannot determine MUST be the explicit `"unknown"` sentinel (ADR-019 no fake precision), never fabricated. The
// STRAT-001 similarity check (`dedupeByDistinctness`, ACBP-P3-002/CDR-035) rejects near-duplicates (options matching on
// customer/offer/business_model) and yields the `distinct`/`insufficient_distinct` verdict. Zero-dependency leaf: no SDK/DB/framework.

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

/** Bounds for the optional AI recommendation (ACBP-P3-003; CDR-036; STRAT-004). */
export const RATIONALE_MAX = 4_000;
export const SENSITIVITIES_MAX = 4_000;
/** The gateway output-schema ref for the strategy recommendation. */
export const STRATEGY_RECOMMENDATION_SCHEMA = 'strategy.recommend.output@1';

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
  // A fewer-than-three reason is meaningful ONLY on the fewer-than-three outcome (parseStrategyOptions nulls it for
  // `complete`); reject an inconsistent already-parsed value rather than trust it.
  if (v.status === 'complete' && v.fewerReason !== null && v.fewerReason !== undefined) return undefined;
  return { options, partial: v.partial, status: v.status, fewerReason: v.fewerReason ?? null };
}

// ── Distinctness check (ACBP-P3-002; CDR-035; STRAT-001) ─────────────────────────────────────────────────
/**
 * The three axes that make two options GENUINELY DISTINCT (PRD J-07 "options differ on customer/offer/model"). Two
 * options are near-duplicates (cosmetic variants — "the same plan with different titles") IFF they match on ALL three.
 */
export const DISTINCTNESS_AXES = ['customer', 'offer', 'business_model'] as const satisfies readonly StrategyOptionField[];

/** Normalize an axis value for distinctness comparison: case-fold, trim, collapse internal whitespace. */
function normalizeAxisValue(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The normalized 3-axis distinctness key of an option (equal keys ⇒ near-duplicates). */
export function distinctnessKey(fields: StrategyOptionFields): string {
  // A NUL join avoids axis-boundary collisions (e.g. "a"/"bc" vs "ab"/"c").
  return DISTINCTNESS_AXES.map((axis) => normalizeAxisValue(fields[axis])).join('\u0000');
}

export interface DistinctnessResult {
  /** The genuinely-distinct option set — the first representative of each distinctness group, in model order. */
  readonly distinct: readonly StrategyOptionFields[];
  /** `distinct` when ≥ MIN_DISTINCT_OPTIONS genuinely-distinct options exist, else `insufficient_distinct`. */
  readonly result: SimilarityCheckResult;
  /** How many options were rejected as near-duplicates (cosmetic variants). */
  readonly duplicatesRejected: number;
}

/**
 * The STRAT-001 similarity check: reject near-duplicates (cosmetic variants). Groups options by their normalized
 * 3-axis distinctness key, KEEPS the first representative of each group (model ordering preserved), and reports
 * `distinct` (≥3 genuinely-distinct groups) or `insufficient_distinct`. Deterministic, model-free (no metering).
 */
export function dedupeByDistinctness(options: readonly StrategyOptionFields[]): DistinctnessResult {
  const seen = new Set<string>();
  const distinct: StrategyOptionFields[] = [];
  for (const opt of options) {
    const key = distinctnessKey(opt);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(opt);
  }
  const result: SimilarityCheckResult = distinct.length >= MIN_DISTINCT_OPTIONS ? 'distinct' : 'insufficient_distinct';
  return { distinct, result, duplicatesRejected: options.length - distinct.length };
}

// ── Optional AI recommendation (ACBP-P3-003; CDR-036; STRAT-004) ─────────────────────────────────────────
/**
 * The SHAPE-validated recommendation output (the gateway validator's result — no option-count context yet). A model
 * that cannot give a defensible recommendation returns `recommendedOrdinal: null` (honest abstain, STRAT-004).
 */
export interface StrategyRecommendationOutput {
  readonly recommendedOrdinal: number | null;
  readonly rationale: string | null;
  readonly sensitivities: string | null;
}

export type StrategyRecommendationParse = { readonly ok: true; readonly value: StrategyRecommendationOutput } | { readonly ok: false };

/**
 * SHAPE-parse the model's recommendation output. Accepts `{recommended_ordinal: int|null, rationale: string|null,
 * sensitivities: string|null}`. Deny-by-default: a wrong-typed field rejects the whole output (`ok:false` → the gateway
 * marks it `invalid_output`). A well-formed abstain (`recommended_ordinal: null`) is VALID. The option-range + non-blank
 * checks that decide whether a recommendation is actually SHOWN are applied by `resolveRecommendation` (needs the option
 * count), mirroring the parseStrategyOptions / narrowStrategyOutput split.
 */
export function parseStrategyRecommendation(raw: string): StrategyRecommendationParse {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return FAIL;
  }
  if (typeof root !== 'object' || root === null) return FAIL;
  const r = root as { recommended_ordinal?: unknown; rationale?: unknown; sensitivities?: unknown };
  const ord = r.recommended_ordinal;
  const recommendedOrdinal = ord === null || ord === undefined ? null : ord;
  if (recommendedOrdinal !== null && (typeof recommendedOrdinal !== 'number' || !Number.isInteger(recommendedOrdinal))) return FAIL;
  const rationale = r.rationale === null || r.rationale === undefined ? null : r.rationale;
  if (rationale !== null && typeof rationale !== 'string') return FAIL;
  const sensitivities = r.sensitivities === null || r.sensitivities === undefined ? null : r.sensitivities;
  if (sensitivities !== null && typeof sensitivities !== 'string') return FAIL;
  return { ok: true, value: { recommendedOrdinal, rationale, sensitivities } };
}

/**
 * Defensively narrow an ALREADY-VALIDATED recommendation output (the gateway's `validatedOutput`, produced by
 * `parseStrategyRecommendation`) back to `StrategyRecommendationOutput` — WITHOUT re-parsing raw text. Rejects a
 * corrupted seam value (`undefined`). This is the single, safe re-entry the core use case consumes (mirrors
 * `narrowStrategyOutput`).
 */
export function narrowStrategyRecommendation(value: unknown): StrategyRecommendationOutput | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as { recommendedOrdinal?: unknown; rationale?: unknown; sensitivities?: unknown };
  const ord = v.recommendedOrdinal ?? null;
  if (ord !== null && (typeof ord !== 'number' || !Number.isInteger(ord))) return undefined;
  const rationale = v.rationale ?? null;
  if (rationale !== null && typeof rationale !== 'string') return undefined;
  const sensitivities = v.sensitivities ?? null;
  if (sensitivities !== null && typeof sensitivities !== 'string') return undefined;
  return { recommendedOrdinal: ord, rationale, sensitivities };
}

/** A resolved, SHOWABLE recommendation — one in-range option + a non-blank bounded rationale + sensitivities. */
export interface ResolvedRecommendation {
  readonly recommendedOrdinal: number;
  readonly rationale: string;
  readonly sensitivities: string;
}

/**
 * Resolve a shape-validated output to a SHOWABLE recommendation, or `null` (STRAT-004 "absent a defensible rationale, no
 * recommendation is shown" — DENY-BY-DEFAULT). A recommendation is shown ONLY when the model named exactly one option
 * that EXISTS in the generation's distinct set (ordinal in `[0, optionCount)`), AND supplied a non-blank bounded
 * rationale, AND a non-blank bounded sensitivities. Any miss (or an explicit abstain) → `null`. Pure; never fabricates.
 */
export function resolveRecommendation(output: StrategyRecommendationOutput, optionCount: number): ResolvedRecommendation | null {
  const { recommendedOrdinal, rationale, sensitivities } = output;
  if (recommendedOrdinal === null || !Number.isInteger(recommendedOrdinal) || recommendedOrdinal < 0 || recommendedOrdinal >= optionCount) return null;
  if (typeof rationale !== 'string' || rationale.trim().length === 0 || rationale.length > RATIONALE_MAX) return null;
  if (typeof sensitivities !== 'string' || sensitivities.trim().length === 0 || sensitivities.length > SENSITIVITIES_MAX) return null;
  return { recommendedOrdinal, rationale: rationale.trim(), sensitivities: sensitivities.trim() };
}

/** The redacted, client-facing recommendation view (approved fields only; advisory — references one option). */
export interface StrategyRecommendationDTO {
  readonly recommendationId: string;
  readonly recommendedOptionId: string;
  readonly recommendedOrdinal: number;
  readonly rationale: string;
  readonly sensitivities: string;
  readonly createdAt: string;
}

// ── Owner decision: select / edit / combine / reject + phase-limited approval (ACBP-P3-004; CDR-037; STRAT-003/005) ──
/** The CLOSED set of owner decision modes (STRAT-003). `request another` reuses `strategy:generate`, not a mode here. */
export const SELECTION_MODES = ['select', 'edit', 'combine', 'reject'] as const;
export type StrategySelectionMode = (typeof SELECTION_MODES)[number];
export function isStrategySelectionMode(v: unknown): v is StrategySelectionMode {
  return typeof v === 'string' && (SELECTION_MODES as readonly string[]).includes(v);
}

/** The CLOSED phase-scope set (STRAT-005, verbatim: "approve only the FIRST PHASE … rather than the WHOLE PLAN"). */
export const PHASE_SCOPES = ['first_phase', 'whole_plan'] as const;
export type StrategyPhaseScope = (typeof PHASE_SCOPES)[number];
export function isStrategyPhaseScope(v: unknown): v is StrategyPhaseScope {
  return typeof v === 'string' && (PHASE_SCOPES as readonly string[]).includes(v);
}

/** Bounds for the reject-all captured reasons. */
export const REASONS_MAX = 4_000;

/** A caller's decision request over a generation's options (user-supplied — NOT model output). */
export interface StrategyDecisionRequest {
  readonly mode: string;
  readonly selectedOrdinal?: number | null;
  readonly chosenFields?: unknown;
  readonly phaseScope?: string | null;
  readonly reasons?: string | null;
}

/** A validated, normalized decision (deny-by-default per-mode shape). Phase scope is meaningful only for non-reject. */
export type ValidatedStrategyDecision =
  | { readonly mode: 'select'; readonly selectedOrdinal: number; readonly phaseScope: StrategyPhaseScope | null }
  | { readonly mode: 'edit'; readonly selectedOrdinal: number | null; readonly chosenFields: StrategyOptionFields; readonly phaseScope: StrategyPhaseScope | null }
  | { readonly mode: 'combine'; readonly chosenFields: StrategyOptionFields; readonly phaseScope: StrategyPhaseScope | null }
  | { readonly mode: 'reject'; readonly reasons: string };

export type StrategyDecisionParse = { readonly ok: true; readonly value: ValidatedStrategyDecision } | { readonly ok: false };

/**
 * Validate an owner decision request against the per-mode shape (CDR-037 §3). Deny-by-default:
 *   - `select`   → `selectedOrdinal` in `[0, optionCount)`; no `chosenFields`/`reasons`.
 *   - `edit`     → `chosenFields` is a valid 16-field object (`isCompleteOptionFields`); `selectedOrdinal` optional
 *                  (the base option, in range); no `reasons`.
 *   - `combine`  → `chosenFields` is a valid 16-field object; no `selectedOrdinal`/`reasons`.
 *   - `reject`   → `reasons` a non-blank bounded string; no `selectedOrdinal`/`chosenFields`/`phaseScope`.
 * `phaseScope` (select/edit/combine only) must be a valid enum when present. edit/combine options are USER-SUPPLIED and
 * re-validated by the P3-001 contract — no model call (CDR-037 §6-G3). Any shape mismatch → `ok:false`.
 */
export function validateStrategyDecision(req: StrategyDecisionRequest, optionCount: number): StrategyDecisionParse {
  if (!isStrategySelectionMode(req.mode)) return FAIL;
  const ordinalInRange = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < optionCount;
  const phase = req.phaseScope ?? null;
  if (phase !== null && !isStrategyPhaseScope(phase)) return FAIL;

  if (req.mode === 'select') {
    if (!ordinalInRange(req.selectedOrdinal)) return FAIL;
    if (req.chosenFields !== undefined && req.chosenFields !== null) return FAIL;
    if (req.reasons !== undefined && req.reasons !== null) return FAIL;
    return { ok: true, value: { mode: 'select', selectedOrdinal: req.selectedOrdinal, phaseScope: phase } };
  }
  if (req.mode === 'edit' || req.mode === 'combine') {
    if (!isCompleteOptionFields(req.chosenFields)) return FAIL;
    if (req.reasons !== undefined && req.reasons !== null) return FAIL;
    const fields = normalizeFields(req.chosenFields);
    if (req.mode === 'edit') {
      // The base option is optional but, if given, must be in range.
      if (req.selectedOrdinal !== undefined && req.selectedOrdinal !== null && !ordinalInRange(req.selectedOrdinal)) return FAIL;
      return { ok: true, value: { mode: 'edit', selectedOrdinal: req.selectedOrdinal ?? null, chosenFields: fields, phaseScope: phase } };
    }
    if (req.selectedOrdinal !== undefined && req.selectedOrdinal !== null) return FAIL; // combine names no single base
    return { ok: true, value: { mode: 'combine', chosenFields: fields, phaseScope: phase } };
  }
  // reject
  if (typeof req.reasons !== 'string' || req.reasons.trim().length === 0 || req.reasons.length > REASONS_MAX) return FAIL;
  if (req.selectedOrdinal !== undefined && req.selectedOrdinal !== null) return FAIL;
  if (req.chosenFields !== undefined && req.chosenFields !== null) return FAIL;
  if (req.phaseScope !== undefined && req.phaseScope !== null) return FAIL; // phase scope is meaningless for reject
  return { ok: true, value: { mode: 'reject', reasons: req.reasons.trim() } };
}

/** The redacted, client-facing selection view (approved fields only). References an option/holds the chosen fields. */
export interface StrategySelectionDTO {
  readonly selectionId: string;
  readonly mode: StrategySelectionMode;
  readonly selectedOptionId: string | null;
  readonly chosenFields: StrategyOptionFields | null;
  readonly phaseScope: StrategyPhaseScope | null;
  readonly reasons: string | null;
  readonly createdAt: string;
}

/** The maximum length of an owner-supplied decision rationale (CDR-038 §6-G2). */
export const RATIONALE_MAX_DECISION = 4_000;

/**
 * The bounded, owner-supplied rationale on a decision record (ACBP-P3-005; STRAT-006 "…and rationale"). OPTIONAL: a
 * missing rationale must never make a decision silently unrecorded, so this normalizes to `null` rather than failing.
 * Returns `undefined` ONLY when the supplied value is present but unusable (non-string or over-long) — a deny-by-default
 * signal the caller surfaces as `invalid`.
 */
export function normalizeDecisionRationale(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  // Bound the NORMALIZED value (trim first): surrounding whitespace is not content, so it must not push an otherwise
  // acceptable rationale over the limit. The stored value is always the trimmed one the DB CHECK sees.
  const trimmed = v.trim();
  if (trimmed.length > RATIONALE_MAX_DECISION) return undefined;
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The redacted, client-facing decision-record view (ACBP-P3-005; STRAT-006). Immutable and timestamped; links the
 * understanding version + the options considered (via the generation) + the selection it hardens. Carries no accountId,
 * actor id, or internal state.
 */
export interface DecisionDTO {
  readonly decisionId: string;
  readonly generationId: string;
  readonly selectionId: string;
  /**
   * The hardened selection's mode, snapshot at record time. Surfaced so a consumer can tell a rejection from a positive
   * decision WITHOUT re-reading the selection (the latest selection may already be a different one). The P4-001
   * planning gate keys off a NON-reject decision (CDR-038 §6-G1) — a rejection never unlocks planning.
   */
  readonly mode: StrategySelectionMode;
  readonly understandingVersion: number;
  readonly optionsConsideredCount: number;
  readonly rationale: string | null;
  readonly createdAt: string;
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
  /** The latest advisory AI recommendation over these options, or null when none has been made / it abstained (P3-003). */
  readonly recommendation: StrategyRecommendationDTO | null;
  /** The owner's latest decision over these options (select/edit/combine/reject), or null when none yet (P3-004). */
  readonly selection: StrategySelectionDTO | null;
  /** The latest immutable decision RECORD hardening that selection, or null when none has been recorded (P3-005). */
  readonly decision: DecisionDTO | null;
  readonly createdAt: string;
}
