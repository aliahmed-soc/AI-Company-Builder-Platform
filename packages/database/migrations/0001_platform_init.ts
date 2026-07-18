// ACBP-P0-018 — minimal TECHNICAL migration proving the migration mechanism end to end.
//
// It creates and (on down) drops a single NON-DOMAIN probe table. It contains NO account, user,
// company, task, approval, usage, audit, model, or any other product-domain table or column — those
// are introduced by their own tickets. Its only purpose is to demonstrate that up/down apply
// cleanly, re-runs are safe, and history is recorded (BACKLOG.csv ACBP-P0-018 acceptance:
// "Migrations up/down clean").
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('_acbp_migration_probe')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .addColumn('applied_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('_acbp_migration_probe').execute();
}
