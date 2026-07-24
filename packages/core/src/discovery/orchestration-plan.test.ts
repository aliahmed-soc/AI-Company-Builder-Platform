// @acbp/core — adaptive-orchestration decision logic (ACBP-P2-005; CDR-028; DISC-001..006). Pure, no DB, no
// network. The DISC rules live here: adaptive vs static-fallback selection, the "why we ask" rationale, the
// vague/contradiction verdict resolution (fail-open on detection outage), and the assumption path.
import { describe, test, expect } from 'vitest';
import type { ModelGatewayResult } from '@acbp/contracts';
import { STATIC_FALLBACK_BANK, batchRationale, planFollowUpBatch, resolveAnswerQuality, resolveAssumption } from './orchestration-plan.js';

function okResult(validatedOutput: unknown): ModelGatewayResult {
  return { outcome: 'ok', validatedOutput, provider: 'fake', model: 'fake@v1', tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, estimatedCostMicros: 0, fallbackUsed: false, latencyMs: 1 };
}
function errResult(): ModelGatewayResult {
  return { outcome: 'error', errorCategory: 'provider_unavailable', provider: 'fake', model: 'fake@v1', tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, estimatedCostMicros: 0, fallbackUsed: false, latencyMs: 1 };
}

describe('batchRationale (DISC-006 "why we ask")', () => {
  test('names the focus area honestly', () => {
    const r = batchRationale('target market');
    expect(r.toLowerCase()).toContain('target market');
    expect(r.length).toBeGreaterThan(0);
    expect(r.length).toBeLessThanOrEqual(1000);
  });
});

describe('planFollowUpBatch (DISC-001/002; generation failure = flagged fallback)', () => {
  test('adaptive: an ok result yields the validated questions with a rationale, source=adaptive', () => {
    const plan = planFollowUpBatch(okResult({ questions: ['Who is your customer?', 'What problem do you solve?'] }), 'target market');
    expect(plan.source).toBe('adaptive');
    expect(plan.questions.map((q) => q.prompt)).toEqual(['Who is your customer?', 'What problem do you solve?']);
    for (const q of plan.questions) expect(q.rationale.toLowerCase()).toContain('target market');
  });
  test('fallback: a gateway error yields the static bank flagged non-adaptive', () => {
    const plan = planFollowUpBatch(errResult(), 'target market');
    expect(plan.source).toBe('static_fallback');
    expect(plan.questions.length).toBeGreaterThan(0);
    expect(plan.questions.length).toBeLessThanOrEqual(3);
    expect(plan.questions.map((q) => q.prompt)).toEqual([...STATIC_FALLBACK_BANK].slice(0, plan.questions.length));
  });
  test('defensive: an ok result with a malformed payload falls back rather than persisting garbage', () => {
    expect(planFollowUpBatch(okResult({ nope: true }), 'x').source).toBe('static_fallback');
    expect(planFollowUpBatch(okResult({ questions: [] }), 'x').source).toBe('static_fallback');
  });
  test('never exceeds three (the static bank is itself <=3)', () => {
    expect(STATIC_FALLBACK_BANK.length).toBeLessThanOrEqual(3);
  });
});

describe('resolveAnswerQuality (DISC-003/004; fail-open on detection outage)', () => {
  test('passes through a validated verdict', () => {
    expect(resolveAnswerQuality(okResult({ verdict: 'vague', detail: 'Which region?' }))).toEqual({ verdict: 'vague', detail: 'Which region?' });
    expect(resolveAnswerQuality(okResult({ verdict: 'contradictory', detail: 'Conflicts with your earlier answer.' })).verdict).toBe('contradictory');
  });
  test('a detection outage does not block the founder — treated as clear', () => {
    expect(resolveAnswerQuality(errResult())).toEqual({ verdict: 'clear', detail: null });
    expect(resolveAnswerQuality(okResult({ garbage: true }))).toEqual({ verdict: 'clear', detail: null });
  });
});

describe('resolveAssumption (DISC-005 I-don\'t-know)', () => {
  test('returns the validated assumption text', () => {
    expect(resolveAssumption(okResult({ assumption: 'Assuming SMBs in Egypt.' }))).toBe('Assuming SMBs in Egypt.');
  });
  test('returns null when generation fails or is malformed (skip recorded without an assumption)', () => {
    expect(resolveAssumption(errResult())).toBeNull();
    expect(resolveAssumption(okResult({ nope: 1 }))).toBeNull();
  });
});
