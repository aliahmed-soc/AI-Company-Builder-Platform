// @acbp/core — single-use invite token generation + hashing (ACBP-P1-004; CDR-011).
//
// The raw token is returned to the inviting owner exactly once (no email delivery infrastructure exists
// in P1-004); only its SHA-256 hash is persisted. Acceptance re-hashes the presented token and looks it
// up by hash, so the raw token never touches the database. Additionally bound to the invitee's verified
// email at acceptance, so a leaked token alone cannot be used.
import { randomBytes, createHash } from 'node:crypto';

/** Lowercase 64-hex SHA-256 of the raw token. Deterministic; the only value persisted. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Generate a high-entropy URL-safe invite token and its storage hash. */
export function generateInviteToken(): { readonly token: string; readonly tokenHash: string } {
  const token = randomBytes(32).toString('base64url'); // 256 bits of entropy
  return { token, tokenHash: hashInviteToken(token) };
}
