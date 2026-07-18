// @acbp/database — migration tooling (ACBP-P0-018; expand-migrate-contract discipline).
//
// Uses Kysely's Migrator with a Windows-safe file provider. Discipline enforced/relied upon:
//  - Ordering: file name prefix (0001_, 0002_, …) — lexicographic = execution order.
//  - Immutability: applied migrations are recorded in `kysely_migration`; never edit an applied
//    file — add a new migration instead (see README "Migration immutability").
//  - Locking: the Migrator serializes concurrent runners via `kysely_migration_lock`, so parallel
//    deploys cannot double-apply.
//  - Failure: PostgreSQL has transactional DDL, so Kysely runs the batch in a transaction — a
//    failure rolls the batch back and STOPS progression (no partial apply).
//  - Re-run safety: only pending migrations are applied; re-running is a no-op.
//  - History: queryable via migrationStatus() (kysely_migration table).
//
// Why not Kysely's built-in FileMigrationProvider: it imports migration files via a raw path, which
// Node's ESM loader rejects on Windows (a drive-letter path like `E:\...` is read as URL scheme
// "e:", raising ERR_UNSUPPORTED_ESM_URL_SCHEME). We import via a file:// URL (pathToFileURL) so it
// works on Windows, Linux, and macOS. Semantics otherwise match FileMigrationProvider.
import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Migrator } from 'kysely';
import type { Migration, MigrationProvider, MigrationResultSet, MigrationInfo } from 'kysely';
import type { DatabaseClient } from './client.js';

/** Absolute path to the committed migrations directory (packages/database/migrations). */
export const MIGRATIONS_DIR = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const MIGRATION_FILE_RE = /\.(ts|mts|js|mjs)$/;

/**
 * Windows-safe file migration provider. Reads migration files from a folder and imports each via a
 * file:// URL so ESM import works on all platforms (including Windows drive-letter paths).
 */
export function createFileMigrationProvider(migrationFolder: string = MIGRATIONS_DIR): MigrationProvider {
  return {
    async getMigrations(): Promise<Record<string, Migration>> {
      const migrations: Record<string, Migration> = {};
      const files = await fs.readdir(migrationFolder);
      for (const fileName of files.sort()) {
        if (!MIGRATION_FILE_RE.test(fileName) || fileName.endsWith('.d.ts')) continue;
        const href = pathToFileURL(nodePath.join(migrationFolder, fileName)).href;
        const imported = (await import(href)) as { default?: Migration } & Partial<Migration>;
        const candidate: Partial<Migration> = imported.default ?? imported;
        if (typeof candidate.up === 'function') {
          migrations[fileName.substring(0, fileName.lastIndexOf('.'))] = candidate as Migration;
        }
      }
      return migrations;
    },
  };
}

/** Build a Migrator for the given client (folder overridable for tests/fixtures). */
export function createMigrator(client: DatabaseClient, migrationFolder: string = MIGRATIONS_DIR): Migrator {
  return new Migrator({
    db: client.kysely,
    provider: createFileMigrationProvider(migrationFolder),
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
