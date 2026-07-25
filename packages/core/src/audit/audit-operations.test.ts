// @acbp/core — audit completeness registry tests (ACBP-P1-008). Structural (not source-grep) guarantees that
// the approved high-risk operations map to durable events, and that every registered event is produced.
import { describe, test, expect } from 'vitest';
import { AUDIT_EVENTS } from '@acbp/contracts';
import { AUDITED_OPERATIONS, AUDITED_OPERATION_IDS, factoryFor, producedEventNames, registeredEventNames } from './audit-operations.js';

describe('audit completeness registry (ACBP-P1-008 / CDR-014)', () => {
  test('the approved operation set is the membership + company lifecycle + provisioning + admin + interview operations', () => {
    expect([...AUDITED_OPERATION_IDS].sort()).toEqual([
      // Platform-administrative access (ACBP-P1-013; CDR-019) — deliberately approved addition.
      'admin.tenant_read',
      'company.create',
      'company.pause',
      'company.resume',
      'company.update',
      // Interview session lifecycle (ACBP-P2-001; CDR-022 §4) — deliberately approved addition.
      'interview.start',
      // Typed memory (ACBP-P2-006; CDR-024 §4) — deliberately approved addition.
      'memory.create',
      // Memory browser (ACBP-P2-010; CDR-025 §4) — deliberately approved addition.
      'memory.supersede',
      // Memory browser (ACBP-P2-010; CDR-025 §0 owner decision) — deliberately approved addition.
      'memory.delete',
      // Understanding generation (ACBP-P2-008; CDR-029 §6) — deliberately approved addition.
      'understanding.generate',
      // Understanding review + confirmation (ACBP-P2-009; CDR-030 §3/§4/§6) — deliberately approved additions.
      'understanding.review-decision',
      'understanding.confirm',
      'understanding.correct',
      // Context assembly (ACBP-P2-007; CDR-032 §3) — deliberately approved addition.
      'context.flag-conflict',
      // Task model (ACBP-P4-002; CDR-033 §4) — deliberately approved addition.
      'task.plan',
      // Strategy option generation (ACBP-P3-001; CDR-034 §4) — deliberately approved addition.
      'strategy.generate',
      'membership.invite',
      'membership.revoke',
      // Workspace provisioning (ACBP-P1-012; CDR-018 §8) — deliberately approved additions.
      'provisioning.complete',
      'provisioning.retry_request',
      'provisioning.start',
      'provisioning.step_complete',
      'provisioning.step_fail',
      'provisioning.step_start',
    ].sort());
    expect(AUDITED_OPERATIONS['membership.invite']).toBe('membership.invited');
    expect(AUDITED_OPERATIONS['membership.revoke']).toBe('membership.revoked');
    expect(AUDITED_OPERATIONS['company.create']).toBe('company.created');
    expect(AUDITED_OPERATIONS['company.update']).toBe('company.updated');
    expect(AUDITED_OPERATIONS['company.pause']).toBe('company.paused');
    expect(AUDITED_OPERATIONS['company.resume']).toBe('company.resumed');
    expect(AUDITED_OPERATIONS['provisioning.start']).toBe('provisioning.started');
    expect(AUDITED_OPERATIONS['provisioning.step_start']).toBe('provisioning.step_started');
    expect(AUDITED_OPERATIONS['provisioning.step_complete']).toBe('provisioning.step_completed');
    expect(AUDITED_OPERATIONS['provisioning.step_fail']).toBe('provisioning.step_failed');
    expect(AUDITED_OPERATIONS['provisioning.retry_request']).toBe('provisioning.retry_requested');
    expect(AUDITED_OPERATIONS['provisioning.complete']).toBe('provisioning.completed');
    expect(AUDITED_OPERATIONS['admin.tenant_read']).toBe('admin.tenant_read');
    expect(AUDITED_OPERATIONS['interview.start']).toBe('interview.started');
    expect(AUDITED_OPERATIONS['memory.create']).toBe('memory.item_created');
    expect(AUDITED_OPERATIONS['memory.supersede']).toBe('memory.item_superseded');
    expect(AUDITED_OPERATIONS['memory.delete']).toBe('memory.item_deleted');
    expect(AUDITED_OPERATIONS['understanding.generate']).toBe('understanding.generated');
    expect(AUDITED_OPERATIONS['understanding.review-decision']).toBe('understanding.item_reviewed');
    expect(AUDITED_OPERATIONS['understanding.confirm']).toBe('understanding.confirmed');
    expect(AUDITED_OPERATIONS['understanding.correct']).toBe('understanding.corrected');
    expect(AUDITED_OPERATIONS['context.flag-conflict']).toBe('context.conflict_flagged');
    expect(AUDITED_OPERATIONS['task.plan']).toBe('task.created');
  });

  test('every REGISTERED audit event is produced by exactly one approved operation (no orphan events)', () => {
    const produced = producedEventNames();
    for (const name of registeredEventNames()) {
      expect(produced.has(name)).toBe(true);
    }
    // And the produced set has no name that is not registered in the contract.
    for (const name of produced) {
      expect(Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, name)).toBe(true);
    }
    // The two sets are the same size — a 1:1 operation↔event mapping for the first cut.
    expect(produced.size).toBe(registeredEventNames().length);
  });

  test('factoryFor produces an event whose name matches the operation mapping', () => {
    for (const op of AUDITED_OPERATION_IDS) {
      const event = factoryFor(op)('subject_1');
      expect(event.name).toBe(AUDITED_OPERATIONS[op]);
      expect(event.subjectId).toBe('subject_1');
      // A recorded STEP FAILURE (CDR-018 §8) and a flagged CONTEXT CONFLICT (CDR-032 §3 — items withheld) are
      // honestly not successes — their outcome is 'blocked'; every other approved operation records a success.
      expect(event.outcome).toBe(op === 'provisioning.step_fail' || op === 'context.flag-conflict' ? 'blocked' : 'success');
    }
  });
});
