// ACBP-P1-004 — unit tests for the role model.
import { describe, test, expect } from 'vitest';
import { isMemberRole, MEMBER_ROLES } from './roles.js';

describe('roles', () => {
  test('MEMBER_ROLES is exactly owner + viewer', () => {
    expect([...MEMBER_ROLES]).toEqual(['owner', 'viewer']);
  });

  test('isMemberRole accepts only owner/viewer', () => {
    expect(isMemberRole('owner')).toBe(true);
    expect(isMemberRole('viewer')).toBe(true);
    for (const bad of ['admin', 'OWNER', '', null, undefined, 1, {}]) expect(isMemberRole(bad)).toBe(false);
  });
});
