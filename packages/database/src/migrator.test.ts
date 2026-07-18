// ACBP-P0-018 — regression: the migration provider must import migration files via a file:// URL.
// Kysely's built-in FileMigrationProvider imports a raw path, which Node's ESM loader rejects on
// Windows (a drive-letter path like `E:\...` is read as URL scheme "e:", raising
// ERR_UNSUPPORTED_ESM_URL_SCHEME). This test loads the committed migrations through our provider and
// would fail on Windows if the raw-path import ever came back. No database required.
import { describe, test, expect } from 'vitest';
import { createFileMigrationProvider, MIGRATIONS_DIR } from './index.js';

describe('createFileMigrationProvider (Windows-safe ESM import)', () => {
  test('loads committed migrations without an ESM URL-scheme error', async () => {
    const provider = createFileMigrationProvider(MIGRATIONS_DIR);
    const migrations = await provider.getMigrations();
    expect(Object.keys(migrations)).toContain('0001_platform_init');
    expect(typeof migrations['0001_platform_init']?.up).toBe('function');
    expect(typeof migrations['0001_platform_init']?.down).toBe('function');
  });
});
