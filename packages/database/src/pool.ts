// @acbp/database — map validated DatabaseConfig to a node-postgres pool config (ACBP-P0-018).
import type { DatabaseConfig } from '@acbp/config';
import type { PoolConfig } from 'pg';

/** SSL settings for standard Postgres (no provider-proprietary options). */
function sslOption(config: DatabaseConfig): PoolConfig['ssl'] {
  switch (config.ssl) {
    case 'disable':
      return false;
    case 'require':
      // Encrypt in transit without CA verification (managed provider terminates TLS).
      return { rejectUnauthorized: false };
    case 'verify-full':
      return { rejectUnauthorized: true };
  }
}

/**
 * Build the node-postgres PoolConfig. The credential-bearing connection string is read from the
 * Secret only here, at pool construction — it is never logged or otherwise revealed.
 */
export function toPoolConfig(config: DatabaseConfig): PoolConfig {
  return {
    connectionString: config.url.reveal(),
    min: config.poolMin,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    application_name: config.applicationName,
    ssl: sslOption(config),
  };
}
