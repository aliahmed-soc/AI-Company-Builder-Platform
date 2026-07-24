// @acbp/core — adaptive-orchestration decision logic (ACBP-P2-005; CDR-028; DISC-001..006).
//
// PURE decision functions (no DB, no network) — the DISC rules that turn a model-gateway RESULT into what the
// orchestrator persists. Kept separate from the scoped use cases so the rules are exhaustively unit-tested:
//   - DISC-001/002: adaptive batch when generation succeeds; the static fallback bank (flagged non-adaptive) when
//     it fails or returns a malformed payload — honest degradation, never a silent adaptive-looking result.
//   - DISC-006: a truthful, deterministic "why we ask" rationale (not model-generated, so it can never hallucinate).
//   - DISC-003/004: pass a validated vague/contradiction verdict through; FAIL-OPEN on a detection outage (treat as
//     clear) so a model outage never blocks the founder from answering.
//   - DISC-005: surface a validated assumption, or null when generation fails (the skip is still recorded).
import { MAX_FOLLOWUP_BATCH, type AnswerVerdict, type ModelGatewayResult, type QuestionSource } from '@acbp/contracts';

export interface PlannedQuestion {
  readonly prompt: string;
  readonly rationale: string;
}
export interface FollowUpPlan {
  readonly questions: readonly PlannedQuestion[];
  readonly source: QuestionSource;
}
export interface ResolvedQuality {
  readonly verdict: AnswerVerdict;
  readonly detail: string | null;
}

/** The static, non-adaptive fallback bank (≤3, DISC-001). Generic business-discovery questions used only when
 *  adaptive generation fails — persisted flagged `static_fallback` so the degradation is never hidden. */
export const STATIC_FALLBACK_BANK: readonly string[] = [
  'In one or two sentences, what does your business do?',
  'Who is your primary customer, and what problem do you solve for them?',
  'What are the two or three biggest constraints or risks you are facing right now?',
];

/** A truthful, deterministic "why we ask" (DISC-006) — names the focus area, never model-generated. */
export function batchRationale(focusArea: string): string {
  const fa = focusArea.trim().length > 0 ? focusArea.trim() : 'your business';
  return `To understand ${fa}, we're asking a few focused follow-up questions based on your previous answers.`.slice(0, 1000);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/** Narrow the gateway's validated follow-up output to 1..3 non-blank question strings (defensive re-check). */
function validFollowUpQuestions(validatedOutput: unknown): string[] | undefined {
  const rec = asRecord(validatedOutput);
  if (rec === undefined || !Array.isArray(rec['questions'])) return undefined;
  const qs = rec['questions'];
  if (qs.length < 1 || qs.length > MAX_FOLLOWUP_BATCH) return undefined;
  const out: string[] = [];
  for (const q of qs) {
    if (typeof q !== 'string' || q.trim().length === 0) return undefined;
    out.push(q);
  }
  return out;
}

/**
 * Choose the batch to persist. A successful, well-formed generation → the adaptive questions (each with the
 * batch rationale). Any error OR a malformed payload → the static fallback bank flagged `static_fallback`.
 */
export function planFollowUpBatch(result: ModelGatewayResult, focusArea: string): FollowUpPlan {
  if (result.outcome === 'ok') {
    const questions = validFollowUpQuestions(result.validatedOutput);
    if (questions !== undefined) {
      const rationale = batchRationale(focusArea);
      return { questions: questions.map((prompt) => ({ prompt, rationale })), source: 'adaptive' };
    }
  }
  // Failure / malformed → honest static fallback (flagged non-adaptive).
  const fallbackRationale = 'Standard discovery question (adaptive generation was unavailable).';
  return { questions: STATIC_FALLBACK_BANK.map((prompt) => ({ prompt, rationale: fallbackRationale })), source: 'static_fallback' };
}

const VERDICTS: readonly AnswerVerdict[] = ['clear', 'vague', 'contradictory'];

/** Resolve the answer-quality verdict. A validated verdict passes through; a detection outage or malformed
 *  payload FAILS OPEN to `clear` — a model outage must never block the founder from proceeding. */
export function resolveAnswerQuality(result: ModelGatewayResult): ResolvedQuality {
  if (result.outcome === 'ok') {
    const rec = asRecord(result.validatedOutput);
    const verdict = rec?.['verdict'];
    if (typeof verdict === 'string' && (VERDICTS as readonly string[]).includes(verdict)) {
      if (verdict === 'clear') return { verdict: 'clear', detail: null };
      const detail = rec?.['detail'];
      if (typeof detail === 'string' && detail.trim().length > 0) return { verdict: verdict as AnswerVerdict, detail };
    }
  }
  return { verdict: 'clear', detail: null };
}

/** Resolve a suggested assumption (DISC-005). Returns the assumption text, or null on failure/malformed output. */
export function resolveAssumption(result: ModelGatewayResult): string | null {
  if (result.outcome === 'ok') {
    const rec = asRecord(result.validatedOutput);
    const a = rec?.['assumption'];
    if (typeof a === 'string' && a.trim().length > 0) return a;
  }
  return null;
}
