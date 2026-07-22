// @acbp/core — company create input validation (ACBP-P1-010; CDR-015). Pure decision, no database.
import { describe, test, expect } from 'vitest';
import { validateCreateCompanyInput } from './company-service.js';

const base = { accountId: 'acc_1', actingUserId: 'usr_1' };

describe('validateCreateCompanyInput', () => {
  test('accepts a valid own_idea company with a trimmed name', () => {
    const r = validateCreateCompanyInput({ ...base, creationMode: 'own_idea', name: '  Acme  ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ creationMode: 'own_idea', name: 'Acme', description: null });
    }
  });

  test('accepts each of the three creation modes', () => {
    for (const mode of ['own_idea', 'platform_suggested', 'existing_business']) {
      expect(validateCreateCompanyInput({ ...base, creationMode: mode, name: 'X' }).ok).toBe(true);
    }
  });

  test('normalizes an optional description; blank description becomes null', () => {
    expect(validateCreateCompanyInput({ ...base, creationMode: 'own_idea', name: 'X', description: '   ' })).toMatchObject({ ok: true, value: { description: null } });
    const r = validateCreateCompanyInput({ ...base, creationMode: 'own_idea', name: 'X', description: '  hello  ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.description).toBe('hello');
  });

  test('rejects an unknown creation mode with a validation envelope (no field values leaked)', () => {
    const r = validateCreateCompanyInput({ ...base, creationMode: 'franchise', name: 'X' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.category).toBe('validation');
      // The public envelope carries NO `fields` key (field names are internal metadata only).
      expect('fields' in r.error).toBe(false);
    }
  });

  test('rejects an empty or whitespace-only name', () => {
    expect(validateCreateCompanyInput({ ...base, creationMode: 'own_idea', name: '' }).ok).toBe(false);
    expect(validateCreateCompanyInput({ ...base, creationMode: 'own_idea', name: '   ' }).ok).toBe(false);
    expect(validateCreateCompanyInput({ ...base, creationMode: 'own_idea', name: 42 }).ok).toBe(false);
  });

  test('rejects an over-long name (>200) and description (>2000)', () => {
    expect(validateCreateCompanyInput({ ...base, creationMode: 'own_idea', name: 'x'.repeat(201) }).ok).toBe(false);
    expect(validateCreateCompanyInput({ ...base, creationMode: 'own_idea', name: 'ok', description: 'x'.repeat(2001) }).ok).toBe(false);
  });
});
