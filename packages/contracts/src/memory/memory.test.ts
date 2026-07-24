// @acbp/contracts — typed memory contract tests (ACBP-P2-006; CDR-024). Pure. Pins the closed enums, the
// type-by-source-path rule (a generated claim can never be a user_fact/user_preference), and the bounded
// submission validation.
import { describe, test, expect } from 'vitest';
import {
  MEMORY_TYPES,
  MEMORY_SOURCE_TYPES,
  MEMORY_CONFIRMATION_STATES,
  INITIAL_MEMORY_CONFIRMATION_STATE,
  MEMORY_CONTENT_MAX,
  isMemoryType,
  isMemorySourceType,
  maySourceProduceType,
  validateMemorySubmission,
  type MemoryType,
  type MemorySourceType,
} from './index.js';

describe('memory enums', () => {
  test('exactly eight memory types (closed)', () => {
    expect(MEMORY_TYPES).toEqual(['user_fact', 'user_preference', 'constraint', 'ai_assumption', 'research_finding', 'approved_decision', 'measured_outcome', 'correction']);
    for (const t of MEMORY_TYPES) expect(isMemoryType(t)).toBe(true);
    for (const bad of ['fact', 'USER_FACT', 'opinion', '', 42, null, {}]) expect(isMemoryType(bad)).toBe(false);
  });
  test('exactly six source types (closed)', () => {
    expect(MEMORY_SOURCE_TYPES).toEqual(['interview_answer', 'user_edit', 'task_result', 'model_generation', 'imported_document', 'system_measurement']);
    for (const s of MEMORY_SOURCE_TYPES) expect(isMemorySourceType(s)).toBe(true);
    for (const bad of ['answer', 'ai', '', 42, null]) expect(isMemorySourceType(bad)).toBe(false);
  });
  test('confirmation states + initial', () => {
    expect(MEMORY_CONFIRMATION_STATES).toEqual(['proposed', 'accepted', 'validated', 'invalidated']);
    expect(INITIAL_MEMORY_CONFIRMATION_STATE).toBe('proposed');
  });
});

describe('type-by-source-path (generated claims are never user_fact/user_preference)', () => {
  const userSources: MemorySourceType[] = ['interview_answer', 'user_edit'];
  const nonUserSources: MemorySourceType[] = ['task_result', 'model_generation', 'imported_document', 'system_measurement'];
  const userStatedTypes: MemoryType[] = ['user_fact', 'user_preference'];
  const otherTypes: MemoryType[] = ['constraint', 'ai_assumption', 'research_finding', 'approved_decision', 'measured_outcome', 'correction'];

  test('user_fact/user_preference require a USER source; a non-user source is refused', () => {
    for (const t of userStatedTypes) {
      for (const s of userSources) expect(maySourceProduceType(s, t), `${s}->${t}`).toBe(true);
      for (const s of nonUserSources) expect(maySourceProduceType(s, t), `${s}->${t}`).toBe(false);
    }
  });
  test('the other six types are unconstrained by source', () => {
    for (const t of otherTypes) {
      for (const s of MEMORY_SOURCE_TYPES) expect(maySourceProduceType(s, t), `${s}->${t}`).toBe(true);
    }
  });
});

describe('validateMemorySubmission', () => {
  const base = { type: 'user_fact', content: 'The founder is in Cairo.', sourceType: 'interview_answer', sourceRef: 'q1:1', confidence: null };
  test('a valid user-sourced fact is accepted and normalized', () => {
    const r = validateMemorySubmission(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ type: 'user_fact', content: 'The founder is in Cairo.', sourceType: 'interview_answer', sourceRef: 'q1:1', confidence: null });
  });
  test('a generated claim cannot be a user_fact (type-by-source-path)', () => {
    expect(validateMemorySubmission({ ...base, sourceType: 'model_generation' }).ok).toBe(false);
    // …but the same source CAN be an ai_assumption.
    expect(validateMemorySubmission({ ...base, type: 'ai_assumption', sourceType: 'model_generation' }).ok).toBe(true);
  });
  test('untyped / unknown-source writes are rejected', () => {
    expect(validateMemorySubmission({ ...base, type: 'opinion' }).ok).toBe(false);
    expect(validateMemorySubmission({ ...base, sourceType: 'guess' }).ok).toBe(false);
  });
  test('content is required + bounded; source_ref is required + bounded (resolvable link)', () => {
    expect(validateMemorySubmission({ ...base, content: '' }).ok).toBe(false);
    expect(validateMemorySubmission({ ...base, content: 'x'.repeat(MEMORY_CONTENT_MAX + 1) }).ok).toBe(false);
    expect(validateMemorySubmission({ ...base, sourceRef: '' }).ok).toBe(false);
    expect(validateMemorySubmission({ ...base, sourceRef: undefined }).ok).toBe(false);
  });
  test('confidence, when present, must be a finite number in [0,1]', () => {
    expect(validateMemorySubmission({ ...base, confidence: 0.7 }).ok).toBe(true);
    expect(validateMemorySubmission({ ...base, confidence: 0 }).ok).toBe(true);
    expect(validateMemorySubmission({ ...base, confidence: 1 }).ok).toBe(true);
    expect(validateMemorySubmission({ ...base, confidence: -0.1 }).ok).toBe(false);
    expect(validateMemorySubmission({ ...base, confidence: 1.5 }).ok).toBe(false);
    expect(validateMemorySubmission({ ...base, confidence: 'high' }).ok).toBe(false);
    expect(validateMemorySubmission({ ...base, confidence: Number.NaN }).ok).toBe(false);
  });
  test('a validation failure carries a bounded public envelope', () => {
    const r = validateMemorySubmission({ ...base, type: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('validation');
  });
});
