// ACBP-P0-020 — CI database preflight guard.
//
// In CI (CI=true) the PostgreSQL integration tests must NOT silently skip: they skip locally only
// because ACBP_TEST_DATABASE_URL is unset. This guard fails the run (non-zero) when CI=true and that
// URL is absent or malformed, BEFORE the aggregate gate runs. Locally (CI unset) it is a no-op, so
// the documented no-database workflow is unchanged. The URL value is never printed.
import { validateDbUrl } from '../local/lib.mjs';

const isCI = process.env.CI === 'true';
const url = process.env.ACBP_TEST_DATABASE_URL;

if (!isCI) {
  console.log('preflight: CI!=true — local mode; CI database guard not applied.');
  process.exit(0);
}

const v = validateDbUrl(url);
if (!v.ok) {
  console.error(`preflight: FAIL — CI requires a valid ACBP_TEST_DATABASE_URL so integration tests cannot skip (reason: ${v.reason}; value not shown).`);
  process.exit(1);
}
console.log(`preflight: OK — CI database configuration present and valid (${v.scheme}://<redacted>/${v.database}).`);
process.exit(0);
