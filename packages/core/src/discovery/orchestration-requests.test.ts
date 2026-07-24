// @acbp/core — adaptive-orchestration gateway-request builders (ACBP-P2-005; CDR-028). Pure. Each builder pins a
// registered template (P2-004), renders it with the interview inputs, and produces a well-formed ModelGatewayRequest
// (correct task/timeout class, output schema ref, template provenance, tenant identity) — no DB, no network.
import { describe, test, expect } from 'vitest';
import { INTERVIEW_FOLLOWUPS_SCHEMA, ANSWER_QUALITY_SCHEMA, ASSUMPTION_SCHEMA } from '@acbp/contracts';
import { buildFollowupsRequest, buildAnswerQualityRequest, buildAssumptionRequest } from './orchestration-requests.js';

const ids = { accountId: 'acc-1', companyId: 'co-1', correlationId: 'corr-1' };

describe('buildFollowupsRequest (DISC-001/002)', () => {
  test('pins the follow-ups template, generation class, and carries prior answers + focus area', () => {
    const req = buildFollowupsRequest({ ...ids, priorAnswers: 'We sell coffee.', focusArea: 'pricing' });
    expect(req.templateRef).toBe('interview.followups@1');
    expect(req.taskClass).toBe('generation');
    expect(req.timeoutClass).toBe('generation');
    expect(req.outputSchemaRef).toBe(INTERVIEW_FOLLOWUPS_SCHEMA);
    expect(req.companyId).toBe('co-1');
    expect(req.accountId).toBe('acc-1');
    expect(req.correlationId).toBe('corr-1');
    const blob = req.contextParts.map((p) => p.content).join('\n');
    expect(blob).toContain('We sell coffee.');
    expect(blob).toContain('pricing');
    expect(blob).not.toMatch(/\{\{.*\}\}/);
  });
});

describe('buildAnswerQualityRequest (DISC-003/004)', () => {
  test('pins the answer-quality template, classification/interactive class, carries the answer + prior answers', () => {
    const req = buildAnswerQualityRequest({ ...ids, answer: 'It depends.', priorAnswers: 'We sell coffee.' });
    expect(req.templateRef).toBe('interview.answer_quality@1');
    expect(req.taskClass).toBe('classification');
    expect(req.timeoutClass).toBe('interactive');
    expect(req.outputSchemaRef).toBe(ANSWER_QUALITY_SCHEMA);
    const blob = req.contextParts.map((p) => p.content).join('\n');
    expect(blob).toContain('It depends.');
    expect(blob).toContain('We sell coffee.');
  });
});

describe('buildAssumptionRequest (DISC-005)', () => {
  test('pins the assumption template, generation class, carries the question', () => {
    const req = buildAssumptionRequest({ ...ids, question: 'What is your target market?', priorAnswers: 'We sell coffee.' });
    expect(req.templateRef).toBe('interview.assumption@1');
    expect(req.taskClass).toBe('generation');
    expect(req.outputSchemaRef).toBe(ASSUMPTION_SCHEMA);
    const blob = req.contextParts.map((p) => p.content).join('\n');
    expect(blob).toContain('What is your target market?');
  });
});
