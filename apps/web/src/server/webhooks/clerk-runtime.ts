// ACBP-P1-002 Slice 3 — production composition singleton for the Clerk identity runtime (apps/web).
//
// apps/web composes the webhook + read-through ENTIRELY through @acbp/core (the composition layer). It
// never imports @acbp/adapters or @acbp/database directly — the domain boundary stays intact. The
// runtime holds one database client (pool); it is created lazily and reused across requests. Config is
// loaded from the environment at this trusted server boundary (fails fast on invalid config).
import { createClerkIdentityRuntime, type ClerkIdentityRuntime } from '@acbp/core';
import { loadClerkConfig, loadClerkWebhookConfig, loadAppDatabaseConfig } from '@acbp/config';
import { createLogger, createRootContext, type Logger } from '@acbp/observability';

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
    runtime = createClerkIdentityRuntime({ databaseConfig, clerkWebhookConfig, clerkConfig, expectedInstanceId });
  }
  return runtime;
}

/** A per-request-safe structured logger for the webhook component (fresh correlation root). */
export function createWebhookLogger(): Logger {
  return createLogger({ component: 'webhook', context: createRootContext() });
}
