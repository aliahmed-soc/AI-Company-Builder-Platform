// @acbp/contracts — the strategy worker's output contract (ACBP-P5-007; CDR-062; WORK-003; STRAT-002). Zero-dep, PURE.
//
// The backlog's failure clause is the whole ticket: **"Insufficient input = specific request."**
//
// A strategy worker handed too little has three tempting ways out, and all three are worse than useless:
//   PAD    — compare models it cannot actually distinguish (the 16-field standard met in form, violated in substance);
//   GUESS  — fill fields with plausible values (the fake precision ADR-019 forbids);
//   SHRUG  — say "insufficient information" (which returns the problem to the founder unchanged).
//
// So the output is a CLOSED two-shape union with no third member, and each shape has to earn its acceptance.
import { STRATEGY_OPTION_FIELDS, isCompleteOptionFields, type StrategyOptionFields } from '../strategy/strategy.js';

/** The gateway output-schema ref for a business-model comparison. */
export const COMPARISON_SCHEMA = 'strategy.comparison.output@1';

/** A comparison compares. One model is not a comparison; a worker that could only characterise one must ASK. */
export const MIN_COMPARED_MODELS = 2;
/** Beyond this it is a survey, not a decision aid. */
export const MAX_COMPARED_MODELS = 6;
/** Beyond this the "specific request" has become a questionnaire. */
export const MAX_INPUT_REQUESTS = 10;
/** Bound on each free-text field of a request. */
export const REQUEST_TEXT_MAX = 1_000;
/** Bound on a compared model's name. */
export const MODEL_NAME_MAX = 200;

/** One business model in the comparison, carrying the full STRAT-002 16-field standard. */
export interface ComparedModel {
  readonly name: string;
  readonly fields: StrategyOptionFields;
}

/**
 * One thing the worker needs before it can compare anything.
 *
 * ALL THREE PARTS ARE REQUIRED, and that is what makes the request *specific* rather than a shrug with structure.
 * `field` is what is missing; `why` is why this comparison needs it (so the founder can judge whether to supply it or
 * change the question); `example` is what a usable answer looks like (so they know what "enough" means). Drop any one
 * and the founder is back to guessing what the system wants.
 */
export interface InputRequest {
  readonly field: string;
  readonly why: string;
  readonly example: string;
}

/** A comparison, or a request. Never both, never neither (CDR-062 G1). */
export type ComparisonOutcome =
  | { readonly kind: 'comparison'; readonly models: readonly ComparedModel[] }
  | { readonly kind: 'insufficient_input'; readonly missing: readonly InputRequest[] };

export type ComparisonRefusal =
  | 'unknown_shape'
  | 'not_a_comparison'
  | 'too_many_models'
  | 'invalid_model'
  | 'duplicate_model'
  | 'incomplete_fields'
  | 'vague_request'
  | 'too_many_requests'
  | 'duplicate_request';

export type ComparisonParse = { readonly ok: true; readonly outcome: ComparisonOutcome } | { readonly ok: false; readonly reason: ComparisonRefusal; readonly index: number | null };

function present(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

const fail = (reason: ComparisonRefusal, index: number | null): { ok: false; reason: ComparisonRefusal; index: number | null } => ({ ok: false, reason, index });

/**
 * Parse a strategy-worker output.
 *
 * TOTAL over `unknown` — this is a model's structured output and the declared type is only a promise. TYPED refusals
 * rather than throws, because the caller's job on a refusal is to fail the task honestly.
 *
 * NOTE ON `UNKNOWN_FIELD`: a field carrying the ADR-019 `unknown` sentinel PASSES, inherited from
 * `isCompleteOptionFields`. That is deliberate and load-bearing — if the labelled gap were rejected, the only way to
 * satisfy the standard would be to invent a value, which is the exact failure the standard exists to prevent. The
 * property is pinned by a test, not by anything in this function: review pass 1 removed a `void UNKNOWN_FIELD;`
 * statement whose comment claimed it made the dependency visible. It made nothing visible and guaranteed nothing —
 * had `isCompleteOptionFields` started rejecting the sentinel, that line would still have compiled and the comment
 * would still have claimed otherwise.
 */
export function parseComparisonOutput(output: unknown): ComparisonParse {
  if (typeof output !== 'object' || output === null) return fail('unknown_shape', null);
  const candidate = output as { kind?: unknown; models?: unknown; missing?: unknown };

  if (candidate.kind === 'comparison') {
    if (!Array.isArray(candidate.models)) return fail('unknown_shape', null);
    const raw = candidate.models as readonly unknown[];
    if (raw.length < MIN_COMPARED_MODELS) return fail('not_a_comparison', null);
    if (raw.length > MAX_COMPARED_MODELS) return fail('too_many_models', null);

    const seen = new Set<string>();
    const models: ComparedModel[] = [];
    for (const [index, entry] of raw.entries()) {
      if (typeof entry !== 'object' || entry === null) return fail('invalid_model', index);
      const m = entry as { name?: unknown; fields?: unknown };
      if (!present(m.name, MODEL_NAME_MAX)) return fail('invalid_model', index);
      // Compared case-insensitively on the trimmed name: "Subscription" and "subscription " are one model wearing
      // two labels, and presenting them as a comparison is the padding failure with extra steps.
      const key = m.name.trim().toLowerCase();
      if (seen.has(key)) return fail('duplicate_model', index);
      seen.add(key);
      // REUSED, not restated: `isCompleteOptionFields` is the single definition of the 16-field standard, so a change
      // there cannot leave this worker checking a different standard from the rest of the platform.
      if (!isCompleteOptionFields(m.fields)) return fail('incomplete_fields', index);
      models.push({ name: m.name, fields: m.fields });
    }
    return { ok: true, outcome: { kind: 'comparison', models } };
  }

  if (candidate.kind === 'insufficient_input') {
    if (!Array.isArray(candidate.missing)) return fail('unknown_shape', null);
    const raw = candidate.missing as readonly unknown[];
    // AN EMPTY LIST IS THE SHRUG. "Insufficient input" with nothing asked for hands the problem back unchanged,
    // which is precisely what "= specific request" forbids.
    if (raw.length === 0) return fail('vague_request', null);
    if (raw.length > MAX_INPUT_REQUESTS) return fail('too_many_requests', null);

    const asked = new Set<string>();
    const missing: InputRequest[] = [];
    for (const [index, entry] of raw.entries()) {
      if (typeof entry !== 'object' || entry === null) return fail('vague_request', index);
      const r = entry as { field?: unknown; why?: unknown; example?: unknown };
      if (!present(r.field, REQUEST_TEXT_MAX) || !present(r.why, REQUEST_TEXT_MAX) || !present(r.example, REQUEST_TEXT_MAX)) return fail('vague_request', index);
      const key = r.field.trim().toLowerCase();
      if (asked.has(key)) return fail('duplicate_request', index);
      asked.add(key);
      missing.push({ field: r.field, why: r.why, example: r.example });
    }
    return { ok: true, outcome: { kind: 'insufficient_input', missing } };
  }

  return fail('unknown_shape', null);
}

/**
 * Render a comparison as markdown — the artifact's bytes.
 *
 * One section per model, every one of the sixteen fields shown including the ones marked `unknown`. Hiding the
 * unknowns would make the document look more complete than the analysis behind it, which is the same dishonesty as
 * inventing the values.
 *
 * FIELDS ARE EMITTED IN `STRATEGY_OPTION_FIELDS` ORDER, not in whatever order the parsed object happens to carry.
 * Review pass 1: the first version iterated `Object.entries`, which follows the model's own key order. Two identical
 * comparisons whose JSON keys arrived in different orders would then render different bytes, hash differently, and
 * become two artifacts — so content-addressed idempotence (CDR-060 G3) actually depends on this being deterministic,
 * quite apart from the PRD specifying the order.
 */
export function renderComparisonMarkdown(title: string, models: readonly ComparedModel[]): string {
  const lines: string[] = [`# ${title}`, '', `Comparing ${models.length} business models.`, ''];
  for (const model of models) {
    lines.push(`## ${model.name}`, '');
    for (const field of STRATEGY_OPTION_FIELDS) lines.push(`- **${field}**: ${model.fields[field]}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
