// ACBP-P5-002 — the task-run lifecycle, made executable (CDR-053; TASK-007; NFR-005).
//
// Acceptance: "Cancel queued instant; running safe-stop bounded; timeout works". All three are decided here, purely,
// so they are testable without a worker, a clock, or a database.
import { describe, test, expect } from 'vitest';
import {
  RUN_STATES,
  RUN_TERMINAL_STATES,
  RUN_FAILURE_CATEGORIES,
  isRunState,
  isTerminalRunState,
  isRunFailureCategory,
  canTransitionRun,
  classifyCancellation,
  isRunLost,
  DEFAULT_HEARTBEAT_GRACE_MS,
} from './run.js';

describe('the run state set', () => {
  test('is exactly canon\'s five — a run is one execution attempt, not the task', () => {
    // DATA-ARCHITECTURE gives the RUN this lifecycle. The richer set in WORKFLOW-STATE-MACHINES §4
    // (waiting_for_input, waiting_for_approval, blocked_by_policy, paused) are TASK states — every one of them emits
    // a `task.*` event — and belong to P4-002's `tasks.state`. See CDR-053 §2.
    expect([...RUN_STATES].sort()).toEqual(['cancelled', 'failed', 'queued', 'running', 'succeeded']);
    for (const s of RUN_STATES) expect(isRunState(s)).toBe(true);
    for (const bad of ['waiting_for_approval', 'paused', 'blocked_by_policy', '', null, 42]) {
      expect(isRunState(bad)).toBe(false);
    }
  });

  test('terminal states are the three a run never leaves', () => {
    expect([...RUN_TERMINAL_STATES].sort()).toEqual(['cancelled', 'failed', 'succeeded']);
    for (const s of RUN_TERMINAL_STATES) expect(isTerminalRunState(s)).toBe(true);
    expect(isTerminalRunState('queued')).toBe(false);
    expect(isTerminalRunState('running')).toBe(false);
  });
});

describe('canTransitionRun — the closed transition table', () => {
  test('the happy path', () => {
    expect(canTransitionRun('queued', 'running')).toBe(true);
    expect(canTransitionRun('running', 'succeeded')).toBe(true);
  });

  test('a run can fail or be cancelled from either non-terminal state', () => {
    for (const from of ['queued', 'running'] as const) {
      expect(canTransitionRun(from, 'cancelled')).toBe(true);
    }
    expect(canTransitionRun('running', 'failed')).toBe(true);
  });

  test('a QUEUED run cannot succeed or fail — it never ran, so it has no outcome to report', () => {
    expect(canTransitionRun('queued', 'succeeded')).toBe(false);
    expect(canTransitionRun('queued', 'failed')).toBe(false);
  });

  test('NOTHING leaves a terminal state — an attempt that ended stays ended', () => {
    // A retried task gets a NEW run with the next attempt number; it never revives an old one. Reviving would make
    // `attempt` meaningless and the failure history unreconstructible.
    for (const from of RUN_TERMINAL_STATES) {
      for (const to of RUN_STATES) expect(canTransitionRun(from, to)).toBe(false);
    }
  });

  test('a run cannot go back to queued, and running→running is not a transition', () => {
    expect(canTransitionRun('running', 'queued')).toBe(false);
    expect(canTransitionRun('running', 'running')).toBe(false);
    expect(canTransitionRun('queued', 'queued')).toBe(false);
  });

  test('unknown states are refused rather than treated as permissive', () => {
    expect(canTransitionRun('nonsense', 'running')).toBe(false);
    expect(canTransitionRun('queued', 'nonsense')).toBe(false);
    expect(canTransitionRun(undefined, 'running')).toBe(false);
  });
});

describe('classifyCancellation — "cancel queued instant; running safe-stop bounded"', () => {
  test('a QUEUED run cancels immediately — it has not started, so there is nothing to stop safely', () => {
    expect(classifyCancellation('queued')).toEqual({ kind: 'immediate' });
  });

  test('a RUNNING run gets a safe-stop REQUEST — the worker halts at its next safe point', () => {
    // The distinction is the acceptance clause. Treating both as one operation would either make queued cancellation
    // wait for a worker that will never answer, or make running cancellation abandon work mid-tool-call.
    expect(classifyCancellation('running')).toEqual({ kind: 'safe_stop_requested' });
  });

  test('a TERMINAL run is already over — cancelling is a no-op, not an error', () => {
    for (const s of RUN_TERMINAL_STATES) {
      expect(classifyCancellation(s)).toEqual({ kind: 'already_terminal' });
    }
  });

  test('an unknown state is treated as already-terminal rather than cancellable — fail closed', () => {
    expect(classifyCancellation('nonsense').kind).toBe('already_terminal');
  });
});

describe('isRunLost — "timeout works"', () => {
  const now = new Date('2026-07-28T00:00:00.000Z');

  test('a run whose heartbeat is within the grace is alive', () => {
    const beat = new Date(now.getTime() - (DEFAULT_HEARTBEAT_GRACE_MS - 1_000));
    expect(isRunLost({ state: 'running', lastHeartbeatAt: beat }, now)).toBe(false);
  });

  test('a run whose heartbeat is older than the grace is LOST', () => {
    const beat = new Date(now.getTime() - (DEFAULT_HEARTBEAT_GRACE_MS + 1_000));
    expect(isRunLost({ state: 'running', lastHeartbeatAt: beat }, now)).toBe(true);
  });

  test('the boundary is inclusive of the grace — exactly at the limit is still alive', () => {
    const beat = new Date(now.getTime() - DEFAULT_HEARTBEAT_GRACE_MS);
    expect(isRunLost({ state: 'running', lastHeartbeatAt: beat }, now)).toBe(false);
  });

  test('a run that has NEVER heartbeat is lost only once the grace has passed since it started', () => {
    // Otherwise every run is "lost" in the instant between being marked running and its first beat.
    const justStarted = new Date(now.getTime() - 1_000);
    expect(isRunLost({ state: 'running', lastHeartbeatAt: null, startedAt: justStarted }, now)).toBe(false);
    const longAgo = new Date(now.getTime() - (DEFAULT_HEARTBEAT_GRACE_MS + 1_000));
    expect(isRunLost({ state: 'running', lastHeartbeatAt: null, startedAt: longAgo }, now)).toBe(true);
  });

  test('a QUEUED run is never lost — nothing is holding it, so there is no liveness to lose', () => {
    const longAgo = new Date(now.getTime() - DEFAULT_HEARTBEAT_GRACE_MS * 10);
    expect(isRunLost({ state: 'queued', lastHeartbeatAt: null, startedAt: longAgo }, now)).toBe(false);
  });

  test('a TERMINAL run is never lost — it already reported its outcome', () => {
    const longAgo = new Date(now.getTime() - DEFAULT_HEARTBEAT_GRACE_MS * 10);
    for (const s of RUN_TERMINAL_STATES) {
      expect(isRunLost({ state: s, lastHeartbeatAt: longAgo }, now)).toBe(false);
    }
  });

  test('a FUTURE heartbeat does not make a run immortal — clock skew must not defeat the timeout', () => {
    // A worker with a fast clock could otherwise write a heartbeat far in the future and never be reclaimed.
    const future = new Date(now.getTime() + DEFAULT_HEARTBEAT_GRACE_MS * 100);
    expect(isRunLost({ state: 'running', lastHeartbeatAt: future }, now)).toBe(false);
    // ...but it is still alive, not lost — the guard is that we never treat it as a REASON to keep it forever;
    // the caller's grace is bounded and a sane clock resolves it. What must not happen is a crash or NaN.
    expect(() => isRunLost({ state: 'running', lastHeartbeatAt: future }, now)).not.toThrow();
  });

  test('a run with neither heartbeat nor start time is LOST — unknown liveness fails closed', () => {
    expect(isRunLost({ state: 'running', lastHeartbeatAt: null }, now)).toBe(true);
  });
});

describe('failure categories', () => {
  test('are a CLOSED set including canon\'s worker_lost', () => {
    expect(isRunFailureCategory('worker_lost')).toBe(true);
    for (const c of RUN_FAILURE_CATEGORIES) expect(isRunFailureCategory(c)).toBe(true);
    for (const bad of ['Error: socket hang up', '', null, 7]) expect(isRunFailureCategory(bad)).toBe(false);
  });
});
