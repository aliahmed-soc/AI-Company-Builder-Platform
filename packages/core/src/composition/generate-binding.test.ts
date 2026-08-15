// ACBP-API-008 slice 3a — the four metered use cases are BOUND to a gateway on the identity runtime.
//
// WHAT THIS PROVES, AND WHY THE ANCHOR IS THE DEPS SLOT. `createClerkIdentityRuntime` wires ~25 use cases; these
// four are the only ones that spend money. A binding that omitted the gateway, or passed `options` into the deps
// position, would still typecheck in several plausible ways — the deps slot is the THIRD positional argument for
// these four and absent for their read-only neighbours, which is exactly the hazard the `editRoadmap` comment in
// clerk-identity.ts already warns about.
//
// THE FIRST VERSION OF THIS FILE ASSERTED "the gateway was called", AND THAT WAS WRONG: with a stub database
// client each use case fails at its first query, long before it reaches a gateway, so the assertion failed for a
// reason that had nothing to do with the binding. Mocking the use cases and inspecting the deps they RECEIVE
// tests the wiring itself, which is the whole of slice 3a.
//
// NO PAID CALL IS EVER MADE: the use cases are mocked, and every runtime here injects `deps.modelGateway`.
import { describe, test, expect, vi, beforeEach } from 'vitest';

const generateStrategyOptions = vi.hoisted(() => vi.fn());
const recommendStrategy = vi.hoisted(() => vi.fn());
const generateRoadmap = vi.hoisted(() => vi.fn());
const generateTasks = vi.hoisted(() => vi.fn());

vi.mock('../strategy/strategy-generation.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateStrategyOptions,
}));
vi.mock('../strategy/strategy-recommendation.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recommendStrategy,
}));
vi.mock('../planning/roadmap-generation.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateRoadmap,
}));
vi.mock('../planning/task-generation.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateTasks,
}));

const { createClerkIdentityRuntime } = await import('./clerk-identity.js');

const CONFIG = {
  databaseConfig: {} as never,
  clerkWebhookConfig: { signingSecret: { reveal: () => 'whsec_test' }, instanceId: 'ins_test' } as never,
  clerkConfig: { secretKey: { reveal: () => 'sk_test' } } as never,
  expectedInstanceId: 'ins_test',
};

/** method name → the mocked use case it must be bound to. Data, so a missing entry is visible. */
const METERED = [
  ['generateStrategyOptions', generateStrategyOptions],
  ['recommendStrategy', recommendStrategy],
  ['generateRoadmap', generateRoadmap],
  ['generateTasks', generateTasks],
] as const;

function runtimeWith(modelGateway?: unknown) {
  return createClerkIdentityRuntime(CONFIG, {
    client: { kysely: {} } as never,
    ...(modelGateway === undefined ? {} : { modelGateway: modelGateway as never }),
  });
}

describe('ACBP-API-008 §3a — metered use cases bound to a gateway', () => {
  beforeEach(() => {
    for (const [, fn] of METERED) fn.mockReset();
    for (const [, fn] of METERED) fn.mockResolvedValue({ status: 'ok' });
  });

  test('composing the runtime NEVER builds a gateway — reads must not depend on model configuration', () => {
    // The regression this pins: hoisting the gateway out of the methods would mean a deployment with no model
    // key could serve NO route at all, including the 36 that never touch a model. `modelProviderConfig` is
    // absent here and composition must still succeed.
    expect(() => runtimeWith(undefined)).not.toThrow();
  });

  // ── THE BINDING ────────────────────────────────────────────────────────────────────────────────────────────
  test.each(METERED)('%s passes the injected gateway in the deps slot', async (name, useCase) => {
    const gateway = vi.fn();
    const runtime = runtimeWith(gateway);
    await (runtime as unknown as Record<string, (p: unknown) => Promise<unknown>>)[name]!({
      userId: 'u',
      accountId: 'a',
      companyId: 'c',
    });

    expect(useCase, `${name} did not reach its use case at all`).toHaveBeenCalledTimes(1);
    const deps = useCase.mock.calls[0]?.[2] as { gateway?: unknown } | undefined;
    // The THIRD positional argument is the deps slot. Passing `options` here instead would compile.
    expect(deps, `${name}: nothing was passed in the deps position`).toBeDefined();
    expect(deps?.gateway, `${name}: the deps slot did not carry the injected gateway`).toBe(gateway);
  });

  test('each metered method is bound to its OWN use case — no crossed wires', async () => {
    const runtime = runtimeWith(vi.fn());
    for (const [name, useCase] of METERED) {
      for (const [, other] of METERED) other.mockClear();
      await (runtime as unknown as Record<string, (p: unknown) => Promise<unknown>>)[name]!({ userId: 'u' });
      expect(useCase, `${name} did not call its own use case`).toHaveBeenCalledTimes(1);
      for (const [otherName, other] of METERED) {
        if (otherName === name) continue;
        expect(other, `${name} also called ${otherName} — the bindings are crossed`).not.toHaveBeenCalled();
      }
    }
  });

  // ── NOT-CONFIGURED IS A NAMED FAILURE, NOT A SILENT ONE ───────────────────────────────────────────────────
  test('a metered call with NO model configuration REJECTS naming the cause', async () => {
    const runtime = runtimeWith(undefined);
    await expect(runtime.generateStrategyOptions({ userId: 'u' } as never)).rejects.toThrow(
      /MODEL_GATEWAY_NOT_CONFIGURED/,
    );
    // Rejects rather than throwing synchronously: the methods are `async` precisely so a caller using `.catch()`
    // rather than try/catch cannot miss it. Asserted, because dropping `async` would silently reintroduce that.
    expect(generateStrategyOptions, 'the use case must NOT run without a gateway').not.toHaveBeenCalled();
  });

  test('SECURITY: the not-configured error carries no key material', async () => {
    const runtime = createClerkIdentityRuntime(
      { ...CONFIG, clerkConfig: { secretKey: { reveal: () => 'sk_SENSITIVE_VALUE' } } as never },
      { client: { kysely: {} } as never },
    );
    const error = await runtime.generateRoadmap({ userId: 'u' } as never).catch((e: unknown) => e);
    const surface = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    expect(surface).not.toContain('sk_SENSITIVE_VALUE');
    expect(surface).not.toContain('whsec_');
  });
});
