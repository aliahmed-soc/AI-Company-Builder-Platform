// @acbp/contracts — approval REQUEST content (ACBP-P6-003a; CDR-068 §2-G2/G4/G5/G6; APPR-002, APPR-010).
//
// Written before the implementation. The gate under test is CDR-068 §2-G2: **an incomplete request is not a
// request.** APPR-002's failure clause is verbatim *"Full-content requirement blocks incomplete requests"*, and the
// reason it has to be refused at construction rather than validated later is that a stored request with a missing
// field is a request a human cannot evaluate — the inbox would render a blank where the consequence should be.
import { describe, test, expect } from 'vitest';
import { RISK_CLASSES } from '../tools/risk-class.js';
import {
  APPROVAL_REQUEST_CONTENT_FIELDS,
  APPROVAL_REQUEST_REQUIRED_INPUTS,
  DERIVED_APPROVAL_REQUEST_FIELDS,
  APPROVAL_SCOPES,
  MVP_APPROVAL_SCOPES,
  isApprovalScope,
  isMvpApprovalScope,
  reversibilityOf,
  buildApprovalRequest,
  type ApprovalRequestInput,
} from './request.js';

/** A complete, valid input. Each test breaks exactly one thing about it, so failures name their own cause. */
const complete = (): ApprovalRequestInput => ({
  toolId: 'send_email',
  toolVersion: 1,
  riskClass: 'external_reversible',
  scope: 'one_action',
  action: 'Send the introduction email to the three shortlisted suppliers',
  reason: 'The supplier shortlist was confirmed and outreach is the next planned step',
  expectedResult: 'Three emails delivered; replies tracked against the supplier task',
  data: { recipients: 3, template: 'supplier_intro' },
  estimatedCostCredits: 1,
  preview: 'To: 3 suppliers\nSubject: Introduction\n\nHello — we are evaluating suppliers for…',
  policyVersion: 1,
});

describe('APPR-002 content completeness — an incomplete request is refused, never stored with nulls', () => {
  test('a complete input builds, and carries every content field canon names', () => {
    const built = buildApprovalRequest(complete());
    expect(built.status).toBe('ok');
    if (built.status !== 'ok') return;
    // Diagram 08's request node names the set verbatim: action, reason, expected result, data, cost, risk,
    // reversibility, preview. All eight must be present on the built request.
    for (const field of APPROVAL_REQUEST_CONTENT_FIELDS) {
      expect(built.request[field]).toBeDefined();
    }
  });

  test('the two lists cannot drift: content = required inputs ∪ derived', () => {
    // THIS TEST EXISTS BECAUSE THE FIRST VERSION OF THIS SUITE CONFLATED THEM. One list served both "what canon
    // requires the stored request to contain" and "what a caller must supply", so the loop below demanded that
    // omitting `risk` refuse the request — incoherent, since `risk` is not an input and an unreadable `riskClass`
    // resolves rather than refuses. Asserting the set relationship means a future field added to one list and not the
    // other fails here instead of quietly escaping validation.
    expect([...APPROVAL_REQUEST_REQUIRED_INPUTS, ...DERIVED_APPROVAL_REQUEST_FIELDS].sort()).toEqual([...APPROVAL_REQUEST_CONTENT_FIELDS].sort());
    expect(APPROVAL_REQUEST_REQUIRED_INPUTS.some((f) => (DERIVED_APPROVAL_REQUEST_FIELDS as readonly string[]).includes(f))).toBe(false);
  });

  test('EVERY required INPUT, missing in turn, refuses the request and NAMES the field', () => {
    // A loop rather than six tests, because the point is that no field is exempt — and a reason that names the
    // field is what makes the refusal actionable instead of a shrug.
    for (const field of APPROVAL_REQUEST_REQUIRED_INPUTS) {
      const broken = { ...complete() } as Record<string, unknown>;
      delete broken[field];
      const r = buildApprovalRequest(broken as unknown as ApprovalRequestInput);
      expect(r.status, `missing ${field} must refuse`).toBe('incomplete');
      if (r.status !== 'incomplete') continue;
      expect(r.missing, `refusal for ${field} must name it`).toContain(field);
    }
  });

  test('a BLANK string is missing content, not present content', () => {
    // The failure this prevents is a caller satisfying the shape while saying nothing — `action: ''` renders as an
    // empty line in the inbox and a human approves a blank.
    for (const blank of ['', '   ', '\n\t ']) {
      expect(buildApprovalRequest({ ...complete(), action: blank }).status).toBe('incomplete');
      expect(buildApprovalRequest({ ...complete(), reason: blank }).status).toBe('incomplete');
      expect(buildApprovalRequest({ ...complete(), expectedResult: blank }).status).toBe('incomplete');
    }
  });

  test('all missing fields are reported AT ONCE, not one per attempt', () => {
    const r = buildApprovalRequest({ toolId: 'send_email', toolVersion: 1, riskClass: 'external_reversible', scope: 'one_action', policyVersion: 1 } as ApprovalRequestInput);
    expect(r.status).toBe('incomplete');
    if (r.status !== 'incomplete') return;
    expect(r.missing).toEqual(expect.arrayContaining(['action', 'reason', 'expectedResult', 'data', 'preview']));
  });

  /**
   * FAILING-BY-DESIGN MARKER — CDR-068 §2-G4 (APPR-010) IS NOT BUILT.
   *
   * §2-G4 decided that "for previewable types the preview and the execution payload must derive from the SAME
   * normalized structure — so 'preview equals execution' is a test that can fail". No such derivation exists:
   * `preview` is free text the model authors, validated only for blankness, with no relationship to `data`. The
   * CDR's own words for the consequence: *"a human approving a drifted preview has approved something that will
   * not happen."*
   *
   * This test asserts the GAP rather than the guarantee, so the omission shows up in every run instead of resting
   * in a document nobody rereads. Deleting it, or implementing the derivation, breaks it — and whoever that is
   * lands here, on the reason. Payload-hash binding is the SEPARATE half, deferred to ACBP-P6-004; this half is
   * this CDR's own accepted gate and is simply unbuilt.
   *
   * TO CLOSE: derive `preview` from the normalized `data` inside `buildApprovalRequest`, replace this test with the
   * preview-equals-execution assertion §2-G4 names, and record it in CDR-068 §3.
   */
  test('MARKER: preview is NOT yet derived from the execution payload (CDR-068 §2-G4 unbuilt)', () => {
    const drifted = buildApprovalRequest({ ...complete(), data: { recipients: 500 }, preview: 'To: 3 suppliers' });
    expect(drifted.status).toBe('ok');
    if (drifted.status !== 'ok') return;
    // A preview that flatly contradicts the payload is accepted today. When this stops being true, §2-G4 is done.
    expect(drifted.request.preview).toBe('To: 3 suppliers');
    expect(drifted.request.data).toEqual({ recipients: 500 });
  });

  test('an unreadable RISK CLASS resolves to the most restrictive, it does not refuse', () => {
    // Deliberately different from a missing content field. A junk risk class is a fact the platform can still act on
    // safely by taking the most restrictive reading (the `resolveRiskClass` rule); a missing reason is not.
    // No cast any more: `riskClass` is typed `unknown`, because the value genuinely comes from a registry column
    // that may be null and `buildApprovalRequest` resolves it rather than trusting it. The cast this line used to
    // need was itself the tell that the input type was claiming a validation nobody performed.
    const r = buildApprovalRequest({ ...complete(), riskClass: 'nonsense' });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.request.risk).toBe('sensitive_irreversible');
  });
});

describe('reversibility is DERIVED from the risk class (CDR-068 §2-G4)', () => {
  test('every risk class maps, and the mapping is total over junk', () => {
    expect(reversibilityOf('informational')).toBe('reversible');
    expect(reversibilityOf('internal_reversible')).toBe('reversible');
    expect(reversibilityOf('external_reversible')).toBe('reversible');
    expect(reversibilityOf('sensitive_irreversible')).toBe('irreversible');
    // Total, and unreadable input takes the WORSE reading — an action nobody can classify is not assumed undoable.
    for (const junk of [undefined, null, '', 'REVERSIBLE', 42, {}]) {
      expect(reversibilityOf(junk)).toBe('irreversible');
    }
  });

  test('the built request never carries a reversibility that disagrees with its risk', () => {
    // THE POINT OF DERIVING IT. Canon lists `risk` and `reversibility` as separate content fields, so a naive
    // implementation takes two inputs — and then a caller can say `sensitive_irreversible` and `reversible` in the
    // same breath, which is the one combination a human must never be shown.
    for (const riskClass of RISK_CLASSES) {
      const built = buildApprovalRequest({ ...complete(), riskClass });
      expect(built.status).toBe('ok');
      if (built.status !== 'ok') continue;
      expect(built.request.reversibility).toBe(reversibilityOf(riskClass));
    }
  });

  test('reversibility is not a caller INPUT at all', () => {
    // Stronger than asserting the derivation: there is no field to supply. @ts-expect-error is self-verifying — if
    // `reversibility` ever becomes an accepted input, the expected error disappears and the TYPECHECK fails.
    // @ts-expect-error — reversibility is derived from `riskClass`, never supplied
    const built = buildApprovalRequest({ ...complete(), reversibility: 'reversible' });
    expect(built.status).toBe('ok');
    if (built.status !== 'ok') return;
    // The extra property is ignored at runtime too, not honoured.
    expect(built.request.reversibility).toBe('reversible'); // external_reversible → reversible, from the risk class
    const irreversible = buildApprovalRequest({ ...complete(), riskClass: 'sensitive_irreversible', reversibility: 'reversible' } as never);
    expect(irreversible.status).toBe('ok');
    if (irreversible.status !== 'ok') return;
    expect(irreversible.request.reversibility).toBe('irreversible');
  });
});

describe('approval scopes — all four modelled, two accepted (CDR-068 §2-G5)', () => {
  test('the vocabulary carries all four of canon §3', () => {
    expect([...APPROVAL_SCOPES]).toEqual(['one_action', 'limited_batch', 'capability_category', 'bounded_operating_policy']);
    for (const s of APPROVAL_SCOPES) expect(isApprovalScope(s)).toBe(true);
    for (const junk of [undefined, null, '', 'ONE_ACTION', 'one action', 7, {}]) expect(isApprovalScope(junk)).toBe(false);
  });

  test('MVP accepts exactly the two canon marks MVP', () => {
    expect([...MVP_APPROVAL_SCOPES]).toEqual(['one_action', 'limited_batch']);
    expect(isMvpApprovalScope('one_action')).toBe(true);
    expect(isMvpApprovalScope('limited_batch')).toBe(true);
    // Post-MVP scopes are recognised as REAL scopes but not accepted — the distinction canon draws so later
    // autonomy levels are additive rather than a migration.
    expect(isApprovalScope('capability_category')).toBe(true);
    expect(isMvpApprovalScope('capability_category')).toBe(false);
    expect(isMvpApprovalScope('bounded_operating_policy')).toBe(false);
  });

  test('a post-MVP scope is refused with a reason that says WHY, not just no', () => {
    const r = buildApprovalRequest({ ...complete(), scope: 'capability_category' });
    expect(r).toMatchObject({ status: 'scope_not_available' });
    if (r.status !== 'scope_not_available') return;
    expect(r.scope).toBe('capability_category');
  });

  test('an unrecognised scope is refused, and NOT silently treated as one_action', () => {
    const r = buildApprovalRequest({ ...complete(), scope: 'whatever' as never });
    expect(r.status).toBe('scope_not_available');
  });
});

describe('what this ticket deliberately does NOT decide (CDR-068 §2-G6)', () => {
  test('no expiry value is produced — expiry is APPR-005 and P6-004', () => {
    const built = buildApprovalRequest(complete());
    expect(built.status).toBe('ok');
    if (built.status !== 'ok') return;
    // Asserting an ABSENCE on purpose. If a later ticket adds a default expiry here, this test fails and its author
    // has to decide whether the value is ruled — which is exactly the conversation AOQ-14 and CDR-066 §3-G8 exist to
    // force. A silently-defaulted timeout reads as ratified.
    expect(Object.keys(built.request)).not.toContain('expiresAt');
    expect(Object.keys(built.request)).not.toContain('expiryMs');
  });

  test('no payload HASH is produced — binding is ADR-009 §2 and P6-004', () => {
    // The distinction this ticket must not blur: a request records WHAT is proposed; it does not yet bind the exact
    // bytes. Closing the dispatcher's approval port (CDR-068 §0.1) makes the gate read a real decision instead of a
    // caller's lambda — it does NOT make that decision hash-bound.
    const built = buildApprovalRequest(complete());
    expect(built.status).toBe('ok');
    if (built.status !== 'ok') return;
    expect(Object.keys(built.request)).not.toContain('payloadHash');
    expect(Object.keys(built.request)).not.toContain('contentHash');
  });
});
