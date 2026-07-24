// @acbp/contracts — adaptive-orchestration output contracts (ACBP-P2-005; CDR-028; DISC-001..006). Pure.
// Pins the ≤3 batch cap, the closed question-source vocabulary, and the deny-by-default parse/validation of the
// three model output shapes the gateway validates: follow-up batch, answer-quality verdict, assumption suggestion.
import { describe, test, expect } from 'vitest';
import {
  MAX_FOLLOWUP_BATCH,
  QUESTION_SOURCES,
  isQuestionSource,
  ANSWER_VERDICTS,
  INTERVIEW_FOLLOWUPS_SCHEMA,
  ANSWER_QUALITY_SCHEMA,
  ASSUMPTION_SCHEMA,
  parseFollowUps,
  parseAnswerQuality,
  parseAssumption,
} from './index.js';

describe('orchestration vocabulary (CDR-028)', () => {
  test('the ≤3 batch cap (DISC-001) and distinct schema refs', () => {
    expect(MAX_FOLLOWUP_BATCH).toBe(3);
    const refs = [INTERVIEW_FOLLOWUPS_SCHEMA, ANSWER_QUALITY_SCHEMA, ASSUMPTION_SCHEMA];
    expect(new Set(refs).size).toBe(3);
    for (const r of refs) expect(typeof r).toBe('string');
  });
  test('closed question-source set: adaptive | static_fallback', () => {
    expect(QUESTION_SOURCES).toEqual(['adaptive', 'static_fallback']);
    for (const s of QUESTION_SOURCES) expect(isQuestionSource(s)).toBe(true);
    for (const bad of ['manual', 'seed', '', 42, null, {}]) expect(isQuestionSource(bad)).toBe(false);
  });
  test('closed answer-verdict set: clear | vague | contradictory', () => {
    expect(ANSWER_VERDICTS).toEqual(['clear', 'vague', 'contradictory']);
  });
});

describe('parseFollowUps — deny-by-default (DISC-001 ≤3)', () => {
  test('accepts 1..3 non-empty questions', () => {
    const r = parseFollowUps('{"questions":["What is your target market?","Who are your competitors?"]}');
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.questions).toEqual(['What is your target market?', 'Who are your competitors?']);
  });
  test('rejects more than three (never silently truncates the ≤3 rule)', () => {
    expect(parseFollowUps('{"questions":["a","b","c","d"]}').ok).toBe(false);
  });
  test('rejects empty batch, empty/blank question, non-array, malformed JSON, over-long', () => {
    expect(parseFollowUps('{"questions":[]}').ok).toBe(false);
    expect(parseFollowUps('{"questions":["ok",""]}').ok).toBe(false);
    expect(parseFollowUps('{"questions":["ok","   "]}').ok).toBe(false);
    expect(parseFollowUps('{"questions":"nope"}').ok).toBe(false);
    expect(parseFollowUps('not json').ok).toBe(false);
    expect(parseFollowUps(JSON.stringify({ questions: ['x'.repeat(5000)] })).ok).toBe(false);
    expect(parseFollowUps('{"questions":[123]}').ok).toBe(false);
  });
});

describe('parseAnswerQuality — vague/contradiction detection (DISC-003/004)', () => {
  test('clear verdict carries no detail', () => {
    const r = parseAnswerQuality('{"verdict":"clear"}');
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toEqual({ verdict: 'clear', detail: null });
  });
  test('vague/contradictory require a non-empty bounded detail', () => {
    const v = parseAnswerQuality('{"verdict":"vague","detail":"Which region specifically? e.g. MENA, EU"}');
    expect(v.ok && v.value.verdict).toBe('vague');
    expect(v.ok && v.value.detail).toContain('region');
    expect(parseAnswerQuality('{"verdict":"contradictory"}').ok).toBe(false); // missing required detail
    expect(parseAnswerQuality('{"verdict":"vague","detail":""}').ok).toBe(false);
  });
  test('rejects unknown verdict + malformed', () => {
    expect(parseAnswerQuality('{"verdict":"maybe"}').ok).toBe(false);
    expect(parseAnswerQuality('nope').ok).toBe(false);
  });
});

describe('parseAssumption — labeled assumption (DISC-005)', () => {
  test('accepts a non-empty bounded assumption', () => {
    const r = parseAssumption('{"assumption":"Assuming the target market is small businesses in Egypt."}');
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.assumption).toContain('small businesses');
  });
  test('rejects empty/blank/over-long/malformed', () => {
    expect(parseAssumption('{"assumption":""}').ok).toBe(false);
    expect(parseAssumption('{"assumption":"   "}').ok).toBe(false);
    expect(parseAssumption(JSON.stringify({ assumption: 'x'.repeat(5000) })).ok).toBe(false);
    expect(parseAssumption('{}').ok).toBe(false);
    expect(parseAssumption('nope').ok).toBe(false);
  });
});
