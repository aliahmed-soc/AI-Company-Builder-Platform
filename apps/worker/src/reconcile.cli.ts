// @acbp/worker — CLI entry for the nightly reconciliation command (ACBP-P1-002).
// `pnpm --filter @acbp/worker reconcile`. Runs one pass and exits with the returned code.
import { runReconcile } from './reconcile.js';

runReconcile()
  .then(({ code }) => process.exit(code))
  .catch(() => process.exit(1));
