/*
 * ACBP-FE-015 — task execution, mapped from the run and lineage reads.
 *
 * THE VOCABULARY IS IMPORTED, NEVER RESTATED. `RUN_STATES` and `RUN_FAILURE_CATEGORIES` are declared in
 * `@acbp/contracts` and CHECKed in the migration. ACBP-FE-016 shipped a screen whose invented risk vocabulary
 * matched no row the database could hold, and passed green because its tests fed values the constraint
 * forbids — so a fifth run state upstream must break this file's compile, not its meaning.
 *
 * WHAT THIS SCREEN MUST NOT CONCLUDE. `worker_lost` is a failure category the SERVER assigns after its own
 * rules fire. A stale heartbeat is EVIDENCE that may precede that ruling and is not the ruling: this mapper
 * reports the age and flags staleness, and deliberately never says a worker is lost, dead or gone. A screen
 * that announced it would be reporting a server decision that had not been made.
 *
 * THE CONSTRAINT BETWEEN state AND failure_category IS RELIED ON AND NAMED: migration 0033's CHECK is
 * `failure_category is null or (failure_category in (…) and state = 'failed')`. So a category on a running run
 * cannot exist and is ignored rather than rendered; and a FAILED run with no category is a real gap, which
 * TASK-006 ("no blank failures") says must be visible rather than papered over.
 */
import { MAX_REVISIONS_RETURNED } from '@acbp/core';
import { RUN_STATES, isRunState } from '@acbp/contracts';
import type { RunState } from '@acbp/contracts';

/** How old a heartbeat may get on a live run before this screen calls it stale. A JUDGEMENT, named as one:
 *  the platform states no heartbeat-warning policy, so this is the screen's threshold, not an enforced rule. */
const HEARTBEAT_STALE_SECONDS = 300;

/**
 * From `@acbp/core`, so it cannot drift from the cap the read actually applies.
 *
 * THIS MODULE IS SERVER-ONLY BECAUSE OF THIS IMPORT. `apps/web` may import `@acbp/core`, but a `'use client'`
 * module may not — that dragged the whole server composition graph across the boundary on ACBP-FE-010 and
 * `check:boundaries` PASSED it. This screen has no writes and therefore no client component; if one is ever
 * added, this constant must be mirrored and asserted rather than imported.
 */
export const MAX_REVISIONS = MAX_REVISIONS_RETURNED;

/** The contract's ordering, re-exported so a test can prove this file did not restate it. */
export const RUN_STATE_ORDER: readonly RunState[] = RUN_STATES;

export type RunPhase = 'waiting' | 'active' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export interface RunLike {
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly state: string;
  readonly failureCategory: string | null;
  readonly startedAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly stopRequestedAt: string | null;
  readonly endedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RevisionLike {
  readonly revisionId: string;
  readonly originalArtifactId: string;
  readonly newTaskId: string;
  readonly guidance: string;
  readonly requestedAt: string;
}

export interface LineageLike {
  readonly artifact: { readonly artifactId: string; readonly title: string; readonly format: string; readonly runId: string; readonly createdAt: string };
  readonly revisedFrom: RevisionLike | null;
  readonly revisions: readonly RevisionLike[];
}

export interface RunView {
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly phase: RunPhase;
  readonly stateLabel: string;
  readonly durationSeconds: number | null;
  readonly heartbeatAgeSeconds: number | null;
  readonly heartbeatStale: boolean;
  readonly heartbeatNote: string;
  readonly stopPending: boolean;
  readonly stopNote: string;
  readonly failureLabel: string;
}

export interface LineageView {
  readonly artifact: LineageLike['artifact'];
  readonly isOriginal: boolean;
  readonly originNote: string;
  readonly revisedFrom: RevisionLike | null;
  readonly revisions: readonly RevisionLike[];
  readonly possiblyTruncated: boolean;
  readonly revisionsNote: string;
}

const PHASE_OF: Readonly<Record<RunState, RunPhase>> = {
  queued: 'waiting',
  running: 'active',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};

function secondsBetween(from: string | null, to: number): number | null {
  if (from === null) return null;
  const at = Date.parse(from);
  return Number.isNaN(at) ? null : Math.round((to - at) / 1000);
}

export function toRunView(run: RunLike, now: number): RunView {
  const known = isRunState(run.state);
  const phase: RunPhase = known ? PHASE_OF[run.state] : 'unknown';
  const ended = run.endedAt !== null;

  const endedMs = run.endedAt === null ? null : Date.parse(run.endedAt);
  const durationSeconds = run.startedAt === null ? null : secondsBetween(run.startedAt, endedMs !== null && !Number.isNaN(endedMs) ? endedMs : now);

  // HEARTBEATS ONLY MEAN ANYTHING WHILE A RUN IS LIVE. A finished run stops beating by design, so reporting
  // staleness there would be alarming and meaningless.
  const live = !ended && (phase === 'active' || phase === 'waiting');
  const heartbeatAgeSeconds = live ? secondsBetween(run.lastHeartbeatAt, now) : null;
  const heartbeatStale = live && heartbeatAgeSeconds !== null && heartbeatAgeSeconds > HEARTBEAT_STALE_SECONDS;
  const heartbeatNote = !live
    ? ''
    : run.lastHeartbeatAt === null
      ? 'This run has never reported a heartbeat.'
      : heartbeatStale
        ? // NOT "the worker is lost". That is a category the server assigns; this is the observation only.
          `The last heartbeat was ${String(heartbeatAgeSeconds ?? 0)} seconds ago. The server has not ended this run, so it is still recorded as in progress — a long gap often precedes the server deciding otherwise, but this page is not making that call.`
        : `Last heartbeat ${String(heartbeatAgeSeconds ?? 0)} seconds ago.`;

  const stopPending = run.stopRequestedAt !== null && !ended;

  return {
    runId: run.runId,
    taskId: run.taskId,
    attempt: run.attempt,
    phase,
    stateLabel: known ? run.state : `${run.state} (a state this platform does not define)`,
    durationSeconds,
    heartbeatAgeSeconds,
    heartbeatStale,
    heartbeatNote,
    stopPending,
    stopNote: stopPending ? 'A stop was requested for this run and it has not stopped yet. It ends when the server records an end, not when the request is made.' : '',
    // The CHECK ties category to `state = 'failed'`, so a category anywhere else cannot exist and is ignored
    // rather than rendered as though it meant something.
    failureLabel:
      phase !== 'failed'
        ? ''
        : run.failureCategory === null
          ? 'This run failed and the server did not record why. That is a gap in the record, not an unknown cause you can investigate from here.'
          : `Failed: ${run.failureCategory.replace(/_/g, ' ')}.`,
  };
}

export function toLineageView(lineage: LineageLike): LineageView {
  const possiblyTruncated = lineage.revisions.length >= MAX_REVISIONS;
  return {
    artifact: lineage.artifact,
    // `revisedFrom: null` MEANS ORIGINAL — the contract says "derived, never stored". Rendering it as unknown
    // would turn a fact into a gap.
    isOriginal: lineage.revisedFrom === null,
    originNote: lineage.revisedFrom === null ? 'This is an original — it was not produced by revising an earlier artifact.' : 'This artifact was produced by revising an earlier one.',
    revisedFrom: lineage.revisedFrom,
    revisions: lineage.revisions,
    possiblyTruncated,
    revisionsNote:
      lineage.revisions.length === 0
        ? 'No revisions have been asked for. That is none, not unknown — the server lists them and returned an empty list.'
        : possiblyTruncated
          ? `Showing ${String(lineage.revisions.length)} revisions, which is the most one read returns, so there may be more.`
          : `${String(lineage.revisions.length)} revision${lineage.revisions.length === 1 ? '' : 's'} asked for, newest first.`,
  };
}
