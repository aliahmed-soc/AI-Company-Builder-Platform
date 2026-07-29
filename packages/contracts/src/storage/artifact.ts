// @acbp/contracts — the artifact contract (ACBP-P5-011; CDR-060; TASK-005; NFR-014; trust-critical #2).
// Zero-dep and PURE. Builds on P0-005's key derivation rather than duplicating it: there is exactly one place that
// turns a company id into a prefix, because two of them could disagree about where a tenant boundary is.
//
// TASK-005's failure clause is *"persist failure = task fails (no hollow success)"*. A hollow success is not usually
// a dramatic failure — it is something optional that was missing and nobody noticed. So everything here that could
// plausibly be optional is REQUIRED, and the refusals are typed rather than thrown.
import { companyObjectKey, type ObjectKeyResult } from './object-key.js';

/**
 * The formats an artifact may be stored in — the objective's *"open formats"*.
 *
 * CLOSED and deliberately small. A founder must be able to read, diff, export and re-import their own work without
 * this platform, which rules out anything proprietary; and every MVP worker produces prose or structured data, so
 * three formats cover all of them. A PDF is a rendering of an artifact, not an artifact.
 */
export const ARTIFACT_FORMATS = ['markdown', 'json', 'text'] as const;
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];

export function isArtifactFormat(value: unknown): value is ArtifactFormat {
  return typeof value === 'string' && (ARTIFACT_FORMATS as readonly string[]).includes(value);
}

/**
 * The format list AS WRITTEN IN THE DATABASE, transcribed from `0043_artifacts.ts`'s `artifacts_format_valid` CHECK.
 *
 * Two places hold this list and they can silently disagree. Widening {@link ARTIFACT_FORMATS} without a migration
 * widening the CHECK does not fail at build time or in any unit test — it fails at the first INSERT of the new
 * format, in production, as a constraint violation from a code path that believed it was doing something legal.
 *
 * Found in review pass 2 of ACBP-P5-011, because the identical trap had already been walked into once: ACBP-P5-013
 * widened `ACTIVITY_TYPES` with no matching migration, arming a fail-closed projector to roll back the very
 * transition it was meant to record. Same shape, different list.
 */
export const ARTIFACT_FORMATS_IN_DATABASE_CHECK: readonly string[] = ['markdown', 'json', 'text'];

/**
 * Do the contract's formats and the database's CHECK still agree? Asserted by a test, so widening one without the
 * other is a RED BUILD rather than a production constraint violation.
 */
export function artifactFormatsMatchDatabase(): boolean {
  const contract = [...ARTIFACT_FORMATS].sort();
  const database = [...ARTIFACT_FORMATS_IN_DATABASE_CHECK].sort();
  return contract.length === database.length && contract.every((f, i) => f === database[i]);
}

/**
 * The per-artifact size cap — IOQ-11, recorded in `CDR-060 §3`.
 *
 * 8 MiB. MVP artifacts are generated documents in open text formats; 8 MiB of markdown is roughly a million words,
 * which nothing this system produces approaches. The cap exists so a runaway generation fails loudly instead of
 * quietly filling a bucket — not to constrain legitimate output.
 *
 * INTERIM, not owner-ratified — the same standing as IOQ-12's budgets in `CDR-056 §3`.
 */
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** A sha256 digest, lowercase hex. Shape only: `@acbp/contracts` is zero-dep and has no crypto to verify it with. */
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
export function isContentHash(value: unknown): value is string {
  return typeof value === 'string' && CONTENT_HASH_RE.test(value);
}

/**
 * Where an artifact came from (TASK-005; CDR-060 G6).
 *
 * EVERY FIELD IS REQUIRED. An artifact whose origin is unknown cannot be trusted, corrected or revised: P5-012's
 * revision workflow has to know what produced the thing it is revising, and a founder disputing a claim has to know
 * which run to re-run. "Unknown provenance" is not a state this system should be able to represent.
 */
export interface ArtifactProvenance {
  readonly runId: string;
  readonly workerId: string;
  readonly workerVersion: number;
  readonly modelVersion: string;
}

export interface ArtifactInput {
  readonly companyId: string;
  readonly format: unknown;
  readonly sizeBytes: unknown;
  readonly contentHash: unknown;
  readonly provenance: ArtifactProvenance | undefined;
}

export type ArtifactRefusal = 'unsupported_format' | 'too_large' | 'invalid_size' | 'invalid_content_hash' | 'incomplete_provenance';
export type ArtifactValidation = { readonly ok: true } | { readonly ok: false; readonly reason: ArtifactRefusal };

/** A required string field: present, a string, and not just whitespace. Blank is as absent as missing. */
function present(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * May this artifact be persisted?
 *
 * TOTAL and TYPED. Every refusal names its reason, because the caller's job on a refusal is to fail the task with an
 * honest category (TASK-006) rather than to retry blindly or — worse — to record a success.
 *
 * A ZERO-BYTE ARTIFACT IS REFUSED. It is the hollow success in miniature: a row telling a founder their research is
 * saved, pointing at nothing.
 */
export function validateArtifact(input: ArtifactInput): ArtifactValidation {
  if (!isArtifactFormat(input?.format)) return { ok: false, reason: 'unsupported_format' };

  const size = input.sizeBytes;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return { ok: false, reason: 'invalid_size' };
  if (size > MAX_ARTIFACT_BYTES) return { ok: false, reason: 'too_large' };

  if (!isContentHash(input.contentHash)) return { ok: false, reason: 'invalid_content_hash' };

  const p = input.provenance;
  if (p === undefined || p === null) return { ok: false, reason: 'incomplete_provenance' };
  if (!present(p.runId) || !present(p.workerId) || !present(p.modelVersion)) return { ok: false, reason: 'incomplete_provenance' };
  if (typeof p.workerVersion !== 'number' || !Number.isInteger(p.workerVersion) || p.workerVersion < 1) {
    return { ok: false, reason: 'incomplete_provenance' };
  }

  return { ok: true };
}

/**
 * The object key for an artifact: company-prefixed and CONTENT-ADDRESSED.
 *
 * CONTENT-ADDRESSED WITHIN A COMPANY, never across one. The same bytes in one company always produce the same key —
 * which is what makes a re-write idempotent and a retry safe (`FAILURE-AND-RECOVERY` row 7). The same bytes in a
 * DIFFERENT company produce a different key, because a globally content-addressed store would make two companies
 * share an object, and one company's read would be a read of the other's write. Deduplication is not worth a tenant
 * boundary.
 *
 * REFUSES rather than sanitises, inheriting `companyObjectKey`'s discipline: quietly rewriting a traversal attempt
 * into something adjacent hides the attempt.
 */
export function artifactObjectKey(companyId: string, contentHash: string, format: ArtifactFormat): ObjectKeyResult {
  return companyObjectKey(companyId, ['artifacts', contentHash, `content.${format === 'markdown' ? 'md' : format === 'json' ? 'json' : 'txt'}`]);
}
