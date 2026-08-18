/*
 * ACBP-FE-015 — the task execution view mapper.
 *
 * EVERY STATE AND CATEGORY IN THIS FILE COMES FROM THE CONTRACT. `RUN_STATES` and `RUN_FAILURE_CATEGORIES` are
 * both CHECKed in the migration, and ACBP-FE-016 shipped a screen whose invented vocabulary matched no row the
 * database could hold — passing green because its tests fed values the constraint forbids. The fixtures here
 * are driven from the contract arrays so that cannot recur.
 *
 * THE INTERESTING SIGNALS ARE THE ONES A PROGRESS SCREEN NORMALLY FLATTENS:
 *   lastHeartbeatAt   — a `running` run whose heartbeat is old is not the same as one actively working. The
 *                       server has a `worker_lost` category for the conclusion; this screen may show the age
 *                       and must NOT reach that conclusion itself.
 *   stopRequestedAt   — a stop was asked for. Until `endedAt` is set, it has not taken effect.
 *   failureCategory   — non-null ONLY when the run failed (the CHECK ties them), so a category on a running
 *                       run is impossible and a failure without one is the shape TASK-006 forbids.
 *   retrySafety       — `unsafe` means retrying may repeat an external effect. It is not a hint.
 */
import { describe, expect, it } from 'vitest';
import { RUN_FAILURE_CATEGORIES, RUN_STATES } from '@acbp/contracts';
import { toRunView, toLineageView, RUN_STATE_ORDER, MAX_REVISIONS } from './run-view';
import type { RunLike, LineageLike } from './run-view';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function run(over: Partial<RunLike> = {}): RunLike {
  return {
    runId: 'run-1',
    taskId: 't-1',
    attempt: 1,
    state: 'running',
    failureCategory: null,
    startedAt: '2026-08-18T11:00:00.000Z',
    lastHeartbeatAt: '2026-08-18T11:59:00.000Z',
    stopRequestedAt: null,
    endedAt: null,
    createdAt: '2026-08-18T10:59:00.000Z',
    updatedAt: '2026-08-18T11:59:00.000Z',
    ...over,
  };
}

describe('the run vocabulary is the contract, not a local copy', () => {
  it('uses the contract state list verbatim', () => {
    expect(RUN_STATE_ORDER).toEqual(RUN_STATES);
  });

  it('every state the database can store maps to a distinct phase', () => {
    const phases = RUN_STATES.map((s) => toRunView(run({ state: s, endedAt: s === 'running' || s === 'queued' ? null : '2026-08-18T11:58:00.000Z' }), NOW).phase);
    expect(phases).toEqual(['waiting', 'active', 'succeeded', 'failed', 'cancelled']);
  });

  it('an unrecognised state is reported as unknown, never as succeeded', () => {
    // Deny-by-default. Showing an unclassifiable run as finished-well is the direction that misleads.
    const v = toRunView(run({ state: 'teleported' }), NOW);
    expect(v.phase).toBe('unknown');
    expect(v.stateLabel).toContain('teleported');
  });
});

describe('a heartbeat is evidence, not a verdict', () => {
  it('reports the age of the last heartbeat on a running run', () => {
    const v = toRunView(run({ state: 'running', lastHeartbeatAt: '2026-08-18T11:58:00.000Z' }), NOW);
    expect(v.heartbeatAgeSeconds).toBe(120);
  });

  it('flags a stale heartbeat WITHOUT declaring the worker lost', () => {
    // `worker_lost` is a failure category the SERVER assigns. A screen that concluded it from a timestamp
    // would be reporting a server ruling that had not been made.
    const v = toRunView(run({ state: 'running', lastHeartbeatAt: '2026-08-18T11:00:00.000Z' }), NOW);
    expect(v.heartbeatStale).toBe(true);
    expect(v.heartbeatNote.toLowerCase()).not.toContain('lost');
    expect(v.heartbeatNote.toLowerCase()).not.toContain('dead');
  });

  it('says nothing about heartbeats for a run that has ended', () => {
    // A finished run stops beating by design; "stale" there would be alarming and meaningless.
    const v = toRunView(run({ state: 'succeeded', endedAt: '2026-08-18T11:30:00.000Z', lastHeartbeatAt: '2026-08-18T11:29:00.000Z' }), NOW);
    expect(v.heartbeatStale).toBe(false);
    expect(v.heartbeatNote).toBe('');
  });

  it('a running run that never beat at all is reported as never, not as age zero', () => {
    const v = toRunView(run({ state: 'running', lastHeartbeatAt: null }), NOW);
    expect(v.heartbeatAgeSeconds).toBeNull();
    expect(v.heartbeatNote.toLowerCase()).toContain('never');
  });
});

describe('a requested stop that has not taken effect is its own state', () => {
  it('is surfaced while the run is still going', () => {
    const v = toRunView(run({ state: 'running', stopRequestedAt: '2026-08-18T11:55:00.000Z', endedAt: null }), NOW);
    expect(v.stopPending).toBe(true);
    expect(v.stopNote.toLowerCase()).toContain('not stopped');
  });

  it('is NOT reported once the run has ended', () => {
    const v = toRunView(run({ state: 'cancelled', stopRequestedAt: '2026-08-18T11:55:00.000Z', endedAt: '2026-08-18T11:56:00.000Z' }), NOW);
    expect(v.stopPending).toBe(false);
  });
});

describe('failure detail follows the constraint that ties category to state', () => {
  it('surfaces every category the database can store', () => {
    for (const c of RUN_FAILURE_CATEGORIES) {
      const v = toRunView(run({ state: 'failed', failureCategory: c, endedAt: '2026-08-18T11:30:00.000Z' }), NOW);
      expect(v.failureLabel, c).toContain(c.replace(/_/g, ' '));
    }
  });

  it('a failed run with NO category is called out rather than rendered blank', () => {
    // TASK-006's "no blank failures". The CHECK permits it only in the sense that null is allowed; a failed
    // run reaching this screen without one is a gap the screen must name, not paper over.
    const v = toRunView(run({ state: 'failed', failureCategory: null, endedAt: '2026-08-18T11:30:00.000Z' }), NOW);
    expect(v.failureLabel.toLowerCase()).toContain('did not record');
  });

  it('ignores a category on a run that did not fail, because the constraint forbids that pairing', () => {
    const v = toRunView(run({ state: 'running', failureCategory: 'timeout' }), NOW);
    expect(v.failureLabel).toBe('');
  });
});

describe('duration', () => {
  it('measures a finished run from start to end, not to now', () => {
    const v = toRunView(run({ state: 'succeeded', startedAt: '2026-08-18T11:00:00.000Z', endedAt: '2026-08-18T11:10:00.000Z' }), NOW);
    expect(v.durationSeconds).toBe(600);
  });

  it('measures a running run from start to NOW', () => {
    const v = toRunView(run({ state: 'running', startedAt: '2026-08-18T11:00:00.000Z', endedAt: null }), NOW);
    expect(v.durationSeconds).toBe(3600);
  });

  it('a run that never started has no duration rather than zero', () => {
    const v = toRunView(run({ state: 'queued', startedAt: null, endedAt: null }), NOW);
    expect(v.durationSeconds).toBeNull();
  });
});

describe('lineage', () => {
  function lineage(over: Partial<LineageLike> = {}): LineageLike {
    return {
      artifact: { artifactId: 'a-1', title: 'Pilot page', format: 'markdown', runId: 'run-1', createdAt: '2026-08-18T11:10:00.000Z' },
      revisedFrom: null,
      revisions: [],
      ...over,
    };
  }

  it('an original says it is an original, not that its origin is unknown', () => {
    // `revisedFrom` is "null when it is an original — derived, never stored". Rendering that as unknown would
    // turn a fact into a gap.
    const v = toLineageView(lineage({ revisedFrom: null }));
    expect(v.isOriginal).toBe(true);
    expect(v.originNote.toLowerCase()).toContain('original');
    expect(v.originNote.toLowerCase()).not.toContain('unknown');
  });

  it('a revision names what it was a revision OF, with the guidance that asked for it', () => {
    const v = toLineageView(lineage({ revisedFrom: { revisionId: 'r-1', originalArtifactId: 'a-0', newTaskId: 't-2', guidance: 'Make it shorter.', requestedAt: '2026-08-18T11:05:00.000Z' } }));
    expect(v.isOriginal).toBe(false);
    expect(v.revisedFrom?.guidance).toBe('Make it shorter.');
  });

  it('no revisions means none were asked for — empty is never conflated with unknown', () => {
    const v = toLineageView(lineage({ revisions: [] }));
    expect(v.revisions).toEqual([]);
    expect(v.revisionsNote.toLowerCase()).toContain('none');
  });

  it('a FULL page of revisions says there may be more', () => {
    // `MAX_REVISIONS_RETURNED = 50`. A full page is indistinguishable from a full page with more behind it —
    // the same trap ACBP-FE-016 shipped as a blocker.
    const many = Array.from({ length: MAX_REVISIONS }, (_, i) => ({ revisionId: `r-${String(i)}`, originalArtifactId: 'a-1', newTaskId: `t-${String(i)}`, guidance: 'g', requestedAt: '2026-08-18T11:05:00.000Z' }));
    const v = toLineageView(lineage({ revisions: many }));
    expect(v.possiblyTruncated).toBe(true);
    expect(v.revisionsNote.toLowerCase()).toContain('more');
  });

  it('a partial page makes no such claim', () => {
    const v = toLineageView(lineage({ revisions: [{ revisionId: 'r-1', originalArtifactId: 'a-1', newTaskId: 't-2', guidance: 'g', requestedAt: '2026-08-18T11:05:00.000Z' }] }));
    expect(v.possiblyTruncated).toBe(false);
  });

  it('the mirrored cap matches the contract', () => {
    expect(MAX_REVISIONS).toBe(50);
  });
});
