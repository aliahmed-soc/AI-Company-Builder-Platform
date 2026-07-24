// @acbp/adapters — fake model provider tests (ACBP-P2-003). Proves the deterministic script/behaviour, that
// failures throw NORMALIZED PlatformErrors (not raw), and that a hang rejects promptly when the caller aborts.
import { describe, test, expect } from 'vitest';
import { isPlatformError, ErrorCodes, toModelId, type ModelProviderRequest } from '@acbp/contracts';
import { FakeModelProvider, FAKE_INTERNAL_MARKER } from './fake-provider.js';

const req: ModelProviderRequest = { modelId: toModelId('m'), messages: [{ role: 'user', content: 'hi' }] };

describe('FakeModelProvider', () => {
  test('default behaviour responds completed with default usage', async () => {
    const p = new FakeModelProvider();
    const r = await p.generate(req);
    expect(r.finishStatus).toBe('completed');
    expect(r.usage.totalTokens).toBeGreaterThan(0);
    expect(p.callCount).toBe(1);
    expect(p.calls).toHaveLength(1);
  });

  test('script is consumed one-per-call; the last entry repeats', async () => {
    const p = new FakeModelProvider({ script: [{ kind: 'respond', output: 'a' }, { kind: 'respond', output: 'b' }] });
    expect((await p.generate(req)).output).toBe('a');
    expect((await p.generate(req)).output).toBe('b');
    expect((await p.generate(req)).output).toBe('b'); // repeats last
    expect(p.callCount).toBe(3);
  });

  test('failures throw a normalized PlatformError (never a raw SDK error), carrying the internal marker', async () => {
    const p = new FakeModelProvider({ behavior: { kind: 'fail', error: 'timeout' } });
    await expect(p.generate(req)).rejects.toSatisfy((e: unknown) => isPlatformError(e) && e.code === ErrorCodes.DEPENDENCY_TIMEOUT);
    // The internal (log-only) message carries the sensitive marker; the PUBLIC envelope must not.
    try {
      await new FakeModelProvider({ behavior: { kind: 'fail', error: 'internal' } }).generate(req);
    } catch (e) {
      expect(isPlatformError(e)).toBe(true);
      if (isPlatformError(e)) {
        expect(e.message).toContain(FAKE_INTERNAL_MARKER); // internal only
        expect(JSON.stringify(e.toPublic())).not.toContain(FAKE_INTERNAL_MARKER);
      }
    }
  });

  test('a hang rejects promptly when the caller aborts', async () => {
    const p = new FakeModelProvider({ behavior: { kind: 'hang', ms: 10_000 } });
    const controller = new AbortController();
    const pending = p.generate(req, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toSatisfy((e: unknown) => isPlatformError(e) && e.code === ErrorCodes.DEPENDENCY_TIMEOUT);
  });
});
