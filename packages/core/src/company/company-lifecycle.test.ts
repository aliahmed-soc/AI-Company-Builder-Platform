// @acbp/core — company profile-edit validation (ACBP-P1-010; CDR-015). Pure decision, no database.
import { describe, test, expect } from 'vitest';
import { validateProfileEdit } from './company-lifecycle.js';

const base = { userId: 'usr_1', accountId: 'acc_1', companyId: 'co_1' };

describe('validateProfileEdit', () => {
  test('accepts a valid name; a missing description means "leave unchanged" (undefined)', () => {
    const r = validateProfileEdit({ ...base, name: '  New Name  ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('New Name');
      expect(r.description).toBeUndefined();
    }
  });

  test('a blank description string clears it (null), a non-blank one sets it', () => {
    const cleared = validateProfileEdit({ ...base, name: 'X', description: '   ' });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.description).toBeNull();
    const set = validateProfileEdit({ ...base, name: 'X', description: '  hi  ' });
    if (set.ok) expect(set.description).toBe('hi');
  });

  test('an explicit null description clears it (consistent with create — review F3)', () => {
    const r = validateProfileEdit({ ...base, name: 'X', description: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.description).toBeNull();
  });

  test('rejects an empty/over-long name and a non-string description', () => {
    expect(validateProfileEdit({ ...base, name: '' }).ok).toBe(false);
    expect(validateProfileEdit({ ...base, name: 'x'.repeat(201) }).ok).toBe(false);
    expect(validateProfileEdit({ ...base, name: 'ok', description: 123 }).ok).toBe(false);
    expect(validateProfileEdit({ ...base, name: 'ok', description: 'x'.repeat(2001) }).ok).toBe(false);
  });
});
