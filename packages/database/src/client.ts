// @acbp/database — connection lifecycle: create / close / health (ACBP-P0-018; ADR-020, ADR-017).
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { DatabaseConfig } from '@acbp/config';
import { createLogger, createRootContext, type Logger } from '@acbp/observability';
import { validationError, type PublicErrorEnvelope } from '@acbp/contracts';
import { toDatabaseError } from './errors.js';
import { toPoolConfig } from './pool.js';
import type { DatabaseSchema } from './schema.js';

/**
 * A live database handle. `inTransaction` is `false` here and `true` on the executor passed to a
 * transaction callback; {@link withTransaction} uses it to reject accidental nesting.
 */
export interface DatabaseClient {
  readonly kysely: Kysely<DatabaseSchema>;
  readonly pool: Pool;
  readonly config: DatabaseConfig;
  readonly logger: Logger;
  readonly inTransaction: false;
}

/** Injection seams for tests (fake kysely/pool/logger) — production passes none. */
export interface CreateDatabaseDeps {
  readonly logger?: Logger;
  readonly pool?: Pool;
  readonly kysely?: Kysely<DatabaseSchema>;
}

/** Structured, credential-free per-call diagnostics options. */
export interface DbCallOptions {
  readonly logger?: Logger;
  readonly correlationId?: string;
}

function defaultLogger(): Logger {
  return createLogger({ component: 'database', context: createRootContext() });
}

/**
 * Build a database client. Validates configuration and FAILS FAST (before any connection attempt) on
 * invalid input. node-postgres connects lazily, so constructing a client performs no I/O.
 */
export function createDatabase(config: DatabaseConfig, deps: CreateDatabaseDeps = {}): DatabaseClient {
  const revealFn = (config as { url?: { reveal?: unknown } } | null)?.url?.reveal;
  if (typeof revealFn !== 'function') {
    throw validationError({ message: 'Invalid database configuration.', internalMessage: 'DatabaseConfig.url (Secret) is required', fields: ['url'] });
  }
  const pool = deps.pool ?? new Pool(toPoolConfig(config));
  const kysely = deps.kysely ?? new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const logger = deps.logger ?? defaultLogger();
  return { kysely, pool, config, logger, inTransaction: false };
}

/** Close the pool and release all connections cleanly. Safe to call once at shutdown. */
export async function closeDatabase(client: DatabaseClient): Promise<void> {
  // Kysely.destroy() ends the underlying pg Pool.
  await client.kysely.destroy();
}

export interface DatabaseHealth {
  readonly ok: boolean;
  readonly latencyMs?: number;
  /** Safe, redacted envelope when unhealthy (never contains SQL, params, or credentials). */
  readonly error?: PublicErrorEnvelope;
}

/**
 * Liveness probe: `SELECT 1`. NEVER throws — returns a structured result so callers (health
 * endpoints, startup gates) can branch safely. On failure the error is normalized + redacted.
 */
export async function checkDatabaseHealth(client: DatabaseClient, options: DbCallOptions = {}): Promise<DatabaseHealth> {
  const log = options.logger ?? client.logger;
  const start = Date.now();
  try {
    await sql`select 1 as ok`.execute(client.kysely);
    const latencyMs = Date.now() - start;
    log.debug('db.health.ok', { metadata: { latencyMs } });
    return { ok: true, latencyMs };
  } catch (e) {
    const err = toDatabaseError(e, { operation: 'health_check', ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}) });
    log.error('db.health.failed', { error: err });
    return { ok: false, error: err.toPublic() };
  }
}
