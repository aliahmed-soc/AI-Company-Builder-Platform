// @acbp/contracts — workspace-provisioning contract tests (ACBP-P1-012; CDR-018).
import { describe, test, expect } from 'vitest';
import {
  PROVISIONING_STEPS,
  PROVISIONING_STEP_STATUSES,
  PROVISIONING_RESULT_CODES,
  PROVISIONING_FAILURE_CODES,
  WORKSPACE_AREAS,
  MAX_PROVISIONING_ATTEMPTS,
  isProvisioningStepName,
  isProvisioningStepStatus,
  isProvisioningFailureCode,
  isWorkspaceArea,
  provisioningStepOrder,
  sortProvisioningSteps,
  nextIncompleteProvisioningStep,
  isProvisioningStepExhausted,
  deriveProvisioningFlags,
  type ProvisioningStepLike,
  type ProvisioningStepName,
} from './index.js';
import {
  isProjectableActivity,
  provisioningStarted,
  provisioningStepStarted,
  provisioningStepCompleted,
  provisioningStepFailed,
  provisioningRetryRequested,
  provisioningCompleted,
  isAuditEventName,
} from '../index.js';

const CO = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function mk(entries: ReadonlyArray<[ProvisioningStepName, 'pending' | 'completed' | 'failed', number]>): ProvisioningStepLike[] {
  return entries.map(([step, status, attempt]) => ({ step, status, attempt }));
}
/** All six steps with the given overrides applied (default: pending, attempt 0). */
function six(overrides: Partial<Record<ProvisioningStepName, ['pending' | 'completed' | 'failed', number]>> = {}): ProvisioningStepLike[] {
  return PROVISIONING_STEPS.map((step) => {
    const o = overrides[step];
    return { step, status: o?.[0] ?? 'pending', attempt: o?.[1] ?? 0 };
  });
}

describe('closed step/status/area/code sets (CDR-018 §2/§4/§6)', () => {
  test('exactly six canonical steps in the canonical order', () => {
    expect([...PROVISIONING_STEPS]).toEqual(['profile', 'mission_draft', 'research', 'roadmap', 'documents', 'activity']);
    PROVISIONING_STEPS.forEach((s, i) => expect(provisioningStepOrder(s)).toBe(i + 1));
    for (const s of PROVISIONING_STEPS) expect(isProvisioningStepName(s)).toBe(true);
    for (const bad of ['hosting', 'codebase', 'email', 'database', 'sandbox', '', 'PROFILE', 1, null]) expect(isProvisioningStepName(bad)).toBe(false);
  });
  test('durable statuses are pending|completed|failed — running is NOT a durable status', () => {
    expect([...PROVISIONING_STEP_STATUSES]).toEqual(['pending', 'completed', 'failed']);
    expect(isProvisioningStepStatus('running')).toBe(false);
    expect(isProvisioningStepStatus('completed')).toBe(true);
  });
  test('workspace areas are exactly the four registry steps (profile/activity are verification-only)', () => {
    expect([...WORKSPACE_AREAS]).toEqual(['mission_draft', 'research', 'roadmap', 'documents']);
    expect(isWorkspaceArea('profile')).toBe(false);
    expect(isWorkspaceArea('activity')).toBe(false);
    expect(isWorkspaceArea('roadmap')).toBe(true);
  });
  test('every step has a closed result code; failure codes are closed and bounded', () => {
    expect(PROVISIONING_RESULT_CODES).toEqual({
      profile: 'profile_verified',
      mission_draft: 'mission_area_ready',
      research: 'research_area_ready',
      roadmap: 'roadmap_area_ready',
      documents: 'document_area_ready',
      activity: 'activity_stream_verified',
    });
    expect([...PROVISIONING_FAILURE_CODES]).toEqual(['profile_missing', 'activity_projection_missing', 'internal_error']);
    expect(isProvisioningFailureCode('profile_missing')).toBe(true);
    for (const bad of ['SQLSTATE 23505', 'Error: boom', '', 42, null]) expect(isProvisioningFailureCode(bad)).toBe(false);
  });
  test('attempt cap is exactly 3 total attempts', () => {
    expect(MAX_PROVISIONING_ATTEMPTS).toBe(3);
  });
});

describe('ordering + next-incomplete derivations', () => {
  test('sortProvisioningSteps restores canonical order from untrusted input order', () => {
    const shuffled = mk([
      ['activity', 'pending', 0],
      ['profile', 'completed', 1],
      ['documents', 'pending', 0],
      ['mission_draft', 'completed', 1],
      ['roadmap', 'pending', 0],
      ['research', 'failed', 1],
    ]);
    expect(sortProvisioningSteps(shuffled).map((s) => s.step)).toEqual([...PROVISIONING_STEPS]);
  });
  test('nextIncompleteProvisioningStep: first non-completed in canonical order; null when all completed', () => {
    expect(nextIncompleteProvisioningStep(six())).toBe('profile');
    expect(nextIncompleteProvisioningStep(six({ profile: ['completed', 1], mission_draft: ['completed', 1] }))).toBe('research');
    // A failed step IS the next incomplete step (retryable until exhausted).
    expect(nextIncompleteProvisioningStep(six({ profile: ['completed', 1], mission_draft: ['failed', 1] }))).toBe('mission_draft');
    const all = six(Object.fromEntries(PROVISIONING_STEPS.map((s) => [s, ['completed', 1]])));
    expect(nextIncompleteProvisioningStep(all)).toBeNull();
  });
});

describe('exhaustion + flag derivation (CDR-018 §5/§7)', () => {
  test('exhausted IFF failed at (or defensively beyond) the cap', () => {
    expect(isProvisioningStepExhausted({ step: 'profile', status: 'failed', attempt: 3 })).toBe(true);
    expect(isProvisioningStepExhausted({ step: 'profile', status: 'failed', attempt: 4 })).toBe(true);
    expect(isProvisioningStepExhausted({ step: 'profile', status: 'failed', attempt: 2 })).toBe(false);
    expect(isProvisioningStepExhausted({ step: 'profile', status: 'completed', attempt: 3 })).toBe(false);
    expect(isProvisioningStepExhausted({ step: 'profile', status: 'pending', attempt: 0 })).toBe(false);
  });
  test('fresh sequence: resumable, not completed, not exhausted, next = profile', () => {
    expect(deriveProvisioningFlags(six())).toEqual({ completed: false, exhausted: false, resumable: true, nextIncompleteStep: 'profile' });
  });
  test('all completed: completed, not resumable (idempotent success path)', () => {
    const all = six(Object.fromEntries(PROVISIONING_STEPS.map((s) => [s, ['completed', 1]])));
    expect(deriveProvisioningFlags(all)).toEqual({ completed: true, exhausted: false, resumable: false, nextIncompleteStep: null });
  });
  test('retryable failure (attempt < 3): resumable, not exhausted', () => {
    const f = six({ profile: ['completed', 1], mission_draft: ['failed', 2] });
    expect(deriveProvisioningFlags(f)).toEqual({ completed: false, exhausted: false, resumable: true, nextIncompleteStep: 'mission_draft' });
  });
  test('exhausted failure (attempt = 3) HALTS the sequence: not resumable, exhausted', () => {
    const f = six({ profile: ['completed', 1], mission_draft: ['failed', 3] });
    expect(deriveProvisioningFlags(f)).toEqual({ completed: false, exhausted: true, resumable: false, nextIncompleteStep: 'mission_draft' });
  });
  test('a later failed step does NOT mark the sequence exhausted while an earlier step is pending (order rules)', () => {
    // Defensive: canonical execution can never produce this, but the derivation must still be order-driven.
    const f = six({ documents: ['failed', 3] });
    expect(deriveProvisioningFlags(f).nextIncompleteStep).toBe('profile');
    expect(deriveProvisioningFlags(f).exhausted).toBe(false);
    expect(deriveProvisioningFlags(f).resumable).toBe(true);
  });
  test('malformed sets fail CLOSED: wrong count or duplicates → not completed, not resumable', () => {
    expect(deriveProvisioningFlags([])).toEqual({ completed: false, exhausted: false, resumable: false, nextIncompleteStep: null });
    expect(deriveProvisioningFlags(six().slice(0, 5))).toEqual({ completed: false, exhausted: false, resumable: false, nextIncompleteStep: null });
    const dup = [...six().slice(0, 5), { step: 'profile' as const, status: 'pending' as const, attempt: 0 }];
    expect(deriveProvisioningFlags(dup)).toEqual({ completed: false, exhausted: false, resumable: false, nextIncompleteStep: null });
  });
});

describe('audit registry (CDR-018 §8) — six audit-only events, activity taxonomy unchanged', () => {
  test('all six provisioning event names are registered', () => {
    for (const n of ['provisioning.started', 'provisioning.step_started', 'provisioning.step_completed', 'provisioning.step_failed', 'provisioning.retry_requested', 'provisioning.completed']) {
      expect(isAuditEventName(n)).toBe(true);
    }
  });
  test('NO provisioning event is projectable into the activity feed (P1-009 taxonomy stays closed)', () => {
    for (const n of ['provisioning.started', 'provisioning.step_started', 'provisioning.step_completed', 'provisioning.step_failed', 'provisioning.retry_requested', 'provisioning.completed']) {
      expect(isProjectableActivity(n)).toBe(false);
    }
  });
  test('factories emit exactly the allowlisted metadata (no extra keys, no free text)', () => {
    expect(provisioningStarted({ companyId: CO, stepCount: 6 })).toMatchObject({ name: 'provisioning.started', subjectType: 'company', subjectId: CO, outcome: 'success', metadata: { step_count: 6 } });
    expect(provisioningStepStarted({ companyId: CO, step: 'profile', attempt: 1 }).metadata).toEqual({ step: 'profile', attempt: 1 });
    expect(provisioningStepCompleted({ companyId: CO, step: 'roadmap', attempt: 2, resultCode: 'roadmap_area_ready' }).metadata).toEqual({ step: 'roadmap', attempt: 2, result_code: 'roadmap_area_ready' });
    const failed = provisioningStepFailed({ companyId: CO, step: 'activity', attempt: 3, failureCode: 'activity_projection_missing' });
    expect(failed.outcome).toBe('blocked');
    expect(failed.metadata).toEqual({ step: 'activity', attempt: 3, failure_code: 'activity_projection_missing' });
    expect(provisioningRetryRequested({ companyId: CO, step: 'documents', nextAttempt: 2 }).metadata).toEqual({ step: 'documents', next_attempt: 2 });
    expect(provisioningCompleted({ companyId: CO, stepCount: 6 }).metadata).toEqual({ step_count: 6 });
  });
});
