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
  // Approvals (ACBP-P6-003c; CDR-068). Deciding and REJECTING are separate operations, mirroring the
  // `policy.evaluate` / `policy.evaluate.denied` split: the audited operation is the authorization, so granting it and
  // withholding it are two things a reader counts separately.
  'approval.consume',
  'approval.decide',
  'approval.decide.rejected',
  'approval.request',
  'approval.revoke',
  'approval.revoke_failed',
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
      // Durable jobs (ACBP-P5-001a; CDR-049 §4; ADR-008) — deliberately approved addition.
      'job.enqueue',
      'job.dead_letter',
      // Task runs (ACBP-P5-002; CDR-053) - deliberately approved additions.
      'run.start',
      'run.fail',
      'run.cancel',
      // Tool dispatch (ACBP-P5-003b; CDR-054; TOOL-002) — deliberately approved additions. `tool.dispatch` covers
      // refusals as well as authorizations; TOOL-001 requires the attempt to be audited either way.
      'policy.evaluate',
      'policy.evaluate.denied',
      'policy.evaluate.unavailable',
      'policy.initialize',
      // Emergency stop (ACBP-P6-007; CDR-072; ADMIN-001/002) — activate, clear, and review one held item.
      'emergency_stop.activate',
      'emergency_stop.clear',
      'emergency_stop.work.review',
      'tool.dispatch',
      'tool.complete',
      'tool.fail',
      // Worker pause/disable (ACBP-P5-004; CDR-056; WORK-006) - deliberately approved addition.
      'worker.set_state',
      // Worker RUNS (ACBP-P5-005; CDR-057) - deliberately approved additions.
      'worker.run_start',
      'worker.run_complete',
      'worker.run_fail',
      // The credit ledger (ACBP-P5-014; CDR-058) - deliberately approved additions.
      'credit.reserve',
      'credit.settle',
      // Account usage rollups (ACBP-P6-009; CDR-073 §1-G15) — deliberately approved additions. `usage.correct` is
      // the compensating-record half of trust-critical #13; `usage.reconcile` is launch gate 7's drift check.
      // There is deliberately NO `usage.rebuild`: a bare rebuild changes no fact.
      'usage.correct',
      'usage.reconcile',
      // Task model (ACBP-P4-002; CDR-033 §4) — deliberately approved addition.
      'task.plan',
      // Strategy option generation (ACBP-P3-001; CDR-034 §4) — deliberately approved addition.
      'strategy.generate',
      // Owner strategy decision (ACBP-P3-004; CDR-037 §4) — deliberately approved addition.
      'strategy.select',
      // Immutable decision record (ACBP-P3-005; CDR-038 §4; STRAT-006) — deliberately approved addition.
      'decision.record',
      // Planning (ACBP-P4-001; CDR-039 §5; ROAD-001/002) — deliberately approved additions.
      'roadmap.generate',
      'roadmap.edit',
      // Planning transparency (ACBP-P4-006; CDR-041 §3-G6; PLAN-004) — deliberately approved addition.
      'planning.run_record',
      // Task detail controls (ACBP-P4-005; CDR-043 §4-G10; TASK-008 "Controls audited") — deliberately approved.
      'task.repeat',
      'task.delete',
      // Revision requests (ACBP-P5-012; CDR-064) - deliberately approved addition.
      'artifact.request-revision',
      // Task completion (ACBP-P5-011; TASK-005) — a succeeded RUN is not a completed TASK, so this is its own operation.
      'task.complete',
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
    expect(AUDITED_OPERATIONS['strategy.generate']).toBe('strategy.generated');
    expect(AUDITED_OPERATIONS['strategy.select']).toBe('strategy.selected');
    expect(AUDITED_OPERATIONS['decision.record']).toBe('decision.recorded');
    expect(AUDITED_OPERATIONS['roadmap.generate']).toBe('roadmap.generated');
    expect(AUDITED_OPERATIONS['roadmap.edit']).toBe('roadmap.edited');
    expect(AUDITED_OPERATIONS['planning.run_record']).toBe('planning.run_recorded');
    expect(AUDITED_OPERATIONS['task.repeat']).toBe('task.repeated');
    expect(AUDITED_OPERATIONS['task.delete']).toBe('task.deleted');
    expect(AUDITED_OPERATIONS['task.complete']).toBe('task.completed');
    expect(AUDITED_OPERATIONS['job.enqueue']).toBe('job.enqueued');
    expect(AUDITED_OPERATIONS['job.dead_letter']).toBe('job.dead_lettered');
    expect(AUDITED_OPERATIONS['run.start']).toBe('task.started');
    expect(AUDITED_OPERATIONS['run.fail']).toBe('task.failed');
    expect(AUDITED_OPERATIONS['run.cancel']).toBe('task.cancelled');
    expect(AUDITED_OPERATIONS['tool.dispatch']).toBe('tool.call_requested');
    expect(AUDITED_OPERATIONS['tool.complete']).toBe('tool.call_completed');
    expect(AUDITED_OPERATIONS['tool.fail']).toBe('tool.call_failed');
    expect(AUDITED_OPERATIONS['worker.set_state']).toBe('worker.state_changed');
    expect(AUDITED_OPERATIONS['worker.run_start']).toBe('worker.started');
    expect(AUDITED_OPERATIONS['worker.run_fail']).toBe('worker.failed');
    expect(AUDITED_OPERATIONS['usage.correct']).toBe('usage.corrected');
    expect(AUDITED_OPERATIONS['usage.reconcile']).toBe('usage.rollup_reconciled');
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
      // A recorded STEP FAILURE (CDR-018 §8), a flagged CONTEXT CONFLICT (CDR-032 §3 — items withheld), and a
      // DEAD-LETTERED job (CDR-052 — the retry cap stopped it) are honestly not successes: their outcome is
      // 'blocked'. Every other approved operation records a success.
      // A failed RUN is likewise not a success (TASK-006) - outcome 'blocked'.
      // A failed TOOL CALL is 'blocked' for the same reason. `tool.complete` is only a success when the call actually
      // SUCCEEDED — an `unconfirmed` external effect goes through the same factory and is deliberately NOT a success
      // (TOOL-002: "never 'succeeded'"), which is why the canonical sample here uses the succeeded outcome.
      // A policy REFUSAL and a policy UNAVAILABILITY are both 'blocked': EVENT-CATALOG reserves denied/blocked for
      // authorization and policy, and neither is a success by any reading — the action did not happen.
      const blocked = ['approval.revoke_failed', 'provisioning.step_fail', 'context.flag-conflict', 'job.dead_letter', 'run.fail', 'tool.fail', 'policy.evaluate.denied', 'policy.evaluate.unavailable'];
      // A HUMAN REFUSAL IS `denied`, NOT `blocked`, and the distinction is the authority chain's (ACBP-P6-003c).
      // `blocked` is what the PLATFORM does when a rule or a failure stops something; `denied` is what a PERSON does
      // when they decline to authorize it. EVENT-CATALOG reserves both for authorization and policy, and collapsing
      // them would make "did a human say no, or did a rule?" unanswerable from the outcome column — which is exactly
      // the question the approval trail exists to answer.
      const denied = ['approval.decide.rejected', 'approval.revoke'];
      expect(event.outcome).toBe(blocked.includes(op) ? 'blocked' : denied.includes(op) ? 'denied' : 'success');
    }
  });
});
