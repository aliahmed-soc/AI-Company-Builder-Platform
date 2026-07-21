// ACBP-P1-004 — unit tests for the role model.
import { describe, test, expect } from 'vitest';
import { isMemberRole, isOwner, isMember, MEMBER_ROLES } from './roles.js';

describe('roles', () => {
  test('MEMBER_ROLES is exactly owner + viewer', () => {
    expect([...MEMBER_ROLES]).toEqual(['owner', 'viewer']);
  });

  test('isMemberRole accepts only owner/viewer', () => {
    expect(isMemberRole('owner')).toBe(true);
    expect(isMemberRole('viewer')).toBe(true);
    for (const bad of ['admin', 'OWNER', '', null, undefined, 1, {}]) expect(isMemberRole(bad)).toBe(false);
  });

  test('isOwner is true only for owner', () => {
    expect(isOwner('owner')).toBe(true);
    expect(isOwner('viewer')).toBe(false);
    expect(isOwner(null)).toBe(false);
  });

  test('isMember is true for any active role, false for non-members', () => {
    expect(isMember('owner')).toBe(true);
    expect(isMember('viewer')).toBe(true);
    expect(isMember(null)).toBe(false);
  });
});
