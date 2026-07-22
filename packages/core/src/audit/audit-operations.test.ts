// @acbp/core — audit completeness registry tests (ACBP-P1-008). Structural (not source-grep) guarantees that
// the approved high-risk operations map to durable events, and that every registered event is produced.
import { describe, test, expect } from 'vitest';
import { AUDIT_EVENTS } from '@acbp/contracts';
import { AUDITED_OPERATIONS, AUDITED_OPERATION_IDS, factoryFor, producedEventNames, registeredEventNames } from './audit-operations.js';

describe('audit completeness registry (ACBP-P1-008 / CDR-014)', () => {
  test('the approved operation set is the membership + company lifecycle operations', () => {
    expect([...AUDITED_OPERATION_IDS].sort()).toEqual([
      'company.create',
      'company.pause',
      'company.resume',
      'company.update',
      'membership.invite',
      'membership.revoke',
    ]);
    expect(AUDITED_OPERATIONS['membership.invite']).toBe('membership.invited');
    expect(AUDITED_OPERATIONS['membership.revoke']).toBe('membership.revoked');
    expect(AUDITED_OPERATIONS['company.create']).toBe('company.created');
    expect(AUDITED_OPERATIONS['company.update']).toBe('company.updated');
    expect(AUDITED_OPERATIONS['company.pause']).toBe('company.paused');
    expect(AUDITED_OPERATIONS['company.resume']).toBe('company.resumed');
  });

  test('every REGISTERED audit event is produced by exactly one approved operation (no orphan events)', () => {
    const produced = producedEventNames();
    for (const name of registeredEventNames()) {
      expect(produced.has(name)).toBe(true);
    }
    // And the produced set has no name that is not registered in the contract.
    for (const name of produced) {
      expect(Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, name)).toBe(true);
    }
    // The two sets are the same size — a 1:1 operation↔event mapping for the first cut.
    expect(produced.size).toBe(registeredEventNames().length);
  });

  test('factoryFor produces an event whose name matches the operation mapping', () => {
    for (const op of AUDITED_OPERATION_IDS) {
      const event = factoryFor(op)('subject_1');
      expect(event.name).toBe(AUDITED_OPERATIONS[op]);
      expect(event.subjectId).toBe('subject_1');
      expect(event.outcome).toBe('success');
    }
  });
});
