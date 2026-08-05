// @acbp/contracts — the export manifest and its secret guard (ACBP-P7-001; CDR-078; EXPORT-001, NFR-014;
// ADR-016, ADR-002; trust-critical #2; invariant 19).
//
// ── WHY THIS FILE IS CAREFUL OUT OF PROPORTION TO ITS SIZE ───────────────────────────────────────────────────
//
// ADR-002 makes export the OWNERSHIP GUARANTEE — the answer to "what happens to my work if I leave". It fails in
// two directions that pull against each other:
//
//   * UNDER-delivering: canon's failure behaviour is not "fail" but "partial export enumerates missing". An
//     archive that quietly omits is worse than one that says what it could not include, because only the second
//     can be acted on.
//   * OVER-delivering: export is the one product path whose purpose is to move data OUT of the platform's
//     control, to a destination it will never see again. Every other control here can be tightened later; a
//     secret that leaves in an archive is gone.
//
// Pure and total: no clock, no I/O, no exceptions. The timestamp is a parameter, so a manifest is a function of
// its inputs and a test can assert one exactly.
import { containsSecret, redactSecrets, SECRET_PLACEHOLDER } from '../context/context.js';

/**
 * Why an item could not be included AT ALL. CLOSED, so a reader can switch exhaustively — free text would make
 * "why is this missing" unanswerable by anything but a human reading prose, and the manifest exists precisely so
 * a founder can act on the gap.
 *
 * THERE IS DELIBERATELY NO `contains_secret` REASON. A secret is REDACTED IN PLACE and counted, never a cause for
 * dropping the document around it — naming an omission reason for it would invite exactly that, losing the
 * founder's actual work over one span.
 *
 * EVERY MEMBER HAS A PRODUCER, and that is a rule rather than a coincidence (CDR-078 §6.5): `unreadable` from
 * {@link sanitizeExportValue}, `ownership_unverified` from the per-row ownership check, `truncated` from the
 * collection read bound. `unsupported_format` shipped in the first slice and never acquired one — artifact BYTES
 * are not copied by this ticket, so no stored format is ever rejected — and was removed rather than left as a
 * case a reader would wrongly believe can occur.
 */
export const EXPORT_OMISSION_REASONS = ['unreadable', 'ownership_unverified', 'truncated'] as const;
export type ExportOmissionReason = (typeof EXPORT_OMISSION_REASONS)[number];

export function isExportOmissionReason(value: unknown): value is ExportOmissionReason {
  return typeof value === 'string' && (EXPORT_OMISSION_REASONS as readonly string[]).includes(value);
}

/** One item that could not be included, named so the founder knows what is absent and why. */
export interface ExportOmission {
  readonly itemType: string;
  readonly itemId: string;
  readonly reason: ExportOmissionReason;
}

/**
 * One item that WAS included.
 *
 * `redactionCount` is `0` when the emitted bytes are identical to the source. Any higher number means the archive
 * differs from the product at that item, and saying so is the difference between a redaction and a silent edit.
 */
export interface ExportManifestItem {
  readonly itemType: string;
  readonly itemId: string;
  /** Path within the archive. */
  readonly path: string;
  /** Digest of the bytes ACTUALLY written, so the archive can be checked against its own inventory. */
  readonly sha256: string;
  /**
   * How many records this item actually carries.
   *
   * The acceptance criterion is "archive matches in-product data", and this is what makes that CHECKABLE per item
   * rather than only by reading every file: a founder (or a test) can compare it against the count in the product.
   * Derived from what was emitted, like every other number here — never from an intended total (§3-G5).
   */
  readonly rowCount: number;
  readonly redactionCount: number;
}

export interface ExportManifest {
  readonly accountId: string;
  readonly companyId: string;
  readonly generatedAt: string;
  readonly items: readonly ExportManifestItem[];
  readonly omissions: readonly ExportOmission[];
  readonly itemCount: number;
  readonly omissionCount: number;
  readonly redactionCount: number;
  /** Nothing was omitted. Says NOTHING about redactions — see {@link manifestIsFaithful}. */
  readonly complete: boolean;
}

/** The outcome of preparing one text field for an archive. */
export type SanitizedExportText =
  | { readonly status: 'included'; readonly text: string; readonly redactionCount: number }
  | { readonly status: 'excluded'; readonly reason: ExportOmissionReason };

/** How many blocklist spans `redactSecrets` replaced, counted by comparing placeholder occurrences. */
function countPlaceholders(text: string): number {
  let n = 0;
  let i = text.indexOf(SECRET_PLACEHOLDER);
  while (i !== -1) {
    n += 1;
    i = text.indexOf(SECRET_PLACEHOLDER, i + SECRET_PLACEHOLDER.length);
  }
  return n;
}

/**
 * Prepare one text field for an archive.
 *
 * SECRETS ARE REDACTED, NOT DROPPED. Acceptance asks for both "archive matches in-product data" and "zero
 * secrets", and when a founder has typed their own key into their own document those conflict.
 * `SECURITY-ARCHITECTURE` settles it — *"archives never contain secret values"* — so the value goes and the
 * surrounding document stays. Reuses ACBP-P2-007's blocklist rather than introducing a second detector: two
 * detectors eventually disagree, and the one that matters is whichever the export happens to call.
 *
 * ANYTHING UNSCANNABLE IS EXCLUDED (CDR-078 §3-G3.3). A non-string cannot be run through the blocklist, so it is
 * omitted and enumerated rather than trusted. The asymmetry is the whole point: a missing document is a
 * complaint, a leaked secret is unrecoverable.
 *
 * RE-RUNNABLE (canon's rollback posture): the placeholder contains no secret shape, so sanitizing an already
 * sanitized text is a no-op and reports zero new redactions rather than inflating the count.
 */
export function sanitizeExportText(text: string): SanitizedExportText {
  if (typeof text !== 'string') return { status: 'excluded', reason: 'unreadable' };
  if (!containsSecret(text)) return { status: 'included', text, redactionCount: 0 };
  // SUBTRACTS THE PLACEHOLDERS ALREADY PRESENT. Reached only by text that carries an earlier redaction AND still
  // holds a fresh secret — a partially-sanitized document being re-exported. Without the subtraction that case
  // reports the old placeholder as a new redaction, inflating the count a founder uses to judge how far the
  // archive departs from the product. ENFORCED BY: "counts only the NEWLY redacted spans when the text already
  // carries a placeholder"; the re-run case above cannot reach here, because clean text short-circuits above.
  const before = countPlaceholders(text);
  const redacted = redactSecrets(text);
  return { status: 'included', text: redacted, redactionCount: countPlaceholders(redacted) - before };
}

/** The outcome of preparing one arbitrary value — a whole row, or anything nested inside one — for an archive. */
export type SanitizedExportValue =
  | { readonly status: 'included'; readonly value: unknown; readonly redactionCount: number }
  | { readonly status: 'excluded'; readonly reason: ExportOmissionReason };

/**
 * How deep the walk will follow a structure before refusing.
 *
 * The walker's parameter is `unknown`, so a cycle or a pathological nesting must cost a REFUSAL, not the process.
 * Nothing this schema stores comes close: the deepest real JSON payload is a handful of levels.
 */
const MAX_VALUE_DEPTH = 32;

/**
 * Prepare an arbitrary value — typically a whole database row — for an archive (CDR-078 §6.2).
 *
 * `sanitizeExportText` handles one text field. A ROW IS NOT A TEXT FIELD: JSON columns nest, and a secret pasted
 * into `payload.notes[2]` is exactly as gone as one in a top-level column. So the walk is recursive over VALUES,
 * applying the blocklist to every string leaf at any depth.
 *
 * A LEAF THAT CANNOT BE REPRESENTED EXCLUDES THE WHOLE VALUE (§6-G4), rather than being quietly dropped from an
 * otherwise-included row. A row silently missing one field is a lie about that row; an enumerated omission is a
 * complaint the founder can act on. ENFORCED BY: "EXCLUDES THE WHOLE VALUE when any leaf cannot be represented".
 *
 * A SECRET IN A KEY ALSO EXCLUDES, rather than redacting. Two secret-shaped keys would both become the
 * placeholder and one would silently overwrite the other — data loss wearing redaction's clothes.
 * ENFORCED BY: "EXCLUDES rather than redacting when a secret sits in a KEY".
 */
export function sanitizeExportValue(value: unknown): SanitizedExportValue {
  let redactions = 0;
  /** Returns the sanitized value, or `FAILED` — a private sentinel, so `undefined` stays a refusable input. */
  const FAILED = Symbol('excluded');
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_VALUE_DEPTH) return FAILED;
    if (node === null) return null;
    const type = typeof node;
    if (type === 'string') {
      const r = sanitizeExportText(node as string);
      if (r.status !== 'included') return FAILED;
      redactions += r.redactionCount;
      return r.text;
    }
    if (type === 'boolean') return node;
    if (type === 'number') return Number.isFinite(node) ? node : FAILED;
    // `undefined`, functions, symbols and bigint have no faithful JSON form. Emitting `null` for them would say
    // "this field is empty" about a field that is not.
    if (type !== 'object') return FAILED;
    if (node instanceof Date) return Number.isNaN(node.getTime()) ? FAILED : node.toISOString();
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const item of node) {
        const walked = walk(item, depth + 1);
        if (walked === FAILED) return FAILED;
        out.push(walked);
      }
      return out;
    }
    // PLAIN objects only. A Map, Set, Buffer or class instance serialises to `{}` or something lossy, which would
    // put an empty object in the archive where the founder's data was.
    const proto: unknown = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return FAILED;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (containsSecret(key)) return FAILED;
      const walked = walk(child, depth + 1);
      if (walked === FAILED) return FAILED;
      out[key] = walked;
    }
    return out;
  };

  const result = walk(value, 0);
  if (result === FAILED) return { status: 'excluded', reason: 'unreadable' };
  return { status: 'included', value: result, redactionCount: redactions };
}

/**
 * Build the manifest from what was ACTUALLY emitted.
 *
 * THERE IS NO `expectedCount` PARAMETER, deliberately (CDR-078 §3-G5). A manifest that compared itself against an
 * intended total would be built from the query plan rather than the archive: it would agree with itself and
 * disagree with reality, which is CDR-073 §0's failure shape on a document the founder is meant to trust.
 *
 * AN EMPTY EXPORT IS COMPLETE. A company with nothing to export has had everything it owns exported; reporting
 * otherwise would tell a founder something went wrong when nothing did.
 */
export function buildExportManifest(input: {
  readonly accountId: string;
  readonly companyId: string;
  readonly generatedAt: string;
  readonly items: readonly ExportManifestItem[];
  readonly omissions: readonly ExportOmission[];
}): ExportManifest {
  return {
    accountId: input.accountId,
    companyId: input.companyId,
    generatedAt: input.generatedAt,
    items: input.items,
    omissions: input.omissions,
    itemCount: input.items.length,
    omissionCount: input.omissions.length,
    redactionCount: input.items.reduce((sum, i) => sum + i.redactionCount, 0),
    complete: input.omissions.length === 0,
  };
}

/**
 * Is this archive everything, EXACTLY as it was?
 *
 * `complete` answers "was anything left out"; this answers the stronger question a founder actually asks. A fully
 * complete archive can still differ from the product wherever a secret was removed, and collapsing the two would
 * let a redacted archive describe itself as an untouched copy.
 */
export function manifestIsFaithful(manifest: ExportManifest): boolean {
  return manifest.complete && manifest.redactionCount === 0;
}
