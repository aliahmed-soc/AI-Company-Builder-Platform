// @acbp/database — migration tooling (ACBP-P0-018; expand-migrate-contract discipline).
//
// Uses Kysely's Migrator + FileMigrationProvider. Discipline enforced/relied upon:
//  - Ordering: file name prefix (0001_, 0002_, …) — lexicographic = execution order.
//  - Immutability: applied migrations are recorded in `kysely_migration`; never edit an applied
//    file — add a new migration instead (see README "Migration immutability").
//  - Locking: the Migrator serializes concurrent runners via `kysely_migration_lock`, so parallel
//    deploys cannot double-apply.
//  - Failure: each migration runs in its own transaction; a failure rolls that migration back and
//    STOPS progression (no partial apply) — later migrations are not attempted.
//  - Re-run safety: only pending migrations are applied; re-running is a no-op.
//  - History: queryable via migrationStatus() (kysely_migration table).
import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { Migrator, FileMigrationProvider, type MigrationResultSet, type MigrationInfo } from 'kysely';
import type { DatabaseClient } from './client.js';

/** Absolute path to the committed migrations directory (packages/database/migrations). */
export const MIGRATIONS_DIR = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Build a Migrator for the given client (folder overridable for tests/fixtures). */
export function createMigrator(client: DatabaseClient, migrationFolder: string = MIGRATIONS_DIR): Migrator {
  return new Migrator({
    db: client.kysely,
    provider: new FileMigrationProvider({ fs, path: nodePath, migrationFolder }),
  });
}

/** Apply all pending migrations (forward). Returns the Kysely result set (error + results). */
export async function migrateToLatest(client: DatabaseClient, migrationFolder?: string): Promise<MigrationResultSet> {
  return createMigrator(client, migrationFolder).migrateToLatest();
}

/** Roll back the most recent migration (reversible-one-release policy). */
export async function migrateDown(client: DatabaseClient, migrationFolder?: string): Promise<MigrationResultSet> {
  return createMigrator(client, migrationFolder).migrateDown();
}

/** Queryable migration history + pending list. */
export async function migrationStatus(client: DatabaseClient, migrationFolder?: string): Promise<readonly MigrationInfo[]> {
  return createMigrator(client, migrationFolder).getMigrations();
}
