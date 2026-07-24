// @acbp/core — understanding generation pure helpers (ACBP-P2-008; CDR-029). Pure. The request builder pins the
// registered template + output schema; the memory formatter produces bounded, type-labeled prompt text.
import { describe, test, expect } from 'vitest';
import { UNDERSTANDING_SCHEMA, type MemoryItemDTO } from '@acbp/contracts';
import { buildUnderstandingRequest, formatMemoryForPrompt } from './understanding-generation.js';

function mem(over: Partial<MemoryItemDTO> = {}): MemoryItemDTO {
  return { memoryItemId: 'm1', type: 'user_fact', content: 'Sells coffee.', sourceType: 'interview_answer', sourceRef: 'q:1', confidence: null, confirmationState: 'proposed', supersededBy: null, createdAt: '2026-01-01T00:00:00.000Z', ...over };
}

describe('buildUnderstandingRequest', () => {
  test('pins the understanding template, generation class, output schema, and tenant identity', () => {
    const req = buildUnderstandingRequest({ accountId: 'acc-1', companyId: 'co-1', memory: '- [user_fact] Sells coffee.', correlationId: 'corr-1' });
    expect(req.templateRef).toBe('understanding.generate@1');
    expect(req.taskClass).toBe('generation');
    expect(req.timeoutClass).toBe('generation');
    expect(req.outputSchemaRef).toBe(UNDERSTANDING_SCHEMA);
    expect(req.companyId).toBe('co-1');
    expect(req.accountId).toBe('acc-1');
    expect(req.correlationId).toBe('corr-1');
    const blob = req.contextParts.map((p) => p.content).join('\n');
    expect(blob).toContain('Sells coffee.');
    expect(blob).not.toMatch(/\{\{.*\}\}/);
  });
});

describe('formatMemoryForPrompt', () => {
  test('type-labels each item; an empty set yields an honest marker (no ids/PII)', () => {
    const text = formatMemoryForPrompt([mem({ content: 'Sells coffee.' }), mem({ type: 'constraint', content: 'Budget is tight.' })]);
    expect(text).toContain('[user_fact] Sells coffee.');
    expect(text).toContain('[constraint] Budget is tight.');
    expect(text).not.toContain('m1'); // no memory ids leaked into the prompt
    expect(formatMemoryForPrompt([])).toBe('No confirmed information yet.');
  });
});
