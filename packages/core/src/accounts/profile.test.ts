// ACBP-P1-003 — unit tests for profile-update validation/normalization (pure; no database).
import { describe, test, expect } from 'vitest';
import { isPlatformError } from '@acbp/contracts';
import { normalizeProfileUpdate } from './profile.js';

describe('normalizeProfileUpdate', () => {
  test('empty input produces an empty patch (no-op update)', () => {
    expect(normalizeProfileUpdate({})).toEqual({});
  });

  test('trims a display name', () => {
    expect(normalizeProfileUpdate({ displayName: '  Ada Lovelace  ' })).toEqual({ display_name: 'Ada Lovelace' });
  });

  test('empty or whitespace display name clears it (→ null)', () => {
    expect(normalizeProfileUpdate({ displayName: '' })).toEqual({ display_name: null });
    expect(normalizeProfileUpdate({ displayName: '   ' })).toEqual({ display_name: null });
  });

  test('explicit null clears the display name', () => {
    expect(normalizeProfileUpdate({ displayName: null })).toEqual({ display_name: null });
  });

  test('rejects an over-long display name with only the field NAME (no value)', () => {
    try {
      normalizeProfileUpdate({ displayName: 'x'.repeat(201) });
      throw new Error('expected a validation error');
    } catch (e) {
      expect(isPlatformError(e)).toBe(true);
      if (isPlatformError(e)) {
        expect(e.category).toBe('validation');
        expect(e.metadata['failedFields']).toBe('displayName');
        // The offending value never appears in the message or metadata.
        expect(JSON.stringify({ m: e.message, meta: e.metadata })).not.toContain('xxxx');
      }
    }
  });

  test('accepts valid BCP-47-ish locales', () => {
    for (const locale of ['en', 'ar', 'en-US', 'pt-BR', 'zh-Hant']) {
      expect(normalizeProfileUpdate({ locale })).toEqual({ locale });
    }
  });

  test('rejects malformed locales', () => {
    for (const locale of ['english!', 'E', 'EN', 'en_US', '123', '']) {
      expect(() => normalizeProfileUpdate({ locale })).toThrow();
    }
  });

  test('normalizes display name and locale together', () => {
    expect(normalizeProfileUpdate({ displayName: 'Grace', locale: 'en-GB' })).toEqual({ display_name: 'Grace', locale: 'en-GB' });
  });

  test('there is no way to set email through the profile update (email is Clerk-authoritative)', () => {
    // A stray email-ish key is ignored by the typed normalizer — it never reaches the patch.
    const patch = normalizeProfileUpdate({ displayName: 'Ada', ...({ email: 'x@y.z' } as object) });
    expect(patch).toEqual({ display_name: 'Ada' });
    expect(Object.keys(patch)).not.toContain('email');
    expect(Object.keys(patch)).not.toContain('primary_email');
  });
});
