// ACBP-P1-002 Slice 3 — production composition singleton for the Clerk identity runtime (apps/web).
//
// apps/web composes the webhook + read-through ENTIRELY through @acbp/core (the composition layer). It
// never imports @acbp/adapters or @acbp/database directly — the domain boundary stays intact. The
// runtime holds one database client (pool); it is created lazily and reused across requests. Config is
// loaded from the environment at this trusted server boundary (fails fast on invalid config).
import { createClerkIdentityRuntime, type ClerkIdentityRuntime } from '@acbp/core';
import { loadClerkConfig, loadClerkWebhookConfig, loadAppDatabaseConfig, type ModelProviderConfig } from '@acbp/config';
import { createLogger, createRootContext, type Logger } from '@acbp/observability';
import { reportModelProviderConfiguration } from '../startup/model-provider-report.js';

let runtime: ClerkIdentityRuntime | undefined;

/** Lazily build (once) and return the shared Clerk identity runtime. */
export function getClerkIdentityRuntime(): ClerkIdentityRuntime {
  if (runtime === undefined) {
    const clerkWebhookConfig = loadClerkWebhookConfig();
    const clerkConfig = loadClerkConfig();
    // Normal runtime uses the RESTRICTED application connection (acbp_app) — never the owner/migration
    // connection (ACBP-P1-006; CDR-013). Fails closed if DATABASE_APP_URL is absent (no owner fallback).
    const databaseConfig = loadAppDatabaseConfig();
    // The expected instance id (read-through providerInstanceId) comes from configuration only; when
    // absent, the read-through provider call fails safe (unavailable) inside the adapter.
    const expectedInstanceId = clerkWebhookConfig.expectedInstanceId ?? '';
    // ── MODEL PROVIDER CONFIG (ACBP-API-008; CDR-092 §9 — owner ruling 2026-08-15) ──────────────────────────
    //
    // STARTUP VISIBILITY IS NOW REAL, and this comment records what changed rather than what was hoped for.
    // Two earlier versions of it were wrong in opposite directions: the first claimed a missing or unparseable
    // ANTHROPIC_API_KEY was "visible at startup" when nothing ran at boot, and the second correctly said it did
    // NOT fire at startup and that an `instrumentation.ts` was open and unbuilt. ACBP-API-012 built it.
    //
    // What happens now: `apps/web/src/instrumentation.ts` calls the SAME report at boot, once per server
    // process, before the first request — so an operator starting the server learns immediately whether the key
    // is usable. This call site still reports too, and deliberately: `getClerkIdentityRuntime` is a lazy
    // singleton that a warm process may compose long after boot, and the report is what supplies the parsed
    // config here. Both paths share one definition in `server/startup/model-provider-report.ts`, so the boot
    // line and this line cannot drift into describing the same condition differently.
    //
    // The failure is NON-FATAL, and that part was always accurate: this runtime serves every route in the
    // application, so a fatal model misconfiguration would take down the 32 routes that never touch a model along
    // with the 4 that do.
    //
    // ERROR level, not warn: for any deployment meant to generate, this is a real misconfiguration, and warn is
    // where such lines go to be filtered out. The record carries the FACT of absence and its consequence —
    // never key material, and never the parser's message, which can quote the offending value.
    const report = reportModelProviderConfiguration({
      env: process.env,
      logger: createLogger({ component: 'composition', context: createRootContext() }),
    });
    const modelProviderConfig: ModelProviderConfig | undefined =
      report.state === 'configured' ? report.config : undefined;
    runtime = createClerkIdentityRuntime({
      databaseConfig,
      clerkWebhookConfig,
      clerkConfig,
      expectedInstanceId,
      // Spread rather than passing `undefined`: `exactOptionalPropertyTypes` rejects an explicit undefined for
      // an optional property, and the absence is what the runtime branches on.
      ...(modelProviderConfig === undefined ? {} : { modelProviderConfig }),
    });
  }
  return runtime;
}

/** A per-request-safe structured logger for the webhook component (fresh correlation root). */
export function createWebhookLogger(): Logger {
  return createLogger({ component: 'webhook', context: createRootContext() });
}
