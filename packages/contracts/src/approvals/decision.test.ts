// @acbp/contracts — approval DECISIONS (ACBP-P6-003a; CDR-068 §2-G1/G3; APPR-007; invariant 5).
//
// Written before the implementation. Two gates:
//   G1 — the deciding actor type is a TYPE, not a check. A worker/model actor must not be EXPRESSIBLE.
//   G3 — five decision paths, closed, each recording what it did; only explicitly-approving paths authorize.
//
// Invariant 5 is the authority chain's non-negotiable property — *"the AI model can never mark its own action
// approved"* — so the tests that matter most here are the ones asserting something cannot be said at all.
import { describe, test, expect } from 'vitest';
import {
  APPROVAL_DECISION_PATHS,
  APPROVAL_DECIDER_TYPES,
  isApprovalDecisionPath,
  isApprovalDeciderType,
  authorizesExecution,
  parseApprovalDecision,
  type ApprovalDecisionInput,
} from './decision.js';

const human = { type: 'human', userId: '11111111-1111-4111-8111-111111111111' } as const;
const at = new Date('2026-07-30T09:00:00.000Z');

describe('the five decision paths are CLOSED (CDR-068 §2-G3)', () => {
  test('exactly the five API-CONTRACTS names, in canon order', () => {
    expect([...APPROVAL_DECISION_PATHS]).toEqual(['approve', 'reject', 'edit_then_approve', 'schedule', 'batch_approve']);
    for (const p of APPROVAL_DECISION_PATHS) expect(isApprovalDecisionPath(p)).toBe(true);
  });

  test('the guard is total over `unknown`, and nothing unrecognised slips in as a path', () => {
    for (const junk of [undefined, null, '', 'APPROVE', 'approve ', 'auto_approve', 'revoke', 0, true, {}, []]) {
      expect(isApprovalDecisionPath(junk)).toBe(false);
    }
  });

  test('`revoke` is NOT a decision path here — it is P6-004', () => {
    // Revocation appears in the same API-CONTRACTS row, so it is an easy sixth to add by accident. It belongs to
    // ADR-009 §2's consumption/revocation half, which this ticket explicitly does not own.
    expect(isApprovalDecisionPath('revoke')).toBe(false);
  });
});

describe('INVARIANT 5 — a model actor cannot approve, and cannot even be EXPRESSED (CDR-068 §2-G1)', () => {
  test('only human and delegated are decider types', () => {
    expect([...APPROVAL_DECIDER_TYPES]).toEqual(['human', 'delegated']);
    expect(isApprovalDeciderType('human')).toBe(true);
    expect(isApprovalDeciderType('delegated')).toBe(true);
  });

  test('the audit actor types that are NOT approval deciders are rejected by name', () => {
    // `worker` is invariant 5 itself. `system` and `admin` are the ones worth being explicit about: both are
    // non-model, both exist in AUDIT_ACTOR_TYPES, and neither is a company human exercising their own authority.
    // A platform admin approving a company's action would be authority the owner never granted.
    for (const t of ['worker', 'system', 'admin']) expect(isApprovalDeciderType(t)).toBe(false);
    for (const junk of [undefined, null, '', 'HUMAN', 'user', 0, {}]) expect(isApprovalDeciderType(junk)).toBe(false);
  });

  test('COMPILE TIME: a worker decider is not expressible', () => {
    // Self-verifying. If `worker` ever becomes an accepted decider type, the expected error disappears and the
    // TYPECHECK fails — no runtime test needed, and no tooling. This is the structural half of G1.
    // @ts-expect-error — `worker` is not an approval decider type (invariant 5)
    const forged: ApprovalDecisionInput = { path: 'approve', decidedBy: { type: 'worker', userId: 'w1' }, decidedAt: at };
    // …and the runtime guard refuses it too, because a JS caller has no typechecker.
    expect(parseApprovalDecision(forged).status).toBe('actor_not_permitted');
  });

  test('COMPILE TIME: nor is `system` or `admin`', () => {
    // @ts-expect-error — `system` is not an approval decider type
    const asSystem: ApprovalDecisionInput = { path: 'approve', decidedBy: { type: 'system', userId: 's1' }, decidedAt: at };
    // @ts-expect-error — `admin` is not an approval decider type
    const asAdmin: ApprovalDecisionInput = { path: 'approve', decidedBy: { type: 'admin', userId: 'a1' }, decidedAt: at };
    expect(parseApprovalDecision(asSystem).status).toBe('actor_not_permitted');
    expect(parseApprovalDecision(asAdmin).status).toBe('actor_not_permitted');
  });

  test('a decider with no identity is refused — an anonymous approval is not an approval', () => {
    for (const userId of ['', '   ', undefined as unknown as string]) {
      expect(parseApprovalDecision({ path: 'approve', decidedBy: { type: 'human', userId }, decidedAt: at }).status).toBe('actor_not_permitted');
    }
  });
});

describe('each path records what it DID, and refuses without it (CDR-068 §2-G3)', () => {
  test('approve needs nothing beyond the decider', () => {
    const r = parseApprovalDecision({ path: 'approve', decidedBy: human, decidedAt: at });
    expect(r.status).toBe('ok');
  });

  test('reject REQUIRES a reason — a refusal nobody can act on is not a decision', () => {
    expect(parseApprovalDecision({ path: 'reject', decidedBy: human, decidedAt: at }).status).toBe('missing_detail');
    for (const blank of ['', '  ']) {
      expect(parseApprovalDecision({ path: 'reject', decidedBy: human, decidedAt: at, reason: blank }).status).toBe('missing_detail');
    }
    const ok = parseApprovalDecision({ path: 'reject', decidedBy: human, decidedAt: at, reason: 'Supplier list is out of date' });
    expect(ok.status).toBe('ok');
    if (ok.status !== 'ok') return;
    expect(ok.decision.reason).toBe('Supplier list is out of date');
  });

  test('edit_then_approve REQUIRES the edited payload, and is marked as SUPERSEDING', () => {
    expect(parseApprovalDecision({ path: 'edit_then_approve', decidedBy: human, decidedAt: at }).status).toBe('missing_detail');
    const ok = parseApprovalDecision({ path: 'edit_then_approve', decidedBy: human, decidedAt: at, editedData: { recipients: 2 } });
    expect(ok.status).toBe('ok');
    if (ok.status !== 'ok') return;
    // Canon §2's material-change rule: an edit creates a NEW bound payload and supersedes the old request; it never
    // mutates it (invariant 7). The flag is what a caller must honour; the rebinding itself is P6-004.
    expect(ok.decision.supersedes).toBe(true);
    // THE PAYLOAD ITSELF IS CARRIED. Deleting the `editedData` spread from `parseApprovalDecision` left all 190
    // contract tests green — the sibling `memberRequestIds` assertion caught its equivalent, this one was simply
    // missing. The human's substitute silently vanishing is the whole failure mode this path exists to avoid.
    expect(ok.decision.editedData).toEqual({ recipients: 2 });
  });

  test('an EMPTY edit is not an edit — `{}` is refused rather than superseding on a change nobody made', () => {
    // It passed the type, the `is not null` CHECK and the shape branch while meaning "I changed nothing".
    expect(parseApprovalDecision({ path: 'edit_then_approve', decidedBy: human, decidedAt: at, editedData: {} }).status).toBe('missing_detail');
  });

  test('schedule REQUIRES the instant, and the instant is an INPUT', () => {
    expect(parseApprovalDecision({ path: 'schedule', decidedBy: human, decidedAt: at }).status).toBe('missing_detail');
    const ok = parseApprovalDecision({ path: 'schedule', decidedBy: human, decidedAt: at, effectiveFrom: new Date('2026-07-31T09:00:00.000Z') });
    expect(ok.status).toBe('ok');
    if (ok.status !== 'ok') return;
    expect(ok.decision.effectiveFrom?.toISOString()).toBe('2026-07-31T09:00:00.000Z');
  });

  test('batch_approve REQUIRES enumerated members — a batch that names nobody authorizes nobody', () => {
    expect(parseApprovalDecision({ path: 'batch_approve', decidedBy: human, decidedAt: at }).status).toBe('missing_detail');
    expect(parseApprovalDecision({ path: 'batch_approve', decidedBy: human, decidedAt: at, memberRequestIds: [] }).status).toBe('missing_detail');
    const ok = parseApprovalDecision({ path: 'batch_approve', decidedBy: human, decidedAt: at, memberRequestIds: ['r1', 'r2'] });
    expect(ok.status).toBe('ok');
    if (ok.status !== 'ok') return;
    // Canon: *"batch enumerates members"* — each member is its own bound payload with its own outcome (APPR-007).
    expect(ok.decision.memberRequestIds).toEqual(['r1', 'r2']);
  });

  test('an unrecognised path is refused, never defaulted', () => {
    expect(parseApprovalDecision({ path: 'auto_approve' as never, decidedBy: human, decidedAt: at }).status).toBe('unknown_path');
  });
});

describe('only explicitly-approving paths AUTHORIZE (the safety property)', () => {
  test('reject never authorizes', () => {
    expect(authorizesExecution({ path: 'reject', decidedAt: at })).toBe(false);
  });

  test('approve, edit_then_approve and batch_approve authorize', () => {
    for (const path of ['approve', 'edit_then_approve', 'batch_approve'] as const) {
      expect(authorizesExecution({ path, decidedAt: at })).toBe(true);
    }
  });

  test('SCHEDULE does not authorize before its instant, and does at or after it', () => {
    // The safer reading, taken deliberately: a scheduled approval is a promise about a future moment, not a present
    // authorization. Treating it as effective immediately would let a human who deliberately deferred an action find
    // it already done.
    const effectiveFrom = new Date('2026-07-31T09:00:00.000Z');
    expect(authorizesExecution({ path: 'schedule', decidedAt: at, effectiveFrom }, new Date('2026-07-31T08:59:59.999Z'))).toBe(false);
    expect(authorizesExecution({ path: 'schedule', decidedAt: at, effectiveFrom }, effectiveFrom)).toBe(true);
    expect(authorizesExecution({ path: 'schedule', decidedAt: at, effectiveFrom }, new Date('2026-08-01T00:00:00.000Z'))).toBe(true);
  });

  test('a schedule with NO instant, or an unreadable one, does not authorize', () => {
    // Fail-closed on a missing or junk clock value. `parseApprovalDecision` already refuses to build this, so it can
    // only arrive from a corrupt row — and the fail-closed reading of a corrupt schedule is "not yet".
    expect(authorizesExecution({ path: 'schedule', decidedAt: at })).toBe(false);
    expect(authorizesExecution({ path: 'schedule', decidedAt: at, effectiveFrom: new Date('nonsense') }, at)).toBe(false);
  });

  test('the NOW used for a schedule comparison is an INPUT, never ambient', () => {
    // Same discipline as CDR-066 §3-G3 for the policy evaluator: a decision that reads the wall clock cannot be
    // re-derived from its own record, so "was this authorized at time T?" stops being answerable.
    const effectiveFrom = new Date('2026-07-31T09:00:00.000Z');
    expect(authorizesExecution({ path: 'schedule', decidedAt: at, effectiveFrom }, new Date('2026-07-30T00:00:00.000Z'))).toBe(false);
    expect(authorizesExecution({ path: 'schedule', decidedAt: at, effectiveFrom }, new Date('2026-12-31T00:00:00.000Z'))).toBe(true);
  });

  test('and it is TOTAL over junk paths — an unreadable decision authorizes nothing', () => {
    for (const junk of [undefined, null, '', 'approve ', 'APPROVE', 'revoke', 0, {}]) {
      // No cast needed, and that is the point: `authorizesExecution` takes `unknown` for `path` precisely so a value
      // read back from a database column can be handed to it without a lie about its type.
      expect(authorizesExecution({ path: junk, decidedAt: at })).toBe(false);
    }
  });
});
