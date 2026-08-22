// ACBP-API-012 — proof that the STARTUP path reports, not a comment claiming it does.
//
// The row's acceptance bar is explicit that the proof must be executable, "because this row exists precisely
// because two comments claimed the property in prose while the code did not deliver it". So this drives
// `register()` — the function Next.js actually calls at boot — rather than asserting anything about it.
//
// ⚠️ WHAT THIS PROVES AND WHAT IT CANNOT. It proves OUR half: `register()` emits the report, importing the
// module emits nothing, and the file sits at the path with the export name Next requires. It does NOT prove that
// Next.js calls `register()` at boot — that is the framework's contract, and this repository cannot test another
// project's scheduler. Stating that boundary is the point; the previous version of this property was believed
// true precisely because nobody drew it.
import { describe, test, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { register } from './instrumentation.js';
import { MODEL_PROVIDER_NOT_CONFIGURED_EVENT } from './server/startup/model-provider-report.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function spyLogger() {
  return { error: vi.fn() };
}

const GOOD_ENV = {
  ANTHROPIC_API_KEY: 'SYNTHETIC-PROVIDER-CREDENTIAL-FOR-TESTS-NOT-A-KEY',
  ANTHROPIC_MODEL_ID: 'claude-opus-5',
};

describe('ACBP-API-012 — the boot hook reports before any request is served', () => {
  test('register() emits the misconfiguration line when the key is absent', async () => {
    const logger = spyLogger();

    await register({ env: {}, logger });

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).toBe(MODEL_PROVIDER_NOT_CONFIGURED_EVENT);
  });

  test('CONTROL: register() emits NOTHING when the configuration is valid', async () => {
    // Without this, a hook that logged unconditionally would satisfy the test above while telling every
    // correctly-configured operator their deployment is broken.
    const logger = spyLogger();

    await register({ env: GOOD_ENV, logger });

    expect(logger.error).not.toHaveBeenCalled();
  });

  test('register() is NON-FATAL — a misconfigured provider must not take down a server that serves 32 other routes', async () => {
    await expect(register({ env: {}, logger: spyLogger() })).resolves.toBeUndefined();
  });

  test('Next can call it with no arguments — the deps parameter is optional', () => {
    // `Function.length` counts parameters BEFORE the first default. A zero here is what lets Next's own
    // `register()` call compile and run; if the parameter became required, boot would fail rather than report.
    expect(register.length).toBe(0);
  });

  test('importing this module has NO side effect — the logger is built only when register runs', () => {
    // A module-level `createLogger(...)` would run on import and make the boot report depend on import order.
    // This test has already imported the module at the top of the file; reaching here without a thrown error or
    // an emitted line is the assertion.
    const src = readFileSync(join(HERE, 'instrumentation.ts'), 'utf8');
    const topLevel = src.split('\n').filter((l) => /^(const|let|var)\s/.test(l));
    expect(topLevel, 'a top-level binding would execute on import').toEqual([]);
  });
});

describe("the Next.js contract — path and export name, which are load-bearing and easy to rename away", () => {
  test('the file is at apps/web/src/instrumentation.ts', () => {
    // Next resolves this by PATH. Moving it makes it dead code that still typechecks, still passes its unit
    // tests, and reports nothing at boot — the exact shape of the defect this ticket corrects.
    expect(existsSync(join(HERE, 'instrumentation.ts'))).toBe(true);
  });

  test('it exports a function literally named `register`', () => {
    expect(typeof register).toBe('function');
    expect(register.name).toBe('register');
  });
});
