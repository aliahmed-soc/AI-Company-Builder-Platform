// ACBP-P5-004 — worker definitions, made executable (CDR-056; WORK-001/006; ADR-012; trust-critical #4).
import { describe, test, expect } from 'vitest';
import {
  WORKER_STATES,
  isWorkerState,
  workerAcceptsTasks,
  MVP_MAX_ALLOWED_RISK_CLASS,
  isMvpSafeAllowlist,
  requiresApproval,
  DEFAULT_MAX_SPEND_MICROS,
  DEFAULT_MAX_DURATION_MS,
  isValidBudget,
} from './worker.js';
import { RISK_CLASSES, MOST_RESTRICTIVE_RISK_CLASS } from '../tools/risk-class.js';
import { DEFAULT_HEARTBEAT_GRACE_MS } from '../runs/run.js';

describe('worker states (WORK-006)', () => {
  test('are exactly enabled · paused · disabled', () => {
    expect([...WORKER_STATES]).toEqual(['enabled', 'paused', 'disabled']);
  });

  test('the guard is deny-by-default', () => {
    for (const s of WORKER_STATES) expect(isWorkerState(s)).toBe(true);
    for (const bad of ['ENABLED', 'on', '', 42, null, undefined, {}]) expect(isWorkerState(bad)).toBe(false);
  });

  test('ONLY `enabled` accepts new tasks — and an unknown state does not', () => {
    // WORK-006: "Disabled workers receive no new tasks." An unrecognised state is not permission.
    expect(workerAcceptsTasks('enabled')).toBe(true);
    for (const s of ['paused', 'disabled', 'nonsense', '', null, undefined, 42]) expect(workerAcceptsTasks(s)).toBe(false);
  });
});

describe('the MVP zero-external-actions boundary (ADR-012)', () => {
  test('the ceiling is `internal_reversible` — canon\'s own words', () => {
    // "All three run informational / internal-reversible risk classes only."
    expect(MVP_MAX_ALLOWED_RISK_CLASS).toBe('internal_reversible');
  });

  test('an allowlist of informational/internal-reversible tools is MVP-safe', () => {
    expect(isMvpSafeAllowlist([{ toolId: 'web_research', riskClass: 'informational' }, { toolId: 'memory_read', riskClass: 'internal_reversible' }])).toBe(true);
  });

  test('ANY external-effect tool makes it unsafe — the boundary is structural, not procedural', () => {
    for (const riskClass of ['external_reversible', 'external_irreversible']) {
      expect(isMvpSafeAllowlist([{ toolId: 'web_research', riskClass: 'informational' }, { toolId: 'send_email', riskClass }])).toBe(false);
    }
  });

  test('an UNCLASSIFIED tool makes it unsafe — unclassified resolves to the most restrictive class', () => {
    expect(isMvpSafeAllowlist([{ toolId: 'mystery', riskClass: null }])).toBe(false);
    expect(isMvpSafeAllowlist([{ toolId: 'mystery', riskClass: 'who_knows' }])).toBe(false);
    expect(MOST_RESTRICTIVE_RISK_CLASS).not.toBe(MVP_MAX_ALLOWED_RISK_CLASS);
  });

  test('an EMPTY allowlist is safe but useless — safety and usefulness are different questions', () => {
    expect(isMvpSafeAllowlist([])).toBe(true);
  });
});

describe('the approval profile is a THRESHOLD (CDR-056 §2-G3)', () => {
  test('NULL means nothing this worker does is approval-gated', () => {
    for (const riskClass of RISK_CLASSES) expect(requiresApproval(riskClass, null)).toBe(false);
  });

  test('a class at or above the threshold requires approval; below does not', () => {
    expect(requiresApproval('informational', 'internal_reversible')).toBe(false);
    expect(requiresApproval('internal_reversible', 'internal_reversible')).toBe(true);
    expect(requiresApproval('external_irreversible', 'internal_reversible')).toBe(true);
  });

  test('an UNCLASSIFIED call requires approval whatever the threshold — it resolves to most restrictive', () => {
    for (const threshold of RISK_CLASSES) expect(requiresApproval(null, threshold)).toBe(true);
    expect(requiresApproval('garbage', 'informational')).toBe(true);
  });

  test('an unrecognised THRESHOLD gates everything rather than nothing — the safe direction', () => {
    // A typo in a definition must not silently switch approval off for every class.
    for (const riskClass of RISK_CLASSES) expect(requiresApproval(riskClass, 'typo_class')).toBe(true);
  });
});

describe('budgets (IOQ-12 — interim, revisit-bound)', () => {
  test('the proposed defaults are the ones CDR-056 §3 records', () => {
    expect(DEFAULT_MAX_SPEND_MICROS).toBe(500_000);
    expect(DEFAULT_MAX_DURATION_MS).toBe(600_000);
  });

  test('the duration default leaves room for several heartbeat windows', () => {
    // A slow-but-live run must never be killed by this bound before the liveness sweep would have noticed.
    expect(DEFAULT_MAX_DURATION_MS / DEFAULT_HEARTBEAT_GRACE_MS).toBeGreaterThanOrEqual(5);
  });

  test('a budget must be a positive integer — zero, negative, fractional and non-finite are all refused', () => {
    expect(isValidBudget(1)).toBe(true);
    expect(isValidBudget(DEFAULT_MAX_SPEND_MICROS)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '500', null, undefined]) {
      expect(isValidBudget(bad)).toBe(false);
    }
  });
});
