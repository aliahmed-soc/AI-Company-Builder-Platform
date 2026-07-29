// @acbp/core/composition — research-document gateway output validation (ACBP-P5-006; CDR-061).
//
// The `validateOutput` the model gateway (P2-003) is configured with for research. It dispatches on the request's
// `outputSchemaRef` to `parseResearchShape` (deny-by-default); an unknown ref fails closed (`invalid_output`).
//
// IT VALIDATES SHAPE ONLY, AND THAT IS DELIBERATE. This hook receives `(schemaRef, rawOutput)` and nothing else, so
// it cannot know which URLs this run actually fetched — and the retrieved-source check (CDR-061 G6) is the central
// defence against invented and injected citations. Rather than leave that as a step a caller must remember, the
// shape pass returns a `ResearchDraft`, and only `certifyResearchDocument` mints a `ResearchDocument`. A draft
// cannot be persisted, so wiring this validator alone can never produce an uncertified artifact.
import { RESEARCH_DOCUMENT_SCHEMA, parseResearchShape } from '@acbp/contracts';
import type { OutputValidation } from '../model/model-gateway.js';

/** Route a research-document output to its SHAPE parser; unknown ref → fail closed. */
export function researchOutputValidator(schemaRef: string, output: string): OutputValidation {
  if (schemaRef !== RESEARCH_DOCUMENT_SCHEMA) return { ok: false };
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    // Unparseable output is `invalid_output`, which the gateway turns into a bounded re-ask and then a normalized
    // failure. Never a partial acceptance.
    return { ok: false };
  }
  const parsed = parseResearchShape(decoded);
  return parsed.ok ? { ok: true, value: parsed.draft } : { ok: false };
}
