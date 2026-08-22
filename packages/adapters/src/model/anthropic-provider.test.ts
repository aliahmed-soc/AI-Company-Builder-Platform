// @acbp/adapters — AnthropicModelProvider (ACBP-API-006; CDR-091).
//
// The provider maps ONE resolved model call onto the Anthropic Messages API and maps the response back onto the
// platform's `ModelProviderResponse`. Everything above it — retry, re-ask, fallback, metering — is the gateway's
// job and is deliberately NOT duplicated here.
//
// THE LOAD-BEARING TEST IN THIS FILE IS `maxRetries: 0` (CDR-091 §3.4). The SDK retries internally by default
// (`maxRetries: 2`), inside `generate()`, where the gateway cannot see it: the gateway would record ONE usage
// event carrying only the final attempt's tokens while the provider billed every attempt, and the two retry
// layers would multiply to as many as nine provider calls for one logical generation. That is a money defect,
// not a tidiness one, which is why it is asserted rather than commented.
import { describe, test, expect, vi } from 'vitest';
import { Secret } from '@acbp/config';
import { isPlatformError, toModelId, type ModelMessage, type PlatformError } from '@acbp/contracts';
import {
  AnthropicModelProvider,
  ANTHROPIC_PROVIDER_NAME,
  ANTHROPIC_CLIENT_TIMEOUT_MS,
  UnsupportedCredentialError,
  classifyCredential,
} from './anthropic-provider.js';
import { LiveCallNotAuthorizedError, grantLiveCalls } from './owner-presence.js';

/**
 * A synthetic key, never a real one — and DELIBERATELY NOT KEY-SHAPED.
 *
 * The first draft used a realistic `sk-ant-…` prefix and `tools/check-secrets.mjs` flagged it (rule
 * `openai-key`). The repo's standing precedent — recorded in the trust-critical #15 secret-egress suite — is to
 * change the SHAPE rather than add an allowlist entry, because an allowlist line silences that rule for the whole
 * file forever, including for a real key pasted in later. Nothing here needs a realistic prefix: CDR-091 §4
 * deliberately asserts no key format in config validation, so no code path under test parses this value.
 */
const FAKE_KEY = new Secret('SYNTHETIC-PROVIDER-CREDENTIAL-FOR-TESTS-NOT-A-KEY');

/**
 * The credential-class tests below are DIFFERENT: their whole subject is the prefix, so unlike `FAKE_KEY` above
 * they cannot simply be reshaped out of the scanner's way — `classifyCredential` dispatches on `sk-ant-oat`.
 *
 * So the literal is ASSEMBLED AT RUNTIME and never appears in the source. The scanner reads files, not values,
 * so this keeps the rule armed for the whole file (an allowlist entry would disarm it permanently, including for
 * a real key pasted here later) while the tests still exercise the exact prefixes the product branches on.
 */
const synthetic = (kind: 'oat01' | 'api03', suffix = 'SYNTHETIC-NOT-A-REAL-CREDENTIAL'): string =>
  ['sk', 'ant', kind, suffix].join('-');

const MESSAGES: readonly ModelMessage[] = [
  { role: 'system', content: 'You are a strategy analyst.' },
  { role: 'user', content: 'Produce one option.' },
];

/** A minimal stand-in for the SDK's `messages.create`, so no test in this file reaches the network. */
function stubClient(reply: unknown, capture?: { params?: Record<string, unknown> }) {
  return {
    messages: {
      create: vi.fn((params: Record<string, unknown>) => {
        if (capture !== undefined) capture.params = params;
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve(reply);
      }),
    },
  };
}

function okReply(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_synthetic_01',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{"ok":true}' }],
    usage: { input_tokens: 120, output_tokens: 45 },
    ...overrides,
  };
}

/**
 * A provider authorized for EXACTLY ONE live call.
 *
 * The grant is explicit rather than defaulted, because the default is refusal (AGENTS.md §1) and every test that
 * calls `generate` is thereby stating how many calls it expects to make. A test that accidentally called twice
 * would fail on the second, which is the behaviour under test rather than an obstacle to it.
 */
function provider(client: unknown, apiKey: Secret = FAKE_KEY) {
  return new AnthropicModelProvider({ apiKey, client: client as never, ownerPresence: grantLiveCalls(1) });
}

describe('AnthropicModelProvider — ACBP-API-006 / CDR-091', () => {
  // ── THE MONEY GUARD ────────────────────────────────────────────────────────────────────────────────────────
  test('CDR-091 §3.4: the SDK client is constructed with maxRetries 0 — the gateway owns the ONLY retry layer', () => {
    const constructed: Array<Record<string, unknown>> = [];
    class SpyClient {
      readonly messages = { create: vi.fn(() => Promise.resolve(okReply())) };
      constructor(opts: Record<string, unknown>) {
        constructed.push(opts);
      }
    }
    new AnthropicModelProvider({ apiKey: FAKE_KEY, clientFactory: (o) => new SpyClient(o) });

    expect(constructed).toHaveLength(1);
    // Explicitly 0, not merely falsy: `undefined` would inherit the SDK's default of 2 and reintroduce the
    // invisible retry layer this assertion exists to forbid.
    expect(constructed[0]?.['maxRetries']).toBe(0);
  });

  // ── CREDENTIAL CLASS (CDR-091 §5) ──────────────────────────────────────────────────────────────────────────
  // Anthropic issues two credential kinds that are NOT interchangeable, and the failure mode when they are
  // confused is actively misleading: an OAuth token sent as `x-api-key` returns "API key is invalid." — which
  // reads as a typo and sends the reader hunting the wrong bug. These tests pin the routing.
  describe('credential class', () => {
    function optionsFor(secret: Secret): Record<string, unknown> {
      const seen: Array<Record<string, unknown>> = [];
      new AnthropicModelProvider({
        apiKey: secret,
        clientFactory: (o) => {
          seen.push(o);
          return { messages: { create: () => Promise.resolve(okReply()) } };
        },
      });
      expect(seen).toHaveLength(1);
      return seen[0] as Record<string, unknown>;
    }

    test('classifyCredential distinguishes the two shapes', () => {
      expect(classifyCredential(synthetic('oat01','abc'))).toBe('oauth');
      expect(classifyCredential(synthetic('api03','abc'))).toBe('api_key');
      // Anything unrecognised is treated as an API key: that is the historical behaviour and the only one that
      // keeps working if Anthropic introduces a new API-key prefix. Guessing `oauth` would break every real key.
      expect(classifyCredential('some-other-shape')).toBe('api_key');
    });

    // ── THE REFUSAL (CDR-091 §5, owner ruling 2026-08-14) ────────────────────────────────────────────────────
    // OAuth credentials are restricted by Anthropic to Claude Code and Claude.ai, so they are not a sanctioned
    // credential for this product. The provider REFUSES them rather than routing them: a dead-but-functional
    // branch invites a later reader who discovers it works to switch it on.
    test('THE GUARD: construction REFUSES an sk-ant-oat credential', () => {
      expect(() => provider(stubClient(okReply()), new Secret(synthetic('oat01')))).toThrow(
        UnsupportedCredentialError,
      );
    });

    test('the refusal fires BEFORE any client is built — nothing is allocated for a credential we will not use', () => {
      const factory = vi.fn(() => ({ messages: { create: () => Promise.resolve(okReply()) } }));
      expect(
        () => new AnthropicModelProvider({ apiKey: new Secret(synthetic('oat01')), clientFactory: factory }),
      ).toThrow(UnsupportedCredentialError);
      expect(factory).not.toHaveBeenCalled();
    });

    test('the refusal names the credential class and cites the ruling, so the operator knows what to do', () => {
      let caught: unknown;
      try {
        new AnthropicModelProvider({ apiKey: new Secret(synthetic('oat01')) });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnsupportedCredentialError);
      const message = (caught as Error).message;
      expect(message).toContain('OAuth');
      expect(message).toContain('CDR-091');
      // Actionable, not merely negative: it must say what IS accepted.
      expect(message).toContain('sk-ant-api');
      expect((caught as UnsupportedCredentialError).credentialKind).toBe('oauth');
    });

    test('SECURITY: the refusal never carries the credential value', () => {
      const token = synthetic('oat01', 'MUST-NOT-APPEAR-IN-ANY-ERROR');
      let caught: unknown;
      try {
        new AnthropicModelProvider({ apiKey: new Secret(token) });
      } catch (error) {
        caught = error;
      }
      const surface = `${(caught as Error).message}\n${(caught as Error).stack ?? ''}`;
      expect(surface).not.toContain(token);
      expect(surface).not.toContain('MUST-NOT-APPEAR-IN-ANY-ERROR');
    });

    test('an API key goes to apiKey, sets NO authToken, and carries no oauth beta header', () => {
      const o = optionsFor(new Secret(synthetic('api03')));
      expect(o['apiKey']).toBe(synthetic('api03'));
      expect(o['authToken'] ?? null).toBeNull();
      const headers = (o['defaultHeaders'] ?? {}) as Record<string, string>;
      expect(headers['anthropic-beta']).toBeUndefined();
    });

    test('authToken is NEVER set on any accepted credential — one auth scheme reaches the SDK, never two', () => {
      // With the OAuth branch refused rather than routed, `authToken` should now be unreachable. Asserted rather
      // than assumed: a future edit that reintroduces it would otherwise be silent, and the API rejects a
      // request carrying two auth schemes.
      const o = optionsFor(new Secret(synthetic('api03', 'x')));
      expect(o['authToken'] ?? null).toBeNull();
      expect(o['apiKey']).toBe(synthetic('api03', 'x'));
    });
  });

  test('CDR-091 §2.1: the provider deadline is STRICTLY INSIDE the gateway generation deadline', async () => {
    // The ordering is the invariant, not either number on its own. If the provider's timeout ever exceeded the
    // gateway's class deadline, the gateway would always fire first and the provider's own abort would be dead
    // code — a silent inversion that no other test would notice.
    const { TIMEOUT_CLASS_MS } = await import('@acbp/contracts');
    expect(ANTHROPIC_CLIENT_TIMEOUT_MS).toBeLessThan(TIMEOUT_CLASS_MS.generation);
    expect(ANTHROPIC_CLIENT_TIMEOUT_MS).toBe(60_000);
  });

  // ── RESPONSE MAPPING ───────────────────────────────────────────────────────────────────────────────────────
  test('a completed response maps to completed, with usage and the provider-reported model version', async () => {
    const res = await provider(stubClient(okReply())).generate({ modelId: toModelId('claude-opus-5'), messages: MESSAGES });

    expect(res.finishStatus).toBe('completed');
    expect(res.output).toBe('{"ok":true}');
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 45, totalTokens: 165 });
    expect(res.modelVersion).toBe('claude-opus-5');
    expect(res.providerRequestId).toBe('msg_synthetic_01');
  });

  test('stop_reason max_tokens maps to length — a truncated answer is not a completed one', async () => {
    const res = await provider(stubClient(okReply({ stop_reason: 'max_tokens' }))).generate({
      modelId: toModelId('claude-opus-5'),
      messages: MESSAGES,
    });
    expect(res.finishStatus).toBe('length');
  });

  test('stop_reason refusal maps to refused, and carries no provider explanation text', async () => {
    const res = await provider(
      stubClient(
        okReply({
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: 'PROVIDER-EXPLANATION-SHOULD-NOT-ESCAPE' },
          content: [],
        }),
      ),
    ).generate({ modelId: toModelId('claude-opus-5'), messages: MESSAGES });

    expect(res.finishStatus).toBe('refused');
    expect(res.output).not.toContain('PROVIDER-EXPLANATION-SHOULD-NOT-ESCAPE');
  });

  test('concatenates every text block, and selects on BLOCK TYPE — not merely on the presence of a text field', async () => {
    // The middle fixture is the load-bearing one. An earlier version of this test used only
    // `{type:'thinking', thinking:'…'}`, which carries NO `text` field — so it was excluded by the
    // `typeof b.text === 'string'` half of the filter and the TYPE check was never exercised. Mutation M-AP3
    // (weakening the type check) survived against that fixture. A non-text block that DOES carry a `text`
    // field is what makes the type check the thing under test.
    const res = await provider(
      stubClient(
        okReply({
          content: [
            { type: 'thinking', thinking: 'INTERNAL-REASONING-NOT-OUTPUT' },
            { type: 'redacted_thinking', text: 'NON-TEXT-BLOCK-WITH-A-TEXT-FIELD' },
            { type: 'text', text: 'part one ' },
            { type: 'text', text: 'part two' },
          ],
        }),
      ),
    ).generate({ modelId: toModelId('claude-opus-5'), messages: MESSAGES });

    expect(res.output).toBe('part one part two');
    expect(res.output).not.toContain('INTERNAL-REASONING-NOT-OUTPUT');
    expect(res.output).not.toContain('NON-TEXT-BLOCK-WITH-A-TEXT-FIELD');
  });

  test('an unrecognised stop_reason is an ERROR, never a silent success', async () => {
    // A future API version adding a reason must not let a partial or declined answer be persisted as a real
    // one. `completed` is the dangerous default here, so the fallback arm is pinned.
    const res = await provider(stubClient(okReply({ stop_reason: 'some_future_reason' }))).generate({
      modelId: toModelId('claude-opus-5'),
      messages: MESSAGES,
    });
    expect(res.finishStatus).toBe('error');
  });

  // ── REQUEST MAPPING ────────────────────────────────────────────────────────────────────────────────────────
  test('the system message becomes the top-level system parameter, not a user turn', async () => {
    const capture: { params?: Record<string, unknown> } = {};
    await provider(stubClient(okReply(), capture)).generate({ modelId: toModelId('claude-opus-5'), messages: MESSAGES });

    expect(capture.params?.['system']).toBe('You are a strategy analyst.');
    // The Messages API rejects a `system` role inside `messages`; sending it there would 400 on every call.
    const sent = capture.params?.['messages'] as Array<{ role: string }>;
    expect(sent.every((m) => m.role !== 'system')).toBe(true);
    expect(sent).toEqual([{ role: 'user', content: 'Produce one option.' }]);
  });

  test('adaptive thinking is set EXPLICITLY rather than relying on a model-generation default', async () => {
    const capture: { params?: Record<string, unknown> } = {};
    await provider(stubClient(okReply(), capture)).generate({ modelId: toModelId('claude-opus-5'), messages: MESSAGES });
    expect(capture.params?.['thinking']).toEqual({ type: 'adaptive' });
  });

  // ── ERROR NORMALIZATION ────────────────────────────────────────────────────────────────────────────────────
  test('a thrown SDK error becomes a normalized PlatformError and never carries the raw provider text', async () => {
    const raw = new Error('ANTHROPIC-RAW-SDK-TEXT-MUST-NOT-ESCAPE');
    await expect(
      provider(stubClient(raw)).generate({ modelId: toModelId('claude-opus-5'), messages: MESSAGES }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!isPlatformError(err)) return false;
      // `toPublic()` is the real client-facing envelope — NOT an optional call. An earlier draft of this test
      // used `err.toPublicEnvelope?.()`, a method that does not exist: the optional call yielded `undefined`,
      // the assertion compared against `{}`, and it passed while proving nothing. Naming the real method is
      // what makes this test capable of failing.
      const publicEnvelope = JSON.stringify(err.toPublic());
      expect(publicEnvelope.length).toBeGreaterThan(2); // non-vacuity: there is a real envelope to search
      return !publicEnvelope.includes('ANTHROPIC-RAW-SDK-TEXT-MUST-NOT-ESCAPE');
    });
  });

  test('CONTROL: the raw provider text really is present internally — so the assertion above is not vacuous', async () => {
    const raw = new Error('ANTHROPIC-RAW-SDK-TEXT-MUST-NOT-ESCAPE');
    const err = await provider(stubClient(raw))
      .generate({ modelId: toModelId('claude-opus-5'), messages: MESSAGES })
      .catch((e: unknown) => e);
    // If the provider stopped attaching the cause entirely, the leak test above would pass for the wrong
    // reason. This pins that there IS something to leak, so "it did not leak" is a real result.
    expect(isPlatformError(err)).toBe(true);
    expect(JSON.stringify((err as PlatformError).toInternal())).toContain('ANTHROPIC-RAW-SDK-TEXT-MUST-NOT-ESCAPE');
  });

  test('the API key never appears in a thrown error', async () => {
    const raw = new Error('boom');
    const err = await provider(stubClient(raw))
      .generate({ modelId: toModelId('claude-opus-5'), messages: MESSAGES })
      .catch((e: unknown) => e);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(FAKE_KEY.reveal());
  });

  // ── THE OWNER-PRESENCE GATE (AGENTS.md §1; adopted from PR #109) ───────────────────────────────────────────
  // Deleting the `authorizeOneCall` line from `generate` makes every test in this block fail. That is the point
  // of the block: before it existed, the rule was a paragraph in AGENTS.md and nothing could go red.
  describe('AGENTS.md §1 — no live call without owner authorization, every time', () => {
    test('generate REFUSES when no gate was supplied — an omitted gate is a refusing gate, not an absent one', async () => {
      // Constructed WITHOUT `ownerPresence`. If the default were permissive, or if the field were optional at the
      // call site (`this.#ownerPresence?.`), this would resolve instead of throwing.
      const p = new AnthropicModelProvider({ apiKey: FAKE_KEY, client: stubClient(okReply()) as never });

      await expect(p.generate({ modelId: toModelId('claude-opus-5'), messages: MESSAGES })).rejects.toBeInstanceOf(
        LiveCallNotAuthorizedError,
      );
    });

    test('the refusal happens BEFORE the client is touched — a refused call costs nothing', async () => {
      // A gate that ran after prompt assembly, or after the request left, would still bill. `create` must not
      // have been reached at all.
      //
      // Asserted on the MOCK, not on a capture object. The first version of this test declared `capture` as an
      // empty array and asserted `toHaveLength(0)` — which an empty array satisfies whether or not the client was
      // called, so it could not have failed. §3: could a wrong implementation produce this same result? It could.
      const client = stubClient(okReply());
      const p = new AnthropicModelProvider({ apiKey: FAKE_KEY, client: client as never });

      await p.generate({ modelId: toModelId('claude-opus-5'), messages: MESSAGES }).catch(() => undefined);

      expect(client.messages.create, 'the SDK client was called despite the gate refusing').not.toHaveBeenCalled();
    });

    test('a grant is consumed per call: the FIRST succeeds and the SECOND is refused', async () => {
      // "Every time, not just the first time" — the clause that makes this a per-call gate rather than a switch.
      const p = new AnthropicModelProvider({
        apiKey: FAKE_KEY,
        client: stubClient(okReply()) as never,
        ownerPresence: grantLiveCalls(1),
      });
      const req = { modelId: toModelId('claude-opus-5'), messages: MESSAGES };

      await expect(p.generate(req)).resolves.toBeDefined();
      await expect(p.generate(req)).rejects.toBeInstanceOf(LiveCallNotAuthorizedError);
    });

    test('CONTROL: with a grant, the call really does go through — the refusals above are not vacuous', async () => {
      // Without this, a provider that refused unconditionally would satisfy every test above while destroying
      // the product. This is the assertion that makes the gate a gate rather than a wall.
      const client = stubClient(okReply());
      const p = new AnthropicModelProvider({
        apiKey: FAKE_KEY,
        client: client as never,
        ownerPresence: grantLiveCalls(1),
      });

      const res = await p.generate({ modelId: toModelId('claude-opus-5'), messages: MESSAGES });

      expect(res.finishStatus).toBe('completed');
      expect(client.messages.create).toHaveBeenCalledTimes(1);
    });

    test('SECURITY: the refusal never carries the credential', async () => {
      const p = new AnthropicModelProvider({ apiKey: FAKE_KEY, client: stubClient(okReply()) as never });

      const err = await p.generate({ modelId: toModelId('claude-opus-5'), messages: MESSAGES }).catch((e: unknown) => e);

      expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(FAKE_KEY.reveal());
    });
  });

  test('the provider name is bounded and non-secret', () => {
    expect(ANTHROPIC_PROVIDER_NAME).toBe('anthropic');
  });
});
