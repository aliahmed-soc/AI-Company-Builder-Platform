// @acbp/database — migration/health CLI (ACBP-P0-018). Run via tsx (see root package.json scripts):
//   pnpm db:migrate | db:migrate:status | db:migrate:down | db:reset | db:check
// Reads validated config from the environment (loadDatabaseConfig). Never prints credentials.
import { loadDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, checkDatabaseHealth } from './client.js';
import { migrateToLatest, migrateDown, migrationStatus } from './migrator.js';
import type { MigrationResultSet } from 'kysely';

function reportResults(set: MigrationResultSet): boolean {
  for (const r of set.results ?? []) {
    console.log(`  ${r.status === 'Success' ? '✔' : r.status === 'Error' ? '✖' : '·'} ${r.direction} ${r.migrationName}`);
  }
  if (set.error) {
    const detail = set.error instanceof Error ? set.error.message : typeof set.error === 'string' ? set.error : 'unknown error';
    console.error(`migration failed: ${detail}`);
    return false;
  }
  return true;
}

async function run(command: string | undefined): Promise<number> {
  const config = loadDatabaseConfig();
  const client = createDatabase(config);
  try {
    switch (command) {
      case 'migrate': {
        console.log('Applying migrations (forward)…');
        return reportResults(await migrateToLatest(client)) ? 0 : 1;
      }
      case 'down': {
        console.log('Rolling back the most recent migration…');
        return reportResults(await migrateDown(client)) ? 0 : 1;
      }
      case 'status': {
        const migrations = await migrationStatus(client);
        for (const m of migrations) {
          console.log(`  ${m.executedAt ? 'applied ' : 'pending '} ${m.name}`);
        }
        return 0;
      }
      case 'check': {
        const health = await checkDatabaseHealth(client);
        console.log(JSON.stringify(health));
        return health.ok ? 0 : 1;
      }
      case 'reset': {
        // Destructive: local development only. Never allowed against staging/production.
        if (config.appEnv === 'production' || config.appEnv === 'staging') {
          console.error(`refusing to reset database in ${config.appEnv}`);
          return 2;
        }
        console.log('Resetting: rolling all migrations down…');
        for (;;) {
          const set = await migrateDown(client);
          if (!reportResults(set)) return 1;
          if (!set.results || set.results.length === 0) break;
        }
        console.log('Re-applying migrations…');
        return reportResults(await migrateToLatest(client)) ? 0 : 1;
      }
      default:
        console.error(`unknown command: ${command ?? '(none)'} — expected one of: migrate | down | status | check | reset`);
        return 2;
    }
  } finally {
    await closeDatabase(client);
  }
}

run(process.argv[2])
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
