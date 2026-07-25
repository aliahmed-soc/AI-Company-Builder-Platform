// ACBP-P2-007 — unit tests for the context-assembly pure contract (CDR-032; AI-AND-WORKER §1; invariant 12; NFR-018).
// All secret values below are SYNTHETIC (pattern-shaped, never real).
import { describe, test, expect } from 'vitest';
import { provenanceTier, rankMemoryForContext, containsSecret, redactSecrets, SECRET_PLACEHOLDER, detectMemoryConflicts, conflictedItemIds, type RankableMemoryItem, type ConflictableMemoryItem } from './context.js';
import type { MemoryType, MemoryConfirmationState } from '../memory/memory.js';

function item(over: Partial<RankableMemoryItem> & { type: MemoryType }): RankableMemoryItem {
  return { content: 'x', confidence: 0.5, confirmationState: 'accepted', createdAt: '2026-01-01T00:00:00.000Z', ...over };
}

describe('provenanceTier', () => {
  test('authoritative user types are tier 1', () => {
    for (const t of ['user_fact', 'user_preference', 'constraint', 'approved_decision', 'measured_outcome', 'correction'] as const) {
      expect(provenanceTier({ type: t, confirmationState: 'proposed' })).toBe(1);
    }
  });
  test('ai_assumption is tier 2, research_finding is tier 3', () => {
    expect(provenanceTier({ type: 'ai_assumption', confirmationState: 'accepted' })).toBe(2);
    expect(provenanceTier({ type: 'research_finding', confirmationState: 'accepted' })).toBe(3);
  });
  test('invalidated items are EXCLUDED (never fed to the model)', () => {
    expect(provenanceTier({ type: 'user_fact', confirmationState: 'invalidated' })).toBeNull();
    expect(provenanceTier({ type: 'ai_assumption', confirmationState: 'invalidated' })).toBeNull();
  });
});

describe('rankMemoryForContext', () => {
  test('confirmed user items precede assumptions precede research findings (MEM-004 ordering)', () => {
    const items = [item({ type: 'research_finding', content: 'r' }), item({ type: 'ai_assumption', content: 'a' }), item({ type: 'user_fact', content: 'u' })];
    expect(rankMemoryForContext(items).map((i) => i.content)).toEqual(['u', 'a', 'r']);
  });
  test('within a tier: validated/accepted before proposed, then higher confidence, then recency', () => {
    const items = [
      item({ type: 'user_fact', content: 'proposed', confirmationState: 'proposed', confidence: 0.9 }),
      item({ type: 'user_fact', content: 'low-conf', confirmationState: 'accepted', confidence: 0.4 }),
      item({ type: 'user_fact', content: 'high-conf', confirmationState: 'accepted', confidence: 0.8 }),
    ];
    expect(rankMemoryForContext(items).map((i) => i.content)).toEqual(['high-conf', 'low-conf', 'proposed']);
  });
  test('recency breaks a confidence tie (newer first)', () => {
    const items = [
      item({ type: 'constraint', content: 'older', confidence: 0.6, createdAt: '2026-01-01T00:00:00.000Z' }),
      item({ type: 'constraint', content: 'newer', confidence: 0.6, createdAt: '2026-06-01T00:00:00.000Z' }),
    ];
    expect(rankMemoryForContext(items).map((i) => i.content)).toEqual(['newer', 'older']);
  });
  test('invalidated items are dropped from the ranking', () => {
    const items = [item({ type: 'user_fact', content: 'keep' }), item({ type: 'user_fact', content: 'drop', confirmationState: 'invalidated' })];
    expect(rankMemoryForContext(items).map((i) => i.content)).toEqual(['keep']);
  });
});

describe('detectMemoryConflicts (MEM-004, model-free)', () => {
  const ci = (id: string, type: MemoryType, sourceRef: string, confirmationState: MemoryConfirmationState = 'accepted'): ConflictableMemoryItem => ({ id, type, sourceRef, confirmationState });

  test('a confirmed user item + an AI assumption sharing a source_ref is a conflict', () => {
    const conflicts = detectMemoryConflicts([ci('u1', 'user_fact', 'question:7'), ci('a1', 'ai_assumption', 'question:7')]);
    expect(conflicts).toEqual([{ sourceRef: 'question:7', confirmedItemIds: ['u1'], assumptionItemIds: ['a1'] }]);
  });
  test('same-tier items on one source_ref are NOT a conflict (needs confirmed AND assumption)', () => {
    expect(detectMemoryConflicts([ci('u1', 'user_fact', 'q:1'), ci('u2', 'constraint', 'q:1')])).toEqual([]);
    expect(detectMemoryConflicts([ci('a1', 'ai_assumption', 'q:1'), ci('a2', 'ai_assumption', 'q:1')])).toEqual([]);
  });
  test('a confirmed item + an assumption on DIFFERENT source_refs is NOT a conflict', () => {
    expect(detectMemoryConflicts([ci('u1', 'user_fact', 'q:1'), ci('a1', 'ai_assumption', 'q:2')])).toEqual([]);
  });
  test('an INVALIDATED assumption never participates in a conflict', () => {
    expect(detectMemoryConflicts([ci('u1', 'user_fact', 'q:1'), ci('a1', 'ai_assumption', 'q:1', 'invalidated')])).toEqual([]);
  });
  test('items with an empty source_ref are ignored', () => {
    expect(detectMemoryConflicts([ci('u1', 'user_fact', ''), ci('a1', 'ai_assumption', '')])).toEqual([]);
  });
  test('conflictedItemIds collects every participating item id', () => {
    const conflicts = detectMemoryConflicts([ci('u1', 'user_fact', 'q:1'), ci('a1', 'ai_assumption', 'q:1'), ci('a2', 'ai_assumption', 'q:1')]);
    expect([...conflictedItemIds(conflicts)].sort()).toEqual(['a1', 'a2', 'u1']);
  });
});

describe('secret blocklist (invariant 12 / NFR-018)', () => {
  // Each entry is a SYNTHETIC secret + the raw substring that must NOT survive redaction.
  const seeded: ReadonlyArray<{ readonly label: string; readonly text: string; readonly raw: string }> = [
    { label: 'PEM private key', text: 'key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIBfakeAAAA1111bbbb2222\n-----END RSA PRIVATE KEY-----\ndone', raw: 'MIIBfakeAAAA1111bbbb2222' },
    { label: 'connection string with creds', text: 'db is postgres://admin:hunter2secretpw@db.example.com:5432/app now', raw: 'hunter2secretpw' },
    { label: 'Bearer token', text: 'header Authorization: Bearer abcdEFGH1234ijklMNOP5678zzzz end', raw: 'abcdEFGH1234ijklMNOP5678zzzz' },
    { label: 'OpenAI project key', text: 'use sk-proj-ABCdef1234567890ghijklmnop for calls', raw: 'sk-proj-ABCdef1234567890ghijklmnop' },
    { label: 'Anthropic key', text: 'anthropic sk-ant-api03-AAAAbbbbccccdddd1111eeee here', raw: 'sk-ant-api03-AAAAbbbbccccdddd1111eeee' },
    { label: 'Stripe live key', text: 'stripe sk_live_ABCdef1234567890ghijkl set', raw: 'sk_live_ABCdef1234567890ghijkl' },
    { label: 'AWS access key id', text: 'aws AKIAIOSFODNN7EXAMPLE creds', raw: 'AKIAIOSFODNN7EXAMPLE' },
    { label: 'GitHub token', text: 'gh ghp_ABCdef1234567890ABCdef1234567890abcd token', raw: 'ghp_ABCdef1234567890ABCdef1234567890abcd' },
    { label: 'Google API key', text: 'g AIzaSyABCdef1234567890_-ABCdef12345 key', raw: 'AIzaSyABCdef1234567890_-ABCdef12345' },
    { label: 'Slack token', text: 'slack xoxb-1234567890-ABCdefGHIjkl token', raw: 'xoxb-1234567890-ABCdefGHIjkl' },
    { label: 'high-entropy token', text: 'token aB3dEfGh1jKlMnOp2qRsTuVwXyZ3456789012345678 end', raw: 'aB3dEfGh1jKlMnOp2qRsTuVwXyZ3456789012345678' },
  ];

  test.each(seeded)('a seeded $label is detected and its raw value never survives redaction', ({ text, raw }) => {
    expect(containsSecret(text)).toBe(true);
    const red = redactSecrets(text);
    expect(red).not.toContain(raw);
    expect(red).toContain(SECRET_PLACEHOLDER);
  });

  test('ordinary business text is NOT flagged and passes through unchanged (no false positives)', () => {
    const benign = [
      'We sell single-origin coffee to small shops in Cairo, with monthly subscription pricing.',
      'Our margin is about 40% and we plan to expand to Alexandria in Q3 2026.',
      'The founder previously ran a bakery; contact them at founder@example.com or +20 100 123 4567.',
      'Order id 3f2a9c is pending; SKU COFFEE-250G costs 120 EGP wholesale.',
    ];
    for (const b of benign) {
      expect(containsSecret(b)).toBe(false);
      expect(redactSecrets(b)).toBe(b);
    }
  });

  test('redaction removes ALL secrets when several appear in one text', () => {
    const text = 'keys AKIAIOSFODNN7EXAMPLE and sk_live_ABCdef1234567890ghijkl together';
    const red = redactSecrets(text);
    expect(red).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(red).not.toContain('sk_live_ABCdef1234567890ghijkl');
    expect(red.match(/\[REDACTED_SECRET\]/g)).toHaveLength(2);
  });

  // ── security-review regressions (H1, H2, M1) ────────────────────────────────────────────────────────
  test('H2 (fail-closed): a truncated PEM key with NO END line still has its raw body redacted', () => {
    const body = 'MIIBAAAAbbbbCCCCddddEEEEffffGGGGhhhh0000';
    const text = `key pasted:\n-----BEGIN RSA PRIVATE KEY-----\n${body}\nStUvWxYz1234abcd\n\nrest of note`;
    const red = redactSecrets(text);
    expect(red).not.toContain(body);
    expect(red).not.toContain('StUvWxYz1234abcd');
    expect(red).toContain(SECRET_PLACEHOLDER);
  });

  test('H1 (no ReDoS): a large adversarial BEGIN-with-no-END input redacts in bounded (linear) time', () => {
    // ~1.5 MB of BEGIN markers with no END terminator. The OLD unbounded pattern was QUADRATIC here (reviewer-measured
    // ~23 s); the bounded pattern is LINEAR (~3 s). The generous 10 s bound catches a regression to the quadratic
    // pattern without being flaky on a slow/shared CI runner (where the linear pass still finishes with wide margin).
    const adversarial = '-----BEGIN A PRIVATE KEY-----x'.repeat(50_000);
    const start = Date.now();
    redactSecrets(adversarial);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  test('M1: a JWT is redacted', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdFNpZ25hdHVyZUFiQzEyMw';
    const red = redactSecrets(`token ${jwt} end`);
    expect(red).not.toContain(jwt);
    expect(red).toContain(SECRET_PLACEHOLDER);
  });

  test('M1: password/api_key assignments are redacted (value never survives)', () => {
    for (const s of ['password=hunter2secret', 'api_key: Abc123Def456', 'client_secret="s3cr3tValueHere"']) {
      const red = redactSecrets(`config ${s} more`);
      expect(red).not.toMatch(/hunter2secret|Abc123Def456|s3cr3tValueHere/);
      expect(red).toContain(SECRET_PLACEHOLDER);
    }
  });
});
