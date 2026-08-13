// ACBP-API-003 (CDR-089 §2) — the run-read DTO allowlist.
//
// `TaskRunRow` is a RAW DATABASE ROW (`Selectable<TaskRunsTable>`). CDR-089 §2 requires an ALLOWLIST mapper for
// the same reason the approvals inbox has one — and that guard is the single cleanly mutation-proven kill in
// slice 2 (run 31638284349). This file is the equivalent guard for runs, written BEFORE the mapper exists.
import { describe, test, expect } from 'vitest';
import { toTaskRunDTO } from './run-read.js';

describe('CDR-089 §2 — the run DTO is an ALLOWLIST, not a redaction', () => {
  // Every column of task_runs, with a sentinel in each one that must NOT be published.
  const ROW = {
    id: 'run_1',
    account_id: 'acc_SECRET',
    company_id: 'co_SECRET',
    task_id: 'task_1',
    attempt: 2,
    state: 'failed',
    failure_category: 'timeout',
    started_at: new Date('2026-01-01T00:00:00.000Z'),
    last_heartbeat_at: new Date('2026-01-01T00:01:00.000Z'),
    stop_requested_at: null,
    ended_at: new Date('2026-01-01T00:02:00.000Z'),
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:02:00.000Z'),
  } as never;

  test('no TENANT id is ever published', () => {
    const serialized = JSON.stringify(toTaskRunDTO(ROW));
    for (const secret of ['acc_SECRET', 'co_SECRET']) {
      expect(serialized, `${secret} is internal scoping and must not reach the wire`).not.toContain(secret);
    }
  });

  test('the DTO carries EXACTLY the allowlisted keys, so a NEW COLUMN cannot arrive unnoticed', () => {
    // This is the assertion that makes it an allowlist rather than a redaction: a column added to task_runs
    // later stays invisible until a human adds it here and updates this list.
    expect(Object.keys(toTaskRunDTO(ROW)).sort()).toEqual(
      ['attempt', 'createdAt', 'endedAt', 'failureCategory', 'lastHeartbeatAt', 'runId', 'startedAt', 'state', 'stopRequestedAt', 'taskId', 'updatedAt'],
    );
  });

  test('failure_category IS published, and that is deliberate', () => {
    // The schema documents it as a CLOSED category, never worker exception text. TASK-006 is precisely that a
    // founder must be able to see why a run failed, so withholding it would defeat the read's purpose.
    expect(toTaskRunDTO(ROW).failureCategory).toBe('timeout');
  });

  test('timestamps are serialized as ISO strings, and nulls stay null', () => {
    const dto = toTaskRunDTO(ROW);
    expect(dto.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(dto.stopRequestedAt).toBeNull();
  });
});
