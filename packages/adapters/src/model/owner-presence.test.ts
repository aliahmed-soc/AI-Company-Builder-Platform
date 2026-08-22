// @acbp/adapters — the owner-presence gate on live, paid model calls (AGENTS.md §1; adopted from PR #109).
//
// The rule it enforces: once ANTHROPIC_API_KEY exists in the environment, that is a CREDENTIAL, not a permission.
// No live call may happen without the owner present and saying "run it" for that specific call — every time, not
// only the first time.
//
// Before this module the rule lived only as a paragraph in AGENTS.md, which is prose an agent can read past. These
// tests exist so that an agent which ignored the paragraph is still stopped by a throw.
import { describe, test, expect } from 'vitest';
import {
  LiveCallNotAuthorizedError,
  grantLiveCalls,
  refuseAllLiveCalls,
  type OwnerPresenceGate,
} from './owner-presence.js';

const CTX = { modelId: 'claude-opus-5' } as const;

describe('the default is refusal', () => {
  test('refuseAllLiveCalls() throws, and names the rule rather than a bare failure', () => {
    const gate = refuseAllLiveCalls();

    expect(() => gate.authorizeOneCall(CTX)).toThrow(LiveCallNotAuthorizedError);
    // The message has to tell an operator what to DO. A gate that says only "denied" gets worked around by the
    // next reader instead of satisfied.
    expect(() => gate.authorizeOneCall(CTX)).toThrow(/owner/i);
    expect(() => gate.authorizeOneCall(CTX)).toThrow(/AGENTS\.md/);
  });

  test('refusal is not exhaustible — it still refuses the hundredth time', () => {
    // A "refuse" implemented as a counter starting at zero could underflow or wrap. This pins that refusal has no
    // state that repetition can consume.
    const gate = refuseAllLiveCalls();
    for (let i = 0; i < 100; i++) expect(() => gate.authorizeOneCall(CTX)).toThrow(LiveCallNotAuthorizedError);
  });

  test('the error carries the model id, and NEVER a credential', () => {
    const gate = refuseAllLiveCalls();
    try {
      gate.authorizeOneCall({ modelId: 'claude-opus-5' });
      throw new Error('unreachable: the gate did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LiveCallNotAuthorizedError);
      expect((err as Error).message).toContain('claude-opus-5');
      expect((err as Error).message).not.toMatch(/sk-ant/);
    }
  });
});

describe('a grant is SINGLE USE — this is the whole point', () => {
  test('one grant authorizes exactly one call, and the second call throws', () => {
    // "Every time, not just the first time" is the rule. A grant that stayed valid would authorize an unbounded
    // run of paid calls from one human "yes", which is precisely what the rule forbids.
    const gate = grantLiveCalls();

    expect(() => gate.authorizeOneCall(CTX)).not.toThrow();
    expect(() => gate.authorizeOneCall(CTX)).toThrow(LiveCallNotAuthorizedError);
  });

  test('a grant of N authorizes exactly N, then refuses', () => {
    const gate = grantLiveCalls(3);

    for (let i = 0; i < 3; i++) expect(() => gate.authorizeOneCall(CTX), `call ${String(i + 1)} of 3`).not.toThrow();
    expect(() => gate.authorizeOneCall(CTX)).toThrow(LiveCallNotAuthorizedError);
  });

  test('the exhausted message says the grant ran out — a different cause from never having one', () => {
    // Two failures that read identically would send an operator down the wrong path: "I did authorize it" versus
    // "you authorized one, and this is the second".
    const gate = grantLiveCalls(1);
    gate.authorizeOneCall(CTX);

    expect(() => gate.authorizeOneCall(CTX)).toThrow(/exhausted|already used|consumed/i);
  });

  test('a grant of zero is a refusal, not an unbounded grant', () => {
    // The obvious off-by-one. `remaining > 0` and `remaining !== 0` differ here only when someone passes 0.
    expect(() => grantLiveCalls(0).authorizeOneCall(CTX)).toThrow(LiveCallNotAuthorizedError);
  });

  test('a negative or non-integer grant is rejected at construction, not silently coerced', () => {
    expect(() => grantLiveCalls(-1)).toThrow(/count/i);
    expect(() => grantLiveCalls(1.5)).toThrow(/count/i);
    expect(() => grantLiveCalls(Number.NaN)).toThrow(/count/i);
  });

  test('grants do not leak between gates', () => {
    const a = grantLiveCalls(1);
    const b = grantLiveCalls(1);
    a.authorizeOneCall(CTX);
    // Consuming a's grant must not consume b's — module-level state would break this.
    expect(() => b.authorizeOneCall(CTX)).not.toThrow();
  });
});

describe('the type is satisfiable by a caller, but refusal is the default they get', () => {
  test('a custom gate is accepted where OwnerPresenceGate is expected', () => {
    let seen = '';
    const custom: OwnerPresenceGate = {
      authorizeOneCall: (ctx) => {
        seen = ctx.modelId;
      },
    };
    custom.authorizeOneCall(CTX);
    expect(seen).toBe('claude-opus-5');
  });
});
