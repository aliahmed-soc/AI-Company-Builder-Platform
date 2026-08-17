/*
 * ACBP-FE-005 — the provisioning view's four arms.
 *
 * These were written AFTER the module, which is the wrong order and worth saying: tests-after tend to confirm
 * whatever the code already does. They are therefore written to attack it — every case below is one where a
 * plausible implementation gives the wrong answer, not a restatement of the happy path.
 */
import { describe, test, expect } from 'vitest';
import { MAX_PROVISIONING_ATTEMPTS, PROVISIONING_STEPS, type ProvisioningStatusDTO, type ProvisioningStepDTO } from '@acbp/contracts';
import { toProvisioningView } from './provisioning-view';

type StepOverride = Partial<ProvisioningStepDTO> & { step: ProvisioningStepDTO['step'] };

const step = (o: StepOverride): ProvisioningStepDTO => ({
  step: o.step,
  order: o.order ?? PROVISIONING_STEPS.indexOf(o.step) + 1,
  status: o.status ?? 'pending',
  attempt: o.attempt ?? 0,
  requestedAt: o.requestedAt ?? '2026-08-17T00:00:00.000Z',
  startedAt: o.startedAt ?? null,
  completedAt: o.completedAt ?? null,
  failedAt: o.failedAt ?? null,
  failureCode: o.failureCode ?? null,
});

const allSteps = (mut: (s: ProvisioningStepDTO['step']) => Partial<ProvisioningStepDTO> = () => ({})): ProvisioningStepDTO[] =>
  PROVISIONING_STEPS.map((s) => step({ step: s, ...mut(s) }));

const dto = (o: Partial<ProvisioningStatusDTO>): ProvisioningStatusDTO => ({
  companyId: o.companyId ?? 'c-1',
  companyStatus: o.companyStatus ?? 'onboarding',
  steps: o.steps ?? allSteps(),
  // `in`, NOT `??`. An explicit `nextIncompleteStep: null` is a REAL case — the server sends it whenever the
  // run is complete or the step set is malformed — and `null ?? 'profile'` silently replaced it with a step
  // name, so the one test written to exercise the null path was quietly handed a non-null value instead. A
  // fixture that substitutes a default for the exact value under test cannot fail for the right reason.
  nextIncompleteStep: 'nextIncompleteStep' in o ? (o.nextIncompleteStep as ProvisioningStatusDTO['nextIncompleteStep']) : 'profile',
  resumable: o.resumable ?? true,
  exhausted: o.exhausted ?? false,
  completed: o.completed ?? false,
});

describe('ACBP-FE-005 — toProvisioningView', () => {
  test('NO step is ever reported as in-progress, because the contract never commits `running`', () => {
    // provisioning.ts:22-27 — `running` is intentionally absent from PROVISIONING_STEP_STATUSES. A view that
    // invented an in-flight tone would be depicting a state the database refuses to hold.
    const v = toProvisioningView(dto({ steps: allSteps((s) => (s === 'profile' ? { status: 'completed', attempt: 1 } : {})) }));
    for (const s of v.steps) {
      expect(['done', 'waiting', 'failed', 'unknown']).toContain(s.tone);
      expect(s.status).not.toBe('running');
    }
  });

  test('completed wins over every other flag', () => {
    const v = toProvisioningView(dto({ completed: true, resumable: false, exhausted: false, nextIncompleteStep: null, companyStatus: 'active', steps: allSteps(() => ({ status: 'completed', attempt: 1 })) }));
    expect(v.kind).toBe('complete');
    expect(v.companyStatus).toBe('active');
  });

  test('exhausted renders the blocked step, its CLOSED failure code and the real attempt count', () => {
    const v = toProvisioningView(
      dto({
        resumable: false,
        exhausted: true,
        nextIncompleteStep: 'research',
        steps: allSteps((s) =>
          s === 'profile' || s === 'mission_draft'
            ? { status: 'completed', attempt: 1 }
            : s === 'research'
              ? { status: 'failed', attempt: MAX_PROVISIONING_ATTEMPTS, failureCode: 'internal_error' }
              : {},
        ),
      }),
    );
    expect(v.kind).toBe('exhausted');
    if (v.kind !== 'exhausted') throw new Error('unreachable');
    expect(v.blockedStep).toBe('research');
    expect(v.failureCode).toBe('internal_error');
    expect(v.attempts).toBe(MAX_PROVISIONING_ATTEMPTS);
    expect(v.maxAttempts).toBe(MAX_PROVISIONING_ATTEMPTS);
  });

  test('resumable names the next step and derives progress, since the payload carries no count', () => {
    const v = toProvisioningView(
      dto({ resumable: true, nextIncompleteStep: 'roadmap', steps: allSteps((s) => (['profile', 'mission_draft', 'research'].includes(s) ? { status: 'completed', attempt: 1 } : {})) }),
    );
    expect(v.kind).toBe('resumable');
    if (v.kind !== 'resumable') throw new Error('unreachable');
    expect(v.nextStep).toBe('roadmap');
    expect(v.nextStepLabel).toBe('Roadmap');
    expect(v.completedCount).toBe(3);
    expect(v.totalCount).toBe(6);
  });

  test('ALL THREE FLAGS FALSE is the inconsistent arm — never rendered as quiet progress', () => {
    // deriveProvisioningFlags:139-141 returns this only for a malformed step set. Showing a spinner here would
    // tell a founder that work is happening when the record says the opposite.
    const v = toProvisioningView(dto({ resumable: false, exhausted: false, completed: false, nextIncompleteStep: null }));
    expect(v.kind).toBe('inconsistent');
    if (v.kind !== 'inconsistent') throw new Error('unreachable');
    expect(v.detail.length).toBeGreaterThan(40);
    expect(v.detail).toMatch(/nothing to resume|operator/i);
  });

  test('the inconsistent arm is reached even when a MALFORMED set still has six entries', () => {
    // Duplicates also trip the contract's inconsistency branch. The view must not depend on counting.
    const dupes = [step({ step: 'profile' }), step({ step: 'profile' }), step({ step: 'research' }), step({ step: 'roadmap' }), step({ step: 'documents' }), step({ step: 'activity' })];
    const v = toProvisioningView(dto({ steps: dupes, resumable: false, exhausted: false, completed: false, nextIncompleteStep: null }));
    expect(v.kind).toBe('inconsistent');
  });

  test('steps are rendered in canonical order even when the payload arrives shuffled', () => {
    const shuffled = [...allSteps()].reverse();
    const v = toProvisioningView(dto({ steps: shuffled }));
    expect(v.steps.map((s) => s.step)).toEqual([...PROVISIONING_STEPS]);
  });

  test('the server token is preserved beside the derived label', () => {
    const v = toProvisioningView(dto({}));
    const mission = v.steps.find((s) => s.step === 'mission_draft');
    expect(mission?.step, 'the raw token must survive for assertions and copy').toBe('mission_draft');
    expect(mission?.label).toBe('Mission draft');
  });

  test('a status outside the closed set is toned UNKNOWN, not guessed into done or failed', () => {
    const odd = allSteps();
    const v = toProvisioningView(dto({ steps: [{ ...odd[0]!, status: 'some_future_status' as ProvisioningStepDTO['status'] }, ...odd.slice(1)] }));
    const first = v.steps.find((s) => s.order === 1);
    expect(first?.tone).toBe('unknown');
    expect(first?.status, 'and the word itself is still shown verbatim').toBe('some_future_status');
  });

  test('atAttemptCap is true ONLY for a failed step at the cap, never for a pending one', () => {
    const v = toProvisioningView(
      dto({ steps: allSteps((s) => (s === 'profile' ? { status: 'failed', attempt: MAX_PROVISIONING_ATTEMPTS } : s === 'research' ? { status: 'pending', attempt: MAX_PROVISIONING_ATTEMPTS } : {})) }),
    );
    expect(v.steps.find((s) => s.step === 'profile')?.atAttemptCap).toBe(true);
    expect(v.steps.find((s) => s.step === 'research')?.atAttemptCap, 'a pending step is not capped whatever its attempt number').toBe(false);
  });

  test('exhausted still degrades honestly when the server sends no nextIncompleteStep', () => {
    // Defensive: the arm must not produce an empty-looking screen with no blocked step named if it can find
    // the failed row another way.
    const v = toProvisioningView(
      dto({ resumable: false, exhausted: true, nextIncompleteStep: null, steps: allSteps((s) => (s === 'documents' ? { status: 'failed', attempt: MAX_PROVISIONING_ATTEMPTS, failureCode: 'profile_missing' } : { status: 'completed', attempt: 1 })) }),
    );
    if (v.kind !== 'exhausted') throw new Error('unreachable');
    expect(v.blockedStep).toBe('documents');
    expect(v.failureCode).toBe('profile_missing');
  });

  test('companyStatus is carried through verbatim on every arm', () => {
    for (const [d, kind] of [
      [dto({ completed: true, resumable: false, nextIncompleteStep: null, companyStatus: 'active', steps: allSteps(() => ({ status: 'completed', attempt: 1 })) }), 'complete'],
      [dto({ resumable: true, companyStatus: 'onboarding' }), 'resumable'],
      [dto({ resumable: false, exhausted: true, companyStatus: 'paused' }), 'exhausted'],
      [dto({ resumable: false, exhausted: false, nextIncompleteStep: null, companyStatus: 'unknown' }), 'inconsistent'],
    ] as const) {
      const v = toProvisioningView(d);
      expect(v.kind).toBe(kind);
      expect(v.companyStatus).toBe(d.companyStatus);
    }
  });
});
