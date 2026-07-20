// @acbp/core — Clerk identity COMPOSITION layer (ACBP-P1-002 Slice 3; ADR-022 §13).
//
// This is the ONLY module that knows every concrete implementation at once (per §8): the Clerk webhook
// verifier + Clerk authoritative reader (@acbp/adapters), the database client + repositories
// (@acbp/database, via the processor/use case), the transactional processor + read-through use case
// (this package), and the validated config (@acbp/config types). It exists so apps/web can compose the
// webhook route and the authenticated read-through through @acbp/core ALONE — the web layer never
// imports @acbp/adapters or @acbp/database directly, and no Clerk SDK type ever reaches core's other
// modules (the adapter classes encapsulate the SDK; the signing secret is unwrapped only inside them).
import { ClerkIdentityWebhookVerifier, ClerkAuthoritativeIdentityReader } from '@acbp/adapters';
import { createDatabase, closeDatabase, type DatabaseClient, type ProviderIdentityKey } from '@acbp/database';
import type { ClerkConfig, ClerkWebhookConfig, DatabaseConfig } from '@acbp/config';
import { createIdentityWebhookService, type IdentityWebhookService } from '../identity/webhook-service.js';
import { resolveOrReconcileInternalUser, type InternalUserReconciliation, type ReconcileOptions } from '../identity/read-through.js';
import { reconcileAllUsers, type ReconciliationSummary, type ReconcileOptions as ReconcileAllOptions } from '../identity/reconciliation.js';

export interface ClerkIdentityRuntimeConfig {
  readonly databaseConfig: DatabaseConfig;
  readonly clerkWebhookConfig: ClerkWebhookConfig;
  readonly clerkConfig: ClerkConfig;
  /** Required expected Clerk instance id: the read-through providerInstanceId (never browser-supplied). */
  readonly expectedInstanceId: string;
}

export interface ClerkIdentityRuntimeDeps {
  /** Inject a database client (e.g. in tests, or to share one pool); production creates its own. */
  readonly client?: DatabaseClient;
}

/**
 * A composed, server-only runtime shared by the webhook route and the authenticated read-through. Holds
 * one database client (pool). Callers should create it once (module singleton) and `close()` at shutdown.
 */
export interface ClerkIdentityRuntime {
  /** Neutral webhook service for the public Route Handler. */
  readonly webhook: IdentityWebhookService;
  /**
   * Resolve-or-reconcile the internal user for a SERVER-VERIFIED provider user id (from the P1-001
   * boundary). The provider instance id comes from configuration — never from the request/headers.
   */
  resolveInternalUser(providerUserId: string, options?: ReconcileOptions): Promise<InternalUserReconciliation>;
  /** Nightly drift reconciliation over all active mappings (forward-drift repair; non-destructive). */
  reconcile(options?: ReconcileAllOptions): Promise<ReconciliationSummary>;
  /** Close the owned database client (no-op when a client was injected). */
  close(): Promise<void>;
}

export function createClerkIdentityRuntime(config: ClerkIdentityRuntimeConfig, deps: ClerkIdentityRuntimeDeps = {}): ClerkIdentityRuntime {
  const ownsClient = deps.client === undefined;
  const client = deps.client ?? createDatabase(config.databaseConfig);
  const verifier = new ClerkIdentityWebhookVerifier({ config: config.clerkWebhookConfig });
  const reader = new ClerkAuthoritativeIdentityReader({ config: config.clerkConfig, expectedInstanceId: config.expectedInstanceId });
  const webhook = createIdentityWebhookService({ verifier, client });

  return {
    webhook,
    resolveInternalUser(providerUserId, options) {
      const key: ProviderIdentityKey = { provider: 'clerk', providerInstanceId: config.expectedInstanceId, providerUserId };
      return resolveOrReconcileInternalUser(client, reader, key, options);
    },
    reconcile(options) {
      return reconcileAllUsers(client, reader, options);
    },
    async close() {
      if (ownsClient) await closeDatabase(client);
    },
  };
}
