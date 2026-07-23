// @acbp/contracts — administrative-access contract tests (ACBP-P1-013; CDR-019).
import { describe, test, expect } from 'vitest';
import { validateAdminReason, ADMIN_REASON_MAX_CODE_POINTS, ADMIN_READ_SCOPE } from './index.js';
import { adminTenantRead, isAuditEventName, boundedMetadata, isProjectableActivity } from '../index.js';

const CO = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('validateAdminReason (CDR-019 §4) — strict, verbatim, fail-closed', () => {
  test('accepts a normal reason and returns the EXACT original string', () => {
    const r = validateAdminReason('Support ticket #4231: verify company state after report');
    expect(r).toEqual({ ok: true, reason: 'Support ticket #4231: verify company state after report' });
  });
  test('retains leading/trailing whitespace verbatim when real content exists (no trimming before storage)', () => {
    const raw = '  padded reason  ';
    const r = validateAdminReason(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reason).toBe(raw); // byte-for-byte/string-for-string retention
  });
  test('rejects non-strings, missing, empty and whitespace-only reasons', () => {
    for (const bad of [undefined, null, 42, {}, [], true, '', ' ', '   ', '\t\n  ']) {
      expect(validateAdminReason(bad)).toEqual({ ok: false });
    }
  });
  test('code-point boundary: exactly 512 accepted; 513 rejected (measured in code points, not UTF-16 units)', () => {
    expect(ADMIN_REASON_MAX_CODE_POINTS).toBe(512);
    expect(validateAdminReason('x'.repeat(512)).ok).toBe(true);
    expect(validateAdminReason('x'.repeat(513)).ok).toBe(false);
    // 512 ASTRAL characters = 1024 UTF-16 units but exactly 512 code points → ACCEPTED.
    const astral = '\u{1F600}'.repeat(512);
    expect(astral.length).toBe(1024); // proves the UTF-16 length would have mismeasured
    expect(validateAdminReason(astral).ok).toBe(true);
    expect(validateAdminReason('\u{1F600}'.repeat(513)).ok).toBe(false);
    // Mixed multibyte counting.
    expect(validateAdminReason('é'.repeat(512)).ok).toBe(true);
    expect(validateAdminReason('é'.repeat(513)).ok).toBe(false);
  });
  test('NUL is forbidden anywhere', () => {
    expect(validateAdminReason('bad\u0000reason').ok).toBe(false);
    expect(validateAdminReason('\u0000').ok).toBe(false);
    expect(validateAdminReason('trailing\u0000').ok).toBe(false);
  });
  test('lone surrogates are rejected (JSON escapes can smuggle them past a UTF-8 body decode); well-formed pairs pass', () => {
    // Build LONE surrogates at runtime — exactly what JSON.parse of an escaped "\\ud800" produces.
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdfff);
    expect(validateAdminReason(loneHigh).ok).toBe(false);
    expect(validateAdminReason(`x${loneLow}y`).ok).toBe(false);
    expect(validateAdminReason(`ok ${String.fromCharCode(0xd83d)} tail`).ok).toBe(false); // high surrogate split from its pair
    // A REAL surrogate pair (astral char) remains valid — the well-formedness gate never rejects real content.
    expect(validateAdminReason('\u{1F600} valid astral')).toEqual({ ok: true, reason: '\u{1F600} valid astral' });
  });
});

describe('admin.tenant_read registration (CDR-019 §7)', () => {
  test('the event is registered; scope code is the closed company_overview', () => {
    expect(isAuditEventName('admin.tenant_read')).toBe(true);
    expect(ADMIN_READ_SCOPE).toBe('company_overview');
  });
  test('the factory emits EXACTLY {reason, scope} with the verbatim reason; subject = the target company', () => {
    const e = adminTenantRead({ companyId: CO, reason: '  verbatim  ', scope: ADMIN_READ_SCOPE });
    expect(e).toMatchObject({ name: 'admin.tenant_read', subjectType: 'company', subjectId: CO, outcome: 'success' });
    expect(e.metadata).toEqual({ reason: '  verbatim  ', scope: 'company_overview' });
  });
  test('a maximum-length ASTRAL reason (512 code points = 1024 UTF-16 units) survives the audit metadata bounds', () => {
    const astral = '\u{1F600}'.repeat(512);
    expect(validateAdminReason(astral).ok).toBe(true);
    // The metadata layer must never reject a reason its own validator approved.
    expect(() => boundedMetadata({ reason: astral, scope: ADMIN_READ_SCOPE })).not.toThrow();
    expect(() => adminTenantRead({ companyId: CO, reason: astral, scope: ADMIN_READ_SCOPE })).not.toThrow();
  });
  test('admin.tenant_read is NEVER activity-projectable (the four-event feed taxonomy is unchanged)', () => {
    expect(isProjectableActivity('admin.tenant_read')).toBe(false);
  });
});
