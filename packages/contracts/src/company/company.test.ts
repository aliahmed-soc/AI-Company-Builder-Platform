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
  test('the P1-010 status set is exactly draft/onboarding/active/paused (deactivate deferred)', () => {
    expect([...COMPANY_STATUSES].sort()).toEqual(['active', 'draft', 'onboarding', 'paused']);
    for (const s of COMPANY_STATUSES) expect(isCompanyStatus(s)).toBe(true);
  });
  test('isCompanyStatus rejects deferred/unknown states and non-strings', () => {
    for (const bad of ['deactivating', 'deactivated', 'deleted', 'ACTIVE', '', 1, null, {}]) {
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
  test('any unrecognized/absent state renders as "unknown", never a fabricated healthy state', () => {
    for (const bad of ['deactivating', 'deactivated', 'garbage', '', undefined, null, 42, {}]) {
      expect(toDisplayStatus(bad)).toBe('unknown');
    }
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

describe('legal company transitions (WORKFLOW §1 subset)', () => {
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
});
