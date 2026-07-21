// ACBP-P1-004 — unit tests for invite token generation + hashing.
import { describe, test, expect } from 'vitest';
import { generateInviteToken, hashInviteToken } from './invite-token.js';

describe('invite-token', () => {
  test('hashInviteToken is a deterministic lowercase 64-hex SHA-256', () => {
    const h = hashInviteToken('some-token');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken('some-token')).toBe(h); // deterministic
    expect(hashInviteToken('other-token')).not.toBe(h);
  });

  test('generateInviteToken returns a token whose hash matches, and is high-entropy/unique', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.tokenHash).toBe(hashInviteToken(a.token));
    expect(a.token).not.toBe(b.token); // distinct
    expect(a.token.length).toBeGreaterThanOrEqual(40); // 256-bit base64url
    // The raw token is never equal to its stored hash.
    expect(a.token).not.toBe(a.tokenHash);
  });
});
