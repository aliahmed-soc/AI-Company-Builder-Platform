// @acbp/core/composition — business-model comparison gateway output validation (ACBP-P5-007; CDR-062).
//
// The `validateOutput` the model gateway (P2-003) is configured with for the strategy worker. It dispatches on the
// request's `outputSchemaRef` to `parseComparisonOutput` (deny-by-default); an unknown ref fails closed.
//
// UNLIKE RESEARCH, this validator is COMPLETE. Research had to be split into a shape pass and a certifying pass
// because the retrieved-source check needs per-run state this hook cannot see. A comparison is judged entirely on
// itself — two or more distinct models, sixteen fields each, or a request that names what it needs — so there is no
// second half a caller could forget, and no draft type is required to stop them.
import { COMPARISON_SCHEMA, parseComparisonOutput } from '@acbp/contracts';
import type { OutputValidation } from '../model/model-gateway.js';

/** Route a comparison output to its parser; unknown ref → fail closed. */
export function comparisonOutputValidator(schemaRef: string, output: string): OutputValidation {
  if (schemaRef !== COMPARISON_SCHEMA) return { ok: false };
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    return { ok: false };
  }
  const parsed = parseComparisonOutput(decoded);
  return parsed.ok ? { ok: true, value: parsed.outcome } : { ok: false };
}
