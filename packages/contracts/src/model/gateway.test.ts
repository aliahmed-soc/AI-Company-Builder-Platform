// @acbp/contracts — model gateway contract tests (ACBP-P2-003; ADR-011, ADR-019; CDR-026). Pure.
// Pins the config vocabulary (IOQ-13 timeout/retry values), the task-class → timeout/fallback policy,
// the exact seven-value error taxonomy, retryability, and the public-envelope mapping.
import { describe, test, expect } from 'vitest';
import {
  TIMEOUT_CLASS_MS,
  MAX_RETRY_ATTEMPTS,
  MAX_REASK_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS,
  TASK_CLASS_POLICY,
  timeoutClassForTask,
  isFallbackEligible,
  timeoutMsForTask,
  isRetryableModelError,
  toErrorCategory,
  type TaskClass,
  type TimeoutClass,
  type ModelErrorCategory,
} from './index.js';

const ALL_TASK_CLASSES: TaskClass[] = ['interactive', 'extraction', 'classification', 'generation'];
const ALL_TIMEOUT_CLASSES: TimeoutClass[] = ['interactive', 'generation'];
const ALL_ERRORS: ModelErrorCategory[] = ['timeout', 'rate_limited', 'provider_unavailable', 'invalid_output', 'content_refused', 'budget_exceeded', 'internal'];

describe('IOQ-13 ratified config (CDR-026 §1)', () => {
  test('per-class timeouts: interactive ~30s, generation ~120s', () => {
    expect(TIMEOUT_CLASS_MS.interactive).toBe(30_000);
    expect(TIMEOUT_CLASS_MS.generation).toBe(120_000);
    expect(Object.keys(TIMEOUT_CLASS_MS).sort()).toEqual([...ALL_TIMEOUT_CLASSES].sort());
  });
  test('bounded retries ≤ 2, bounded re-ask ≤ 1, positive backoff base', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(2);
    expect(MAX_REASK_ATTEMPTS).toBe(1);
    expect(RETRY_BACKOFF_BASE_MS).toBeGreaterThan(0);
  });
  test('config tables are frozen (config, not runtime-mutable)', () => {
    expect(Object.isFrozen(TIMEOUT_CLASS_MS)).toBe(true);
    expect(Object.isFrozen(TASK_CLASS_POLICY)).toBe(true);
  });
});

describe('task-class policy (CDR-026 §2)', () => {
  test('every task class maps to a timeout class + fallback flag', () => {
    for (const tc of ALL_TASK_CLASSES) {
      expect(ALL_TIMEOUT_CLASSES).toContain(timeoutClassForTask(tc));
      expect(typeof isFallbackEligible(tc)).toBe('boolean');
      expect(timeoutMsForTask(tc)).toBe(TIMEOUT_CLASS_MS[timeoutClassForTask(tc)]);
    }
  });
  test('quality-bearing generation is fallback-INELIGIBLE and uses the generation timeout', () => {
    expect(isFallbackEligible('generation')).toBe(false);
    expect(timeoutClassForTask('generation')).toBe('generation');
    expect(timeoutMsForTask('generation')).toBe(120_000);
  });
  test('interactive/extraction/classification are fallback-eligible on the interactive timeout', () => {
    for (const tc of ['interactive', 'extraction', 'classification'] as const) {
      expect(isFallbackEligible(tc)).toBe(true);
      expect(timeoutClassForTask(tc)).toBe('interactive');
      expect(timeoutMsForTask(tc)).toBe(30_000);
    }
  });
});

describe('normalized error taxonomy (ADR-011 §5 — exactly seven)', () => {
  test('the seven categories and their retryability', () => {
    expect(ALL_ERRORS).toHaveLength(7);
    expect(ALL_ERRORS.filter(isRetryableModelError)).toEqual(['timeout', 'rate_limited', 'provider_unavailable']);
    for (const terminal of ['invalid_output', 'content_refused', 'budget_exceeded', 'internal'] as const) {
      expect(isRetryableModelError(terminal)).toBe(false);
    }
  });
  test('maps each normalized error onto a platform public ErrorCategory', () => {
    expect(toErrorCategory('timeout')).toBe('provider_unavailable');
    expect(toErrorCategory('provider_unavailable')).toBe('provider_unavailable');
    expect(toErrorCategory('rate_limited')).toBe('limit_exceeded');
    expect(toErrorCategory('budget_exceeded')).toBe('limit_exceeded');
    expect(toErrorCategory('content_refused')).toBe('policy_blocked');
    expect(toErrorCategory('invalid_output')).toBe('internal');
    expect(toErrorCategory('internal')).toBe('internal');
  });
});
