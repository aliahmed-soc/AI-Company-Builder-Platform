// @acbp/contracts — company lifecycle contract tests (ACBP-P1-010; CDR-015).
import { describe, test, expect } from 'vitest';
import {
  COMPANY_STATUSES,
  isCompanyStatus,
  toDisplayStatus,
  COMPANY_CREATION_MODES,
  isCompanyCreationMode,
  INITIAL_COMPANY_STATUS,
  isLegalCompanyTransition,
} from './index.js';

describe('company status', () => {
  test('the status set is the full WORKFLOW §1 lifecycle EXCEPT `deleted`', () => {
    // ACBP-P7-002 widens P1-010's four with the two deactivation phases. `deleted` is DELIBERATELY absent
    // (CDR-079 §3-G6): COMP-007/ACC-005 own deletion, canon makes three different reachability claims for it so
    // its transition set cannot be written down without picking a winner, and the gate is an ALLOWLIST — it
    // refuses `deleted` correctly without needing a vocabulary entry.
    expect([...COMPANY_STATUSES].sort()).toEqual(['active', 'deactivated', 'deactivating', 'draft', 'onboarding', 'paused']);
    for (const s of COMPANY_STATUSES) expect(isCompanyStatus(s)).toBe(true);
  });
  test('isCompanyStatus rejects `deleted`, unknown states, and non-strings', () => {
    for (const bad of ['deleted', 'ACTIVE', 'deactivate', '', 1, null, {}]) {
      expect(isCompanyStatus(bad as unknown)).toBe(false);
    }
  });
  test('the initial status is draft (server-selected)', () => {
    expect(INITIAL_COMPANY_STATUS).toBe('draft');
  });
});

describe('toDisplayStatus (COMP-008: unknown never renders as healthy)', () => {
  test('maps lifecycle states to human-readable display', () => {
    expect(toDisplayStatus('draft')).toBe('provisioning');
    expect(toDisplayStatus('onboarding')).toBe('provisioning');
    expect(toDisplayStatus('active')).toBe('active');
    expect(toDisplayStatus('paused')).toBe('paused');
  });

  test('the two deactivation phases render DISTINCTLY, and neither renders as "unknown"', () => {
    // WIDENING `CompanyStatus` WITHOUT WIDENING THIS REGRESSES COMP-008 on the exact screen a founder consults
    // after deactivating: "Status reflects actual lifecycle state" would become "unknown" for a state the
    // platform knows perfectly well. The two phases are kept SEPARATE because they mean different things to the
    // reader — one is in progress, one is finished — and canon blocks work at the first, not the second.
    expect(toDisplayStatus('deactivating')).toBe('deactivating');
    expect(toDisplayStatus('deactivated')).toBe('deactivated');
  });

  test('any unrecognized/absent state renders as "unknown", never a fabricated healthy state', () => {
    for (const bad of ['deleted', 'garbage', '', undefined, null, 42, {}]) {
      expect(toDisplayStatus(bad)).toBe('unknown');
    }
  });

  test('EVERY status in the vocabulary has a display value — none falls through to "unknown"', () => {
    // The guard against the next widening repeating this one's mistake: a status added to `COMPANY_STATUSES`
    // without a `toDisplayStatus` case is a real lifecycle state rendering as "unknown" to its owner.
    for (const s of COMPANY_STATUSES) expect(toDisplayStatus(s)).not.toBe('unknown');
  });
});

describe('company creation modes (COMP-001)', () => {
  test('the three modes are own_idea/platform_suggested/existing_business', () => {
    expect([...COMPANY_CREATION_MODES].sort()).toEqual(['existing_business', 'own_idea', 'platform_suggested']);
    for (const m of COMPANY_CREATION_MODES) expect(isCompanyCreationMode(m)).toBe(true);
  });
  test('isCompanyCreationMode rejects unknown modes and non-strings', () => {
    for (const bad of ['idea', 'OWN_IDEA', '', null, 1, ['own_idea']]) {
      expect(isCompanyCreationMode(bad as unknown)).toBe(false);
    }
  });
});

describe('legal company transitions (WORKFLOW §1)', () => {
  test('the implemented transitions are legal', () => {
    expect(isLegalCompanyTransition('draft', 'onboarding')).toBe(true);
    expect(isLegalCompanyTransition('onboarding', 'active')).toBe(true);
    expect(isLegalCompanyTransition('active', 'paused')).toBe(true);
    expect(isLegalCompanyTransition('paused', 'active')).toBe(true);
  });
  test('illegal transitions are rejected (no skipping, no self-loops, no reverse)', () => {
    expect(isLegalCompanyTransition('draft', 'active')).toBe(false);
    expect(isLegalCompanyTransition('active', 'active')).toBe(false);
    expect(isLegalCompanyTransition('active', 'draft')).toBe(false);
    expect(isLegalCompanyTransition('paused', 'onboarding')).toBe(false);
    expect(isLegalCompanyTransition('onboarding', 'paused')).toBe(false);
  });

  test('deactivation is TWO-PHASE, and BOTH `active` and `paused` are legal sources', () => {
    // WORKFLOW-STATE-MACHINES.md:17 — the source cell is `active/paused`, so both edges exist. `diagrams/15`
    // draws `pause -.-> deact` as the only inbound edge and contradicts it; §1 wins, being the state-machine
    // document (CDR-079 §10 records the divergence). :18 gives the system phase.
    expect(isLegalCompanyTransition('active', 'deactivating')).toBe(true);
    expect(isLegalCompanyTransition('paused', 'deactivating')).toBe(true);
    expect(isLegalCompanyTransition('deactivating', 'deactivated')).toBe(true);
  });

  test('the intermediate phase CANNOT be skipped', () => {
    // CDR-079 §3-G5: collapsing the two phases would make "work stopped" depend on teardown succeeding. The only
    // inbound edge to `deactivated` is from `deactivating` (WORKFLOW-STATE-MACHINES.md:18).
    expect(isLegalCompanyTransition('active', 'deactivated')).toBe(false);
    expect(isLegalCompanyTransition('paused', 'deactivated')).toBe(false);
  });

  test('`deactivated` is TERMINAL — no edge leaves it', () => {
    // Marked ⏹ at WORKFLOW-STATE-MACHINES.md:9 and :18. Four canon statements nonetheless demand a documented
    // reactivation path; those are reconciled by DOCUMENTING the real answer (CDR-079 §9.7, an owner decision),
    // never by inventing a transition canon forbids.
    for (const to of COMPANY_STATUSES) expect(isLegalCompanyTransition('deactivated', to)).toBe(false);
  });

  test('a deactivation CANNOT be aborted, and that is a known gap rather than an oversight', () => {
    // Canon lists no reverse edge from `deactivating` and marks the initiating transition's Retry `n/a`. Ruled
    // illegal on the safer-reversible reading; "I clicked deactivate by mistake" has no answer today, and
    // CDR-079 §9.12 escalates it rather than letting an engineer invent one.
    expect(isLegalCompanyTransition('deactivating', 'active')).toBe(false);
    expect(isLegalCompanyTransition('deactivating', 'paused')).toBe(false);
  });

  test('a company mid-provisioning cannot be deactivated — canon offers no such edge', () => {
    // WORKFLOW-STATE-MACHINES.md:17's sources are `active/paused` only. The practical consequence — a
    // failed-provisioning company the owner cannot deactivate — is escalated at CDR-079 §9.11.
    expect(isLegalCompanyTransition('draft', 'deactivating')).toBe(false);
    expect(isLegalCompanyTransition('onboarding', 'deactivating')).toBe(false);
  });

  test('the transition table is TOTAL over the vocabulary — every pair answers, none throws', () => {
    // `isLegalCompanyTransition` indexes a record by `from`, so a status in the vocabulary with no transition
    // list would throw on lookup rather than refuse. THE COMPILER IS THE ENFORCEMENT — the table is typed
    // `Record<CompanyStatus, …>`, so a missing key does not build — and an earlier `?? []` runtime fallback was
    // REMOVED after mutation testing showed no test could tell whether it was there. This asserts the property
    // the type guarantees; it does not pretend to guard it at runtime.
    for (const from of COMPANY_STATUSES) {
      for (const to of COMPANY_STATUSES) expect(() => isLegalCompanyTransition(from, to)).not.toThrow();
    }
  });
});
