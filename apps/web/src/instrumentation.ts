// ACBP-API-012 — the Next.js startup hook, which is what makes model-provider misconfiguration visible BEFORE
// any request is served (CDR-090 §1-G3).
//
// ⚠️ THE PATH AND THE EXPORT NAME ARE THE CONTRACT, NOT A CONVENTION. Next.js runs `register()` from
// `src/instrumentation.ts` once per server process, at boot, before it serves anything. Rename either and this
// file becomes ordinary dead code that nothing imports and no test would notice — which is precisely the failure
// this ticket exists to correct, in a new costume. `instrumentation-presence.test.ts` pins both.
//
// WHY THIS FILE IS NEARLY EMPTY. All of the behaviour lives in `server/startup/model-provider-report.ts`, which
// `clerk-runtime.ts` also calls. One definition means the boot line and the composition line cannot drift into
// describing the same condition differently. This file is the WIRING, and wiring is what was missing: the rule
// was ruled, the parser threw, and nothing ran either at boot.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not construct the runtime, open a database connection, or reach
// the network. A boot hook that did real work would turn a misconfiguration into a slow start or a crash loop,
// and the report it exists to emit would be the thing that never got emitted.
import { createLogger, createRootContext } from '@acbp/observability';
import { reportModelProviderConfiguration, type ReportLogger } from './server/startup/model-provider-report.js';

export interface StartupDependencies {
  readonly env: Record<string, string | undefined>;
  readonly logger: ReportLogger;
}

/**
 * The real dependencies, built lazily so that merely importing this module has no side effect.
 *
 * A module-level `createLogger(...)` would run on import, which in a test file means constructing a logger just
 * by reading the module — and it would make the "does importing this do anything?" question depend on import
 * order rather than on this function being called.
 */
function productionDependencies(): StartupDependencies {
  return {
    env: process.env,
    logger: createLogger({ component: 'startup', context: createRootContext() }),
  };
}

/**
 * Next.js's instrumentation entry point. Runs once per server process, before the first request.
 *
 * `deps` is optional so the boot path itself is testable without mocking a module: Next calls `register()` with
 * no arguments and gets the production dependencies; a test calls `register({ env, logger })` and asserts on the
 * real emission. The alternative — spying on the logger module — would test the spy, not this function.
 *
 * `async` because Next awaits the result; there is nothing asynchronous to do yet, and adding an await here to
 * "look right" would be inventing work.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Next's contract is a Promise-returning register().
export async function register(deps: StartupDependencies = productionDependencies()): Promise<void> {
  reportModelProviderConfiguration(deps);
}
