// @acbp/contracts — audit contract tests (ACBP-P1-008). ULID generation, closed event registry, bounded
// metadata, and typed factories. Forgery resistance is a property of the writer (account/actor/id/time are
// server-bound); here we pin the caller-facing contract's validation + immutability.
import { describe, test, expect } from 'vitest';
import { isPlatformError } from '../errors.js';
import {
  generateEventId,
  isUlid,
  isAuditEventName,
  isAuditActorType,
  AUDIT_EVENTS,
  AUDIT_ACTOR_TYPES,
  boundedMetadata,
  membershipInvited,
  membershipRevoked,
  companyCreated,
  companyUpdated,
  companyPaused,
  companyResumed,
  interviewStarted,
  jobEnqueued,
  memoryItemCreated,
  memoryItemSuperseded,
  memoryItemDeleted,
  understandingItemReviewed,
  understandingConfirmed,
  understandingCorrected,
  contextConflictFlagged,
  taskCreated,
  strategyGenerated,
  strategySelected,
  decisionRecorded,
  roadmapGenerated,
  roadmapEdited,
  planningRunRecorded,
  taskRepeated,
  taskDeleted,
  type AuditEventName,
} from './index.js';

describe('generateEventId (ULID)', () => {
  test('produces a 26-char Crockford-base32 ULID', () => {
    const id = generateEventId(1_700_000_000_000);
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  test('the timestamp prefix is lexicographically time-ordered', () => {
    const earlier = generateEventId(1_700_000_000_000).slice(0, 10);
    const later = generateEventId(1_700_000_001_000).slice(0, 10);
    expect(later > earlier).toBe(true);
  });

  test('two ids at the same instant differ in the random suffix (unique)', () => {
    const a = generateEventId(1_700_000_000_000);
    const b = generateEventId(1_700_000_000_000);
    expect(a).not.toBe(b);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10)); // same time prefix
  });

  test('rejects an out-of-range timestamp', () => {
    expect(() => generateEventId(-1)).toThrow();
    expect(() => generateEventId(2 ** 48)).toThrow();
    expect(() => generateEventId(1.5)).toThrow();
  });

  test('isUlid rejects malformed values (wrong length, lowercase, ambiguous letters, non-strings)', () => {
    for (const bad of ['', 'abc', '0123456789ABCDEFGHJKMNPQR', 'i'.repeat(26), '01234567890123456789ABCDEL', 42, null, undefined]) {
      expect(isUlid(bad)).toBe(false);
    }
  });
});

describe('event-name registry (deny unregistered)', () => {
  test('accepts exactly the registered names', () => {
    expect(Object.keys(AUDIT_EVENTS).sort()).toEqual([
      // Platform-administrative access (ACBP-P1-013; CDR-019 §7) — exactly one audit-only admin event.
      'admin.tenant_read',
      'company.created',
      'company.paused',
      'company.resumed',
      'company.updated',
      'membership.invited',
      'membership.revoked',
      // Workspace provisioning (ACBP-P1-012; CDR-018 §8) — six audit-only events, deliberately registered.
      'provisioning.completed',
      'provisioning.retry_requested',
      'provisioning.started',
      'provisioning.step_completed',
      'provisioning.step_failed',
      'provisioning.step_started',
    ].concat([
      // Interview session lifecycle (ACBP-P2-001; CDR-022 §4) — exactly one audit-only session event.
      'interview.started',
      // Durable job enqueue (ACBP-P5-001a; CDR-049 §4) — the first entry in a job's run trail.
      'job.enqueued',
      'job.dead_lettered',
      // Typed memory (ACBP-P2-006; CDR-024 §4) — a memory item creation is audited.
      'memory.item_created',
      // Memory browser (ACBP-P2-010; CDR-025 §4) — a memory item supersede is audited.
      'memory.item_superseded',
      // Memory browser (ACBP-P2-010; CDR-025 §0) — a memory item soft delete is audited.
      'memory.item_deleted',
      // Understanding generation (ACBP-P2-008; CDR-029 §6) — a document version generation is audited.
      'understanding.generated',
      // Understanding review + confirmation (ACBP-P2-009; CDR-030 §3/§4/§6) — three deliberately-registered events.
      'understanding.item_reviewed',
      'understanding.confirmed',
      'understanding.corrected',
      // Context assembly (ACBP-P2-007; CDR-032 §3) — a MEM-004 conflict was flagged + items withheld.
      'context.conflict_flagged',
      // Task lifecycle (ACBP-P4-002; CDR-033 §4) — a task appeared on the board.
      'task.created',
      // Strategy option generation (ACBP-P3-001; CDR-034 §4) — options generated from a confirmed understanding.
      'strategy.generated',
      // Owner strategy decision (ACBP-P3-004; CDR-037 §4).
      'strategy.selected',
      // Immutable decision record (ACBP-P3-005; CDR-038 §4; STRAT-006).
      'decision.recorded',
      // Planning (ACBP-P4-001; CDR-039 §5; ROAD-001/002).
      'roadmap.generated',
      'roadmap.edited',
      // Planning transparency (ACBP-P4-006; CDR-041 §3-G6; PLAN-004).
      'planning.run_recorded',
      // Task detail controls (ACBP-P4-005; CDR-043 §4-G10; TASK-008).
      'task.repeated',
      'task.deleted',
    ]).sort());
    for (const name of Object.keys(AUDIT_EVENTS)) expect(isAuditEventName(name)).toBe(true);
  });
  test('rejects unregistered / forged names and non-strings', () => {
    for (const bad of ['membership.deleted', 'account.created', 'authz.denied', 'MEMBERSHIP.INVITED', '', 42, null, {}]) {
      expect(isAuditEventName(bad as unknown)).toBe(false);
    }
  });
});

describe('actor types', () => {
  test('exactly user|worker|system|admin', () => {
    expect([...AUDIT_ACTOR_TYPES].sort()).toEqual(['admin', 'system', 'user', 'worker']);
    for (const t of AUDIT_ACTOR_TYPES) expect(isAuditActorType(t)).toBe(true);
    for (const bad of ['owner', 'viewer', 'root', '', 1, null]) expect(isAuditActorType(bad as unknown)).toBe(false);
  });
});

describe('boundedMetadata', () => {
  test('accepts a flat map of scalars and freezes it', () => {
    const m = boundedMetadata({ role: 'viewer', count: 3, ok: true });
    expect(m).toEqual({ role: 'viewer', count: 3, ok: true });
    expect(Object.isFrozen(m)).toBe(true);
  });

  test('rejects nested objects, arrays, Error objects, and functions (no unbounded structures)', () => {
    expect(() => boundedMetadata({ nested: { a: 1 } })).toThrow();
    expect(() => boundedMetadata({ list: [1, 2] })).toThrow();
    expect(() => boundedMetadata({ err: new Error('boom') })).toThrow();
    expect(() => boundedMetadata({ fn: () => 1 })).toThrow();
  });

  test('rejects null/undefined/bigint/symbol and non-finite numbers', () => {
    expect(() => boundedMetadata({ a: null })).toThrow();
    expect(() => boundedMetadata({ a: undefined })).toThrow();
    expect(() => boundedMetadata({ a: 10n })).toThrow();
    expect(() => boundedMetadata({ a: Symbol('s') })).toThrow();
    expect(() => boundedMetadata({ a: Infinity })).toThrow();
    expect(() => boundedMetadata({ a: NaN })).toThrow();
  });

  test('rejects invalid keys, too many keys, over-long values, and over-large totals', () => {
    expect(() => boundedMetadata({ 'Bad-Key': 'x' })).toThrow();
    expect(() => boundedMetadata({ '1leading': 'x' })).toThrow();
    const many: Record<string, number> = {};
    for (let i = 0; i < 17; i++) many[`k${i}`] = i;
    expect(() => boundedMetadata(many)).toThrow();
    // Per-value bound is 1024 UTF-16 units (sized for the ≤512-code-point VERBATIM admin reason, which may be
    // up to 1024 units with astral characters — ACBP-P1-013/CDR-019 §4).
    expect(() => boundedMetadata({ big: 'x'.repeat(1024) })).not.toThrow();
    expect(() => boundedMetadata({ big: 'x'.repeat(1025) })).toThrow();
    expect(() => boundedMetadata({ a: 'x'.repeat(500), b: 'y'.repeat(500), c: 'z'.repeat(500), d: 'w'.repeat(500), e: 'v'.repeat(500), f: 'u'.repeat(500), g: 't'.repeat(500), h: 's'.repeat(500), i: 'r'.repeat(500) })).toThrow();
  });

  test('a rejected metadata value never appears in the validation error (only the key name does)', () => {
    try {
      // A nested object is rejected; the offending VALUE must not leak into the error.
      boundedMetadata({ note: { hidden: 'do-not-leak-xyz' } });
      throw new Error('expected boundedMetadata to throw');
    } catch (e) {
      // Public envelope: no value AND no field name (safe by default).
      expect(JSON.stringify(e)).not.toContain('do-not-leak-xyz');
      expect(isPlatformError(e)).toBe(true);
      if (isPlatformError(e)) {
        const internal = JSON.stringify(e.toInternal());
        expect(internal).not.toContain('do-not-leak-xyz'); // internal report: still never the value
        expect(internal).toContain('note'); // internal captures the offending KEY name only
      }
    }
  });
});

describe('typed factories', () => {
  test('membershipInvited builds a frozen success event with bounded metadata', () => {
    const ev = membershipInvited({ membershipId: 'm_1', role: 'viewer' });
    expect(ev).toEqual({ name: 'membership.invited', schemaVersion: 1, subjectType: 'membership', subjectId: 'm_1', outcome: 'success', metadata: { role: 'viewer' } });
    expect(Object.isFrozen(ev)).toBe(true);
    expect(Object.isFrozen(ev.metadata)).toBe(true);
  });

  test('membershipRevoked builds the revoked lifecycle event', () => {
    const ev = membershipRevoked({ membershipId: 'm_2', role: 'owner' });
    expect(ev.name).toBe('membership.revoked');
    expect(ev.subjectType).toBe('membership');
    expect(ev.subjectId).toBe('m_2');
    expect(ev.outcome).toBe('success');
    expect(ev.metadata).toEqual({ role: 'owner' });
  });

  test('a factory rejects an empty or over-long subject id', () => {
    expect(() => membershipInvited({ membershipId: '', role: 'viewer' })).toThrow();
    expect(() => membershipInvited({ membershipId: 'x'.repeat(65), role: 'viewer' })).toThrow();
  });

  test('the schema version comes from the registry, not the caller', () => {
    const name: AuditEventName = 'membership.invited';
    expect(membershipInvited({ membershipId: 'm', role: 'viewer' }).schemaVersion).toBe(AUDIT_EVENTS[name].schemaVersion);
  });

  test('companyCreated builds a frozen success event with the creation mode', () => {
    const ev = companyCreated({ companyId: 'co_1', creationMode: 'own_idea' });
    expect(ev).toEqual({ name: 'company.created', schemaVersion: 1, subjectType: 'company', subjectId: 'co_1', outcome: 'success', metadata: { creation_mode: 'own_idea' } });
    expect(Object.isFrozen(ev)).toBe(true);
  });

  test('companyUpdated records changed FIELD NAMES only (never values)', () => {
    const ev = companyUpdated({ companyId: 'co_2', changedFields: ['name', 'description'] });
    expect(ev.name).toBe('company.updated');
    expect(ev.subjectId).toBe('co_2');
    expect(ev.metadata).toEqual({ changed_fields: 'name,description' });
  });

  test('companyPaused/companyResumed omit optional fields when absent', () => {
    expect(companyPaused({ companyId: 'co_3' }).metadata).toEqual({});
    expect(companyPaused({ companyId: 'co_3', reason: 'owner_request' }).metadata).toEqual({ reason: 'owner_request' });
    expect(companyResumed({ companyId: 'co_4' }).metadata).toEqual({});
    expect(companyResumed({ companyId: 'co_4', heldWorkCount: 3 }).metadata).toEqual({ held_work_count: 3 });
  });

  test('company factories reject an empty subject id', () => {
    expect(() => companyCreated({ companyId: '', creationMode: 'own_idea' })).toThrow();
  });

  test('interviewStarted builds a frozen success event subjected to the SESSION id with empty metadata', () => {
    const ev = interviewStarted({ sessionId: 'sess_1' });
    expect(ev).toEqual({ name: 'interview.started', schemaVersion: 1, subjectType: 'interview_session', subjectId: 'sess_1', outcome: 'success', metadata: {} });
    expect(Object.isFrozen(ev)).toBe(true);
    expect(Object.isFrozen(ev.metadata)).toBe(true);
  });

  test('interviewStarted rejects an empty subject id (no session, no event)', () => {
    expect(() => interviewStarted({ sessionId: '' })).toThrow();
  });

  test('jobEnqueued carries only {kind, deduplicated} — never the payload or the tenant ids', () => {
    const ev = jobEnqueued({ jobId: 'job_1', kind: 'understanding.generate', deduplicated: false });
    expect(ev).toEqual({ name: 'job.enqueued', schemaVersion: 1, subjectType: 'job', subjectId: 'job_1', outcome: 'success', metadata: { kind: 'understanding.generate', deduplicated: false } });
    expect(Object.isFrozen(ev.metadata)).toBe(true);
    // The payload carries caller-chosen references and is not a reviewed surface; the tenant ids belong to the
    // account-scoped audit row itself, and copying them into a payload is how the two drift apart.
    expect(Object.keys(ev.metadata).sort()).toEqual(['deduplicated', 'kind']);
  });

  test('jobEnqueued rejects an empty subject id (no job, no event)', () => {
    expect(() => jobEnqueued({ jobId: '', kind: 'understanding.generate', deduplicated: false })).toThrow();
  });

  test('memoryItemCreated carries only bounded {item_type, source_type} — never content or source_ref', () => {
    const ev = memoryItemCreated({ memoryItemId: 'mem_1', itemType: 'user_fact', sourceType: 'interview_answer' });
    expect(ev).toEqual({ name: 'memory.item_created', schemaVersion: 1, subjectType: 'memory_item', subjectId: 'mem_1', outcome: 'success', metadata: { item_type: 'user_fact', source_type: 'interview_answer' } });
    expect(Object.isFrozen(ev)).toBe(true);
  });

  test('memoryItemSuperseded: subject = the OLD item id; metadata = the NEW version {item_type, source_type}', () => {
    const ev = memoryItemSuperseded({ supersededItemId: 'mem_old', newItemType: 'user_fact', newSourceType: 'user_edit' });
    expect(ev).toEqual({ name: 'memory.item_superseded', schemaVersion: 1, subjectType: 'memory_item', subjectId: 'mem_old', outcome: 'success', metadata: { item_type: 'user_fact', source_type: 'user_edit' } });
    expect(Object.isFrozen(ev)).toBe(true);
  });

  test('memoryItemDeleted: subject = the deleted item; metadata = {item_type, source_type, transition} — no content', () => {
    const ev = memoryItemDeleted({ memoryItemId: 'mem_1', itemType: 'user_fact', sourceType: 'interview_answer' });
    expect(ev).toEqual({ name: 'memory.item_deleted', schemaVersion: 1, subjectType: 'memory_item', subjectId: 'mem_1', outcome: 'success', metadata: { item_type: 'user_fact', source_type: 'interview_answer', transition: 'active_to_deleted' } });
    expect(Object.isFrozen(ev)).toBe(true);
  });

  test('understandingItemReviewed: subject = the item; metadata = {decision, version} — no content/edited text', () => {
    const ev = understandingItemReviewed({ itemId: 'ui_1', decision: 'edited', version: 2 });
    expect(ev).toEqual({ name: 'understanding.item_reviewed', schemaVersion: 1, subjectType: 'understanding_item', subjectId: 'ui_1', outcome: 'success', metadata: { decision: 'edited', version: 2 } });
    expect(Object.isFrozen(ev)).toBe(true);
  });

  test('understandingConfirmed: subject = the document; metadata = {version} (actor is server-stamped)', () => {
    const ev = understandingConfirmed({ documentId: 'ud_1', version: 3 });
    expect(ev).toEqual({ name: 'understanding.confirmed', schemaVersion: 1, subjectType: 'understanding_document', subjectId: 'ud_1', outcome: 'success', metadata: { version: 3 } });
    expect(Object.isFrozen(ev)).toBe(true);
  });

  test('understandingCorrected: subject = the document; metadata = {version, correction_ref, dependents_flagged}', () => {
    const ev = understandingCorrected({ documentId: 'ud_1', version: 3, correctionRef: 'ui_9', dependentsFlagged: 1 });
    expect(ev).toEqual({ name: 'understanding.corrected', schemaVersion: 1, subjectType: 'understanding_document', subjectId: 'ud_1', outcome: 'success', metadata: { version: 3, correction_ref: 'ui_9', dependents_flagged: 1 } });
    expect(Object.isFrozen(ev)).toBe(true);
  });

  test('contextConflictFlagged: subject = the confirmed item; metadata = {confirmed_count, assumption_count}; outcome blocked', () => {
    const ev = contextConflictFlagged({ itemId: 'mem_1', confirmedCount: 1, assumptionCount: 2 });
    expect(ev).toEqual({ name: 'context.conflict_flagged', schemaVersion: 1, subjectType: 'memory_item', subjectId: 'mem_1', outcome: 'blocked', metadata: { confirmed_count: 1, assumption_count: 2 } });
    expect(Object.isFrozen(ev)).toBe(true);
  });

  test('taskCreated: subject = the task; metadata = {has_milestone} — no title/description', () => {
    const ev = taskCreated({ taskId: 'task_1', hasMilestone: false });
    expect(ev).toEqual({ name: 'task.created', schemaVersion: 1, subjectType: 'task', subjectId: 'task_1', outcome: 'success', metadata: { has_milestone: false } });
    expect(Object.isFrozen(ev)).toBe(true);
  });

  test('strategyGenerated: subject = the generation; metadata = {understanding_version, option_count, similarity_check_result} — no option content', () => {
    const ev = strategyGenerated({ generationId: 'gen_1', understandingVersion: 2, optionCount: 3, similarityCheckResult: 'pending' });
    expect(ev).toEqual({ name: 'strategy.generated', schemaVersion: 1, subjectType: 'strategy_generation', subjectId: 'gen_1', outcome: 'success', metadata: { understanding_version: 2, option_count: 3, similarity_check_result: 'pending' } });
    expect(Object.isFrozen(ev)).toBe(true);
  });

  test('strategySelected: subject = the selection; metadata = {mode} (+ phase_scope when set) — no content/reasons', () => {
    const ev = strategySelected({ selectionId: 'sel_1', mode: 'select', phaseScope: 'first_phase' });
    expect(ev).toEqual({ name: 'strategy.selected', schemaVersion: 1, subjectType: 'strategy_selection', subjectId: 'sel_1', outcome: 'success', metadata: { mode: 'select', phase_scope: 'first_phase' } });
    // No phase scope → the key is omitted (not a sentinel).
    expect(strategySelected({ selectionId: 'sel_2', mode: 'reject', phaseScope: null }).metadata).toEqual({ mode: 'reject' });
  });

  test('decisionRecorded: subject = the DECISION; metadata = scalar {understanding_version, options_considered_count, mode} — no content/rationale', () => {
    const ev = decisionRecorded({ decisionId: 'dec_1', understandingVersion: 2, optionsConsideredCount: 3, mode: 'edit' });
    expect(ev).toEqual({ name: 'decision.recorded', schemaVersion: 1, subjectType: 'decision', subjectId: 'dec_1', outcome: 'success', metadata: { understanding_version: 2, options_considered_count: 3, mode: 'edit' } });
    // A rejection is recorded too (STRAT-006 "selection/edit/rejection"); still no reasons/rationale in metadata.
    expect(decisionRecorded({ decisionId: 'dec_2', understandingVersion: 1, optionsConsideredCount: 0, mode: 'reject' }).metadata).toEqual({ understanding_version: 1, options_considered_count: 0, mode: 'reject' });
  });

  test('roadmapGenerated: subject = the roadmap version; scalar counts only — no goal/milestone content', () => {
    const ev = roadmapGenerated({ roadmapId: 'rm_1', roadmapVersion: 1, goalCount: 3, milestoneCount: 5, status: 'complete', modelFlaggedPartial: false });
    expect(ev).toEqual({ name: 'roadmap.generated', schemaVersion: 1, subjectType: 'roadmap', subjectId: 'rm_1', outcome: 'success', metadata: { roadmap_version: 1, goal_count: 3, milestone_count: 5, status: 'complete', model_flagged_partial: false } });
    // An honestly-partial plan is labeled, not hidden.
    expect(roadmapGenerated({ roadmapId: 'rm_2', roadmapVersion: 2, goalCount: 1, milestoneCount: 1, status: 'partial', modelFlaggedPartial: true }).metadata).toEqual({ roadmap_version: 2, goal_count: 1, milestone_count: 1, status: 'partial', model_flagged_partial: true });
  });

  test('roadmapEdited: subject = the NEW version; metadata carries counts + has_reason — never the reason text', () => {
    const ev = roadmapEdited({ roadmapId: 'rm_3', roadmapVersion: 2, supersedesVersion: 1, affectedTaskCount: 4, hasReason: true });
    expect(ev).toEqual({ name: 'roadmap.edited', schemaVersion: 1, subjectType: 'roadmap', subjectId: 'rm_3', outcome: 'success', metadata: { roadmap_version: 2, supersedes_version: 1, affected_task_count: 4, has_reason: true } });
    // No key anywhere carries free text.
    expect(Object.values(ev.metadata ?? {}).every((v) => typeof v === 'number' || typeof v === 'boolean')).toBe(true);
  });

  test('taskRepeated: subject is the NEW task; the source is metadata so lineage reads from either end', () => {
    const ev = taskRepeated({ newTaskId: 't_new', sourceTaskId: 't_old', sourceState: 'failed' });
    expect(ev).toEqual({ name: 'task.repeated', schemaVersion: 1, subjectType: 'task', subjectId: 't_new', outcome: 'success', metadata: { source_task_id: 't_old', source_state: 'failed' } });
    // No copied content reaches the audit row.
    expect(JSON.stringify(ev.metadata)).not.toMatch(/title|description/i);
  });

  test('taskDeleted: records WHAT was lost, never the owner-authored reason text (TASK-008)', () => {
    const ev = taskDeleted({ taskId: 't_1', stateAtDelete: 'completed', hasReason: true });
    expect(ev).toEqual({ name: 'task.deleted', schemaVersion: 1, subjectType: 'task', subjectId: 't_1', outcome: 'success', metadata: { state_at_delete: 'completed', has_reason: true } });
    // `has_reason` is a BOOLEAN: deleting a completed task and deleting a queued one are very different losses, and
    // the state records that — but the reason itself is free text and stays out of the payload.
    expect(typeof ev.metadata?.['has_reason']).toBe('boolean');
    expect(Object.values(ev.metadata ?? {}).every((v) => typeof v === 'string' || typeof v === 'boolean')).toBe(true);
  });

  test('planningRunRecorded: counts only — never rationale text, task titles, or memory content (PLAN-004)', () => {
    const ev = planningRunRecorded({ runId: 'pr_1', mode: 'autonomous', outcome: 'partial', taskCount: 3, tasksMissingRationale: 1, memoryItemsConsidered: 7, milestonesInScope: 2 });
    expect(ev).toEqual({ name: 'planning.run_recorded', schemaVersion: 1, subjectType: 'planning_run', subjectId: 'pr_1', outcome: 'success', metadata: { mode: 'autonomous', outcome: 'partial', task_count: 3, tasks_missing_rationale: 1, memory_items_considered: 7, milestones_in_scope: 2 } });
    // Scalars only, and no arrays (AuditMetadata forbids them — the exact input set lives in planning_run_inputs).
    expect(Object.values(ev.metadata ?? {}).every((v) => typeof v === 'number' || typeof v === 'string')).toBe(true);
    expect(Object.values(ev.metadata ?? {}).some((v) => Array.isArray(v))).toBe(false);
  });

  test('a FAILED run is still audited with a success OUTCOME — the audited operation is recording the run', () => {
    // CDR-041 §3-G3/G6: the run's own result is metadata. Reserving `denied`/`blocked` for authorization and policy
    // keeps those outcomes meaningful, and mirrors `strategy.selected` recording a `reject` mode as metadata.
    const ev = planningRunRecorded({ runId: 'pr_2', mode: 'steered', outcome: 'failed', taskCount: 0, tasksMissingRationale: 0, memoryItemsConsidered: 0, milestonesInScope: 4 });
    expect(ev.outcome).toBe('success');
    expect(ev.metadata?.['outcome']).toBe('failed');
  });
});
