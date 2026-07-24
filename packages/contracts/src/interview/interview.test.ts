// @acbp/contracts — interview session lifecycle contract tests (ACBP-P2-001; CDR-022). The state machine is the
// server-enforced truth (WORKFLOW-STATE-MACHINES §2); these pin the closed state set, the exact legal-transition
// map, honest display projection, and the terminal/open helpers. Pure — no IO.
import { describe, test, expect } from 'vitest';
import {
  INTERVIEW_SESSION_STATES,
  INITIAL_INTERVIEW_SESSION_STATE,
  isInterviewSessionState,
  isLegalInterviewTransition,
  legalInterviewSuccessors,
  isOpenInterviewState,
  isTerminalInterviewState,
  toInterviewDisplayPhase,
  type InterviewSessionState,
} from './index.js';

describe('interview session states', () => {
  test('the closed set is exactly the six canonical states in lifecycle order', () => {
    expect(INTERVIEW_SESSION_STATES).toEqual(['not_started', 'in_progress', 'waiting_for_user', 'ready_for_review', 'confirmed', 'superseded']);
  });

  test('the initial state is not_started', () => {
    expect(INITIAL_INTERVIEW_SESSION_STATE).toBe('not_started');
  });

  test('isInterviewSessionState accepts every registered state and rejects everything else', () => {
    for (const s of INTERVIEW_SESSION_STATES) expect(isInterviewSessionState(s)).toBe(true);
    for (const bad of ['', 'started', 'in-progress', 'InProgress', 'done', 42, null, undefined, {}, ['in_progress']]) {
      expect(isInterviewSessionState(bad)).toBe(false);
    }
  });
});

describe('legal transitions (WORKFLOW §2)', () => {
  // The COMPLETE truth table: exactly these ordered pairs are legal, all others illegal.
  const LEGAL: ReadonlyArray<[InterviewSessionState, InterviewSessionState]> = [
    ['not_started', 'in_progress'],
    ['in_progress', 'waiting_for_user'],
    ['in_progress', 'ready_for_review'],
    ['waiting_for_user', 'in_progress'],
    ['ready_for_review', 'confirmed'],
    ['confirmed', 'superseded'],
  ];

  test('every canonical legal transition is permitted', () => {
    for (const [from, to] of LEGAL) expect(isLegalInterviewTransition(from, to), `${from}->${to} should be legal`).toBe(true);
  });

  test('every non-canonical (from,to) pair is rejected (full matrix)', () => {
    const legalSet = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    for (const from of INTERVIEW_SESSION_STATES) {
      for (const to of INTERVIEW_SESSION_STATES) {
        const expected = legalSet.has(`${from}->${to}`);
        expect(isLegalInterviewTransition(from, to), `${from}->${to}`).toBe(expected);
      }
    }
  });

  test('no state transitions to itself', () => {
    for (const s of INTERVIEW_SESSION_STATES) expect(isLegalInterviewTransition(s, s), `${s}->${s}`).toBe(false);
  });

  test('the in_progress⇄waiting_for_user resume cycle is bidirectional', () => {
    expect(isLegalInterviewTransition('in_progress', 'waiting_for_user')).toBe(true);
    expect(isLegalInterviewTransition('waiting_for_user', 'in_progress')).toBe(true);
  });

  test('legalInterviewSuccessors returns the exact successor set and is a defensive copy', () => {
    expect(legalInterviewSuccessors('not_started')).toEqual(['in_progress']);
    expect(legalInterviewSuccessors('in_progress')).toEqual(['waiting_for_user', 'ready_for_review']);
    expect(legalInterviewSuccessors('waiting_for_user')).toEqual(['in_progress']);
    expect(legalInterviewSuccessors('ready_for_review')).toEqual(['confirmed']);
    expect(legalInterviewSuccessors('confirmed')).toEqual(['superseded']);
    expect(legalInterviewSuccessors('superseded')).toEqual([]);
    const copy = legalInterviewSuccessors('in_progress');
    (copy as InterviewSessionState[]).push('confirmed');
    expect(legalInterviewSuccessors('in_progress')).toEqual(['waiting_for_user', 'ready_for_review']); // unchanged
  });
});

describe('terminal / open helpers', () => {
  test('only superseded is fully terminal (no outgoing transition)', () => {
    expect(isTerminalInterviewState('superseded')).toBe(true);
    for (const s of INTERVIEW_SESSION_STATES.filter((x) => x !== 'superseded')) {
      expect(isTerminalInterviewState(s), `${s} should not be terminal`).toBe(false);
    }
  });

  test('a session is open in every state except superseded (the one-open-session-per-company cardinality)', () => {
    for (const s of INTERVIEW_SESSION_STATES) {
      expect(isOpenInterviewState(s)).toBe(s !== 'superseded');
    }
  });

  test('confirmed is open (still the current session) yet not fully terminal (can supersede)', () => {
    expect(isOpenInterviewState('confirmed')).toBe(true);
    expect(isTerminalInterviewState('confirmed')).toBe(false);
  });
});

describe('honest display projection', () => {
  test('maps each state to its client phase', () => {
    expect(toInterviewDisplayPhase('not_started')).toBe('not_started');
    expect(toInterviewDisplayPhase('in_progress')).toBe('in_progress');
    expect(toInterviewDisplayPhase('waiting_for_user')).toBe('awaiting_input');
    expect(toInterviewDisplayPhase('ready_for_review')).toBe('in_review');
    expect(toInterviewDisplayPhase('confirmed')).toBe('confirmed');
    expect(toInterviewDisplayPhase('superseded')).toBe('superseded');
  });

  test('an unrecognized value renders as unknown — never a fabricated healthy phase', () => {
    for (const bad of ['', 'active', 'paused', 'INPROGRESS', 42, null, undefined, {}]) {
      expect(toInterviewDisplayPhase(bad)).toBe('unknown');
    }
  });
});
