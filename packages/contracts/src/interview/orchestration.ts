// @acbp/contracts — adaptive-orchestration output contracts (ACBP-P2-005; CDR-028; DISC-001..006).
//
// The provider-neutral output shapes the model gateway validates for the three adaptive interview calls:
//   - follow-up batch generation (DISC-001 ≤3; DISC-002 use prior answers),
//   - answer-quality detection (DISC-003 vague / DISC-004 contradiction),
//   - assumption suggestion on "I don't know" (DISC-005).
// Every parser is PURE and DENY-BY-DEFAULT: malformed JSON, wrong shape, out-of-range counts, blank/over-long
// text, or unknown enum values all yield `{ok:false}` — which the gateway maps to `invalid_output` (bounded
// re-ask, never a partial accept). No provider names, no DB, no framework — zero-dependency leaf.
import type { AnswerVerdict, AssumptionSuggestion, AnswerQuality, FollowUpBatch, OutputParse } from './orchestration-types.js';

/** DISC-001: a batch is at most three questions. */
export const MAX_FOLLOWUP_BATCH = 3;
/** Bounds (defense-in-depth against runaway model output; also the DB column widths in migration 0018). */
export const FOLLOWUP_MAX_LEN = 500;
export const ANSWER_DETAIL_MAX_LEN = 1000;
export const ASSUMPTION_MAX_LEN = 1000;

/** How a persisted interview question was produced (the "flagged non-adaptive" fallback marker — DISC-002). */
export const QUESTION_SOURCES = ['adaptive', 'static_fallback'] as const;
export type QuestionSource = (typeof QUESTION_SOURCES)[number];
export function isQuestionSource(v: unknown): v is QuestionSource {
  return typeof v === 'string' && (QUESTION_SOURCES as readonly string[]).includes(v);
}

/** The closed answer-quality verdict set (DISC-003/004). */
export const ANSWER_VERDICTS = ['clear', 'vague', 'contradictory'] as const;
function isAnswerVerdict(v: unknown): v is AnswerVerdict {
  return typeof v === 'string' && (ANSWER_VERDICTS as readonly string[]).includes(v);
}

/** Opaque output-schema refs the gateway request carries; the composition dispatches validateOutput on these. */
export const INTERVIEW_FOLLOWUPS_SCHEMA = 'interview.followups.output@1';
export const ANSWER_QUALITY_SCHEMA = 'interview.answer_quality.output@1';
export const ASSUMPTION_SCHEMA = 'interview.assumption.output@1';

const FAIL = { ok: false } as const;

/** JSON.parse that never throws — returns undefined on malformed input. */
function parseJson(raw: string): unknown {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A trimmed, non-blank string within `[1, max]` characters, else undefined. */
function boundedText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t.length === 0 || t.length > max) return undefined;
  return t;
}

/**
 * Parse a generated follow-up batch. Accepts `{questions: string[]}` with 1..MAX_FOLLOWUP_BATCH bounded, non-blank
 * questions. MORE than three is REJECTED (the ≤3 rule is never silently truncated — a violation re-asks).
 */
export function parseFollowUps(raw: string): OutputParse<FollowUpBatch> {
  const root = parseJson(raw);
  if (typeof root !== 'object' || root === null) return FAIL;
  const list = (root as { questions?: unknown }).questions;
  if (!Array.isArray(list)) return FAIL;
  if (list.length < 1 || list.length > MAX_FOLLOWUP_BATCH) return FAIL;
  const questions: string[] = [];
  for (const q of list) {
    const t = boundedText(q, FOLLOWUP_MAX_LEN);
    if (t === undefined) return FAIL;
    questions.push(t);
  }
  return { ok: true, value: { questions } };
}

/**
 * Parse an answer-quality verdict. `clear` carries no detail (normalized to null). `vague`/`contradictory` REQUIRE
 * a non-blank, bounded `detail` (the clarifying prompt / conflict description); a missing detail there is rejected.
 */
export function parseAnswerQuality(raw: string): OutputParse<AnswerQuality> {
  const root = parseJson(raw);
  if (typeof root !== 'object' || root === null) return FAIL;
  const verdict = (root as { verdict?: unknown }).verdict;
  if (!isAnswerVerdict(verdict)) return FAIL;
  const rawDetail = (root as { detail?: unknown }).detail;
  if (verdict === 'clear') {
    // A clear answer must not smuggle a detail payload.
    if (rawDetail !== undefined && rawDetail !== null && boundedText(rawDetail, ANSWER_DETAIL_MAX_LEN) === undefined) return FAIL;
    return { ok: true, value: { verdict, detail: null } };
  }
  const detail = boundedText(rawDetail, ANSWER_DETAIL_MAX_LEN);
  if (detail === undefined) return FAIL;
  return { ok: true, value: { verdict, detail } };
}

/** Parse a suggested labeled assumption (DISC-005). Requires a non-blank, bounded `assumption`. */
export function parseAssumption(raw: string): OutputParse<AssumptionSuggestion> {
  const root = parseJson(raw);
  if (typeof root !== 'object' || root === null) return FAIL;
  const assumption = boundedText((root as { assumption?: unknown }).assumption, ASSUMPTION_MAX_LEN);
  if (assumption === undefined) return FAIL;
  return { ok: true, value: { assumption } };
}
