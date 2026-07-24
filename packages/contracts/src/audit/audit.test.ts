// @acbp/contracts — audit contract tests (ACBP-P1-008). ULID generation, closed event registry, bounded
// metadata, and typed factories. Forgery resistance is a property of the writer (account/actor/id/time are
// server-bound); here we pin the caller-facing contract's validation + immutability.
import { describe, test, expect } from 'vitest';
import { isPlatformError } from '../errors.js';
import {
  generateEventId,
  isUlid,
  isAuditEventName,
  isAuditActorType,
  AUDIT_EVENTS,
  AUDIT_ACTOR_TYPES,
  boundedMetadata,
  membershipInvited,
  membershipRevoked,
  companyCreated,
  companyUpdated,
  companyPaused,
  companyResumed,
  interviewStarted,
  memoryItemCreated,
  memoryItemSuperseded,
  type AuditEventName,
} from './index.js';

describe('generateEventId (ULID)', () => {
  test('produces a 26-char Crockford-base32 ULID', () => {
    const id = generateEventId(1_700_000_000_000);
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  test('the timestamp prefix is lexicographically time-ordered', () => {
    const earlier = generateEventId(1_700_000_000_000).slice(0, 10);
    const later = generateEventId(1_700_000_001_000).slice(0, 10);
    expect(later > earlier).toBe(true);
  });

  test('two ids at the same instant differ in the random suffix (unique)', () => {
    const a = generateEventId(1_700_000_000_000);
    const b = generateEventId(1_700_000_000_000);
    expect(a).not.toBe(b);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10)); // same time prefix
  });

  test('rejects an out-of-range timestamp', () => {
    expect(() => generateEventId(-1)).toThrow();
    expect(() => generateEventId(2 ** 48)).toThrow();
    expect(() => generateEventId(1.5)).toThrow();
  });

  test('isUlid rejects malformed values (wrong length, lowercase, ambiguous letters, non-strings)', () => {
    for (const bad of ['', 'abc', '0123456789ABCDEFGHJKMNPQR', 'i'.repeat(26), '01234567890123456789ABCDEL', 42, null, undefined]) {
      expect(isUlid(bad)).toBe(false);
    }
  });
});

describe('event-name registry (deny unregistered)', () => {
  test('accepts exactly the registered names', () => {
    expect(Object.keys(AUDIT_EVENTS).sort()).toEqual([
      // Platform-administrative access (ACBP-P1-013; CDR-019 §7) — exactly one audit-only admin event.
      'admin.tenant_read',
      'company.created',
      'company.paused',
      'company.resumed',
      'company.updated',
      'membership.invited',
      'membership.revoked',
      // Workspace provisioning (ACBP-P1-012; CDR-018 §8) — six audit-only events, deliberately registered.
      'provisioning.completed',
      'provisioning.retry_requested',
      'provisioning.started',
      'provisioning.step_completed',
      'provisioning.step_failed',
      'provisioning.step_started',
    ].concat([
      // Interview session lifecycle (ACBP-P2-001; CDR-022 §4) — exactly one audit-only session event.
      'interview.started',
      // Typed memory (ACBP-P2-006; CDR-024 §4) — a memory item creation is audited.
      'memory.item_created',
      // Memory browser (ACBP-P2-010; CDR-025 §4) — a memory item supersede is audited.
      'memory.item_superseded',
    ]).sort());
    for (const name of Object.keys(AUDIT_EVENTS)) expect(isAuditEventName(name)).toBe(true);
  });
  test('rejects unregistered / forged names and non-strings', () => {
    for (const bad of ['membership.deleted', 'account.created', 'authz.denied', 'MEMBERSHIP.INVITED', '', 42, null, {}]) {
      expect(isAuditEventName(bad as unknown)).toBe(false);
    }
  });
});

describe('actor types', () => {
  test('exactly user|worker|system|admin', () => {
    expect([...AUDIT_ACTOR_TYPES].sort()).toEqual(['admin', 'system', 'user', 'worker']);
    for (const t of AUDIT_ACTOR_TYPES) expect(isAuditActorType(t)).toBe(true);
    for (const bad of ['owner', 'viewer', 'root', '', 1, null]) expect(isAuditActorType(bad as unknown)).toBe(false);
  });
});

describe('boundedMetadata', () => {
  test('accepts a flat map of scalars and freezes it', () => {
    const m = boundedMetadata({ role: 'viewer', count: 3, ok: true });
    expect(m).toEqual({ role: 'viewer', count: 3, ok: true });
    expect(Object.isFrozen(m)).toBe(true);
  });

  test('rejects nested objects, arrays, Error objects, and functions (no unbounded structures)', () => {
    expect(() => boundedMetadata({ nested: { a: 1 } })).toThrow();
    expect(() => boundedMetadata({ list: [1, 2] })).toThrow();
    expect(() => boundedMetadata({ err: new Error('boom') })).toThrow();
    expect(() => boundedMetadata({ fn: () => 1 })).toThrow();
  });

  test('rejects null/undefined/bigint/symbol and non-finite numbers', () => {
    expect(() => boundedMetadata({ a: null })).toThrow();
    expect(() => boundedMetadata({ a: undefined })).toThrow();
    expect(() => boundedMetadata({ a: 10n })).toThrow();
    expect(() => boundedMetadata({ a: Symbol('s') })).toThrow();
    expect(() => boundedMetadata({ a: Infinity })).toThrow();
    expect(() => boundedMetadata({ a: NaN })).toThrow();
  });

  test('rejects invalid keys, too many keys, over-long values, and over-large totals', () => {
    expect(() => boundedMetadata({ 'Bad-Key': 'x' })).toThrow();
    expect(() => boundedMetadata({ '1leading': 'x' })).toThrow();
    const many: Record<string, number> = {};
    for (let i = 0; i < 17; i++) many[`k${i}`] = i;
    expect(() => boundedMetadata(many)).toThrow();
    // Per-value bound is 1024 UTF-16 units (sized for the ≤512-code-point VERBATIM admin reason, which may be
    // up to 1024 units with astral characters — ACBP-P1-013/CDR-019 §4).
    expect(() => boundedMetadata({ big: 'x'.repeat(1024) })).not.toThrow();
    expect(() => boundedMetadata({ big: 'x'.repeat(1025) })).toThrow();
    expect(() => boundedMetadata({ a: 'x'.repeat(500), b: 'y'.repeat(500), c: 'z'.repeat(500), d: 'w'.repeat(500), e: 'v'.repeat(500), f: 'u'.repeat(500), g: 't'.repeat(500), h: 's'.repeat(500), i: 'r'.repeat(500) })).toThrow();
  });

  test('a rejected metadata value never appears in the validation error (only the key name does)', () => {
    try {
      // A nested object is rejected; the offending VALUE must not leak into the error.
      boundedMetadata({ note: { hidden: 'do-not-leak-xyz' } });
      throw new Error('expected boundedMetadata to throw');
    } catch (e) {
      // Public envelope: no value AND no field name (safe by default).
      expect(JSON.stringify(e)).not.toContain('do-not-leak-xyz');
      expect(isPlatformError(e)).toBe(true);
      if (isPlatformError(e)) {
        const internal = JSON.stringify(e.toInternal());
        expect(internal).not.toContain('do-not-leak-xyz'); // internal report: still never the value
        expect(internal).toContain('note'); // internal captures the offending KEY name only
      }
    }
  });
});

describe('typed factories', () => {
  test('membershipInvited builds a frozen success event with bounded metadata', () => {
    const ev = membershipInvited({ membershipId: 'm_1', role: 'viewer' });
    expect(ev).toEqual({ name: 'membership.invited', schemaVersion: 1, subjectType: 'membership', subjectId: 'm_1', outcome: 'success', metadata: { role: 'viewer' } });
    expect(Object.isFrozen(ev)).toBe(true);
    expect(Object.isFrozen(ev.metadata)).toBe(true);
  });

  test('membershipRevoked builds the revoked lifecycle event', () => {
    const ev = membershipRevoked({ membershipId: 'm_2', role: 'owner' });
    expect(ev.name).toBe('membership.revoked');
    expect(ev.subjectType).toBe('membership');
    expect(ev.subjectId).toBe('m_2');
    expect(ev.outcome).toBe('success');
    expect(ev.metadata).toEqual({ role: 'owner' });
  });

  test('a factory rejects an empty or over-long subject id', () => {
    expect(() => membershipInvited({ membershipId: '', role: 'viewer' })).toThrow();
    expect(() => membershipInvited({ membershipId: 'x'.repeat(65), role: 'viewer' })).toThrow();
  });

  test('the schema version comes from the registry, not the caller', () => {
    const name: AuditEventName = 'membership.invited';
    expect(membershipInvited({ membershipId: 'm', role: 'viewer' }).schemaVersion).toBe(AUDIT_EVENTS[name].schemaVersion);
  });

  test('companyCreated builds a frozen success event with the creation mode', () => {
    const ev = companyCreated({ companyId: 'co_1', creationMode: 'own_idea' });
    expect(ev).toEqual({ name: 'company.created', schemaVersion: 1, subjectType: 'company', subjectId: 'co_1', outcome: 'success', metadata: { creation_mode: 'own_idea' } });
    expect(Object.isFrozen(ev)).toBe(true);
  });

  test('companyUpdated records changed FIELD NAMES only (never values)', () => {
    const ev = companyUpdated({ companyId: 'co_2', changedFields: ['name', 'description'] });
    expect(ev.name).toBe('company.updated');
    expect(ev.subjectId).toBe('co_2');
    expect(ev.metadata).toEqual({ changed_fields: 'name,description' });
  });

  test('companyPaused/companyResumed omit optional fields when absent', () => {
    expect(companyPaused({ companyId: 'co_3' }).metadata).toEqual({});
    expect(companyPaused({ companyId: 'co_3', reason: 'owner_request' }).metadata).toEqual({ reason: 'owner_request' });
    expect(companyResumed({ companyId: 'co_4' }).metadata).toEqual({});
    expect(companyResumed({ companyId: 'co_4', heldWorkCount: 3 }).metadata).toEqual({ held_work_count: 3 });
  });

  test('company factories reject an empty subject id', () => {
    expect(() => companyCreated({ companyId: '', creationMode: 'own_idea' })).toThrow();
  });

  test('interviewStarted builds a frozen success event subjected to the SESSION id with empty metadata', () => {
    const ev = interviewStarted({ sessionId: 'sess_1' });
    expect(ev).toEqual({ name: 'interview.started', schemaVersion: 1, subjectType: 'interview_session', subjectId: 'sess_1', outcome: 'success', metadata: {} });
    expect(Object.isFrozen(ev)).toBe(true);
    expect(Object.isFrozen(ev.metadata)).toBe(true);
  });

  test('interviewStarted rejects an empty subject id (no session, no event)', () => {
    expect(() => interviewStarted({ sessionId: '' })).toThrow();
  });

  test('memoryItemCreated carries only bounded {item_type, source_type} — never content or source_ref', () => {
    const ev = memoryItemCreated({ memoryItemId: 'mem_1', itemType: 'user_fact', sourceType: 'interview_answer' });
    expect(ev).toEqual({ name: 'memory.item_created', schemaVersion: 1, subjectType: 'memory_item', subjectId: 'mem_1', outcome: 'success', metadata: { item_type: 'user_fact', source_type: 'interview_answer' } });
    expect(Object.isFrozen(ev)).toBe(true);
  });

  test('memoryItemSuperseded: subject = the OLD item id; metadata = the NEW version {item_type, source_type}', () => {
    const ev = memoryItemSuperseded({ supersededItemId: 'mem_old', newItemType: 'user_fact', newSourceType: 'user_edit' });
    expect(ev).toEqual({ name: 'memory.item_superseded', schemaVersion: 1, subjectType: 'memory_item', subjectId: 'mem_old', outcome: 'success', metadata: { item_type: 'user_fact', source_type: 'user_edit' } });
    expect(Object.isFrozen(ev)).toBe(true);
  });
});
