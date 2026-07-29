// @acbp/core/composition — document generation gateway output validation (ACBP-P5-008; CDR-063).
//
// Dispatches on the request's `outputSchemaRef` to `parseDocumentOutput` (deny-by-default); an unknown ref fails
// closed. Like the comparison validator and unlike research's, this one is COMPLETE in a single pass: a document is
// judged on its own structure and provenance, with no per-run state this hook cannot see.
//
// It validates STRUCTURE only, not quality — deliberately. `assessDocumentQuality` runs in the use case and its
// verdict does not gate acceptance, because a document that fails the quality check is still persisted, labelled.
// Rejecting it here would discard exactly the draft WORK-004 says to keep.
import { DOCUMENT_SCHEMA, parseDocumentOutput } from '@acbp/contracts';
import type { OutputValidation } from '../model/model-gateway.js';

/** Route a document output to its structural parser; unknown ref → fail closed. */
export function documentOutputValidator(schemaRef: string, output: string): OutputValidation {
  if (schemaRef !== DOCUMENT_SCHEMA) return { ok: false };
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    return { ok: false };
  }
  const parsed = parseDocumentOutput(decoded);
  return parsed.ok ? { ok: true, value: parsed.document } : { ok: false };
}
