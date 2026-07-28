// @acbp/contracts — the document worker's output contract (ACBP-P5-008; CDR-063; WORK-004). Zero-dep, PURE.
//
// This worker fails DIFFERENTLY from the other two, and the difference is the design. Research refuses rather than
// store an invented citation; strategy asks rather than pad a comparison. The document worker's failure clause is
// **"Quality-check fail = draft marked needs-revision"** — it KEEPS its output, because a half-finished business plan
// is *editable* (the acceptance criterion's own word) and discarding it throws away work the founder can use.
//
// What would be wrong is presenting it as finished. So everything here serves one rule: **the draft must admit that
// it is a draft, in the bytes a founder actually reads.** A status living only in a database column is the hollow
// success wearing different clothes — the founder opens the document, sees no warning, and treats it as done.

/** The three document types canon names for this worker, all present in the closed `TASK_TYPES` set. */
export const DOCUMENT_TYPES = ['business_plan_generation', 'landing_page_copy', 'internal_product_requirements'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

/** The gateway output-schema ref for a structured document. */
export const DOCUMENT_SCHEMA = 'document.generate.output@1';

export const MAX_DOCUMENT_SECTIONS = 40;
export const MAX_HEADING_LENGTH = 200;
export const MAX_SECTION_BODY = 20_000;
export const MAX_CONTEXT_REFS = 50;

/** One editable unit. A heading plus a body, so a founder can revise one part without rewriting the document. */
export interface DocumentSection {
  readonly heading: string;
  readonly body: string;
}

/**
 * A structured document with provenance (`AI-AND-WORKER-ARCHITECTURE.md:39`).
 *
 * `contextRefs` are the approved inputs it was built from — the understanding version, a decision, research
 * artifacts. Required, not optional: a document citing nothing is a build with no inputs.
 */
export interface StructuredDocument {
  readonly documentType: DocumentType;
  readonly title: string;
  readonly contextRefs: readonly string[];
  readonly sections: readonly DocumentSection[];
}

export type DocumentRefusal =
  | 'unknown_shape'
  | 'unknown_document_type'
  | 'invalid_title'
  | 'no_sections'
  | 'too_many_sections'
  | 'invalid_section'
  | 'duplicate_heading'
  | 'no_provenance'
  | 'invalid_provenance';

export type DocumentParse = { readonly ok: true; readonly document: StructuredDocument } | { readonly ok: false; readonly reason: DocumentRefusal; readonly index: number | null };

/**
 * Derived by {@link assessDocumentQuality}, never supplied by the model — one that could set it would always say
 * `complete`.
 *
 * Named `DocumentQualityStatus`, not `DocumentStatus`: the understanding module already exports the latter for an
 * unrelated thing (the lifecycle of an understanding document), and one barrel cannot carry two. The longer name is
 * the more accurate one anyway — this is a verdict about the writing, not a position in a lifecycle.
 */
export type DocumentQualityStatus = 'complete' | 'needs_revision';

export interface DocumentAssessment {
  readonly status: DocumentQualityStatus;
  /** The headings of every section that failed. Every one, so the founder knows where to look. */
  readonly failingSections: readonly string[];
}

function present(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

const fail = (reason: DocumentRefusal, index: number | null): { ok: false; reason: DocumentRefusal; index: number | null } => ({ ok: false, reason, index });

/**
 * Parse a document-worker output.
 *
 * A BLANK SECTION BODY PARSES. That is the distinction this worker turns on: an empty section is something a founder
 * can see and fill in, so it flows to the quality check and gets labelled, rather than being refused at the door and
 * costing them the rest of the document. Structure is refused; emptiness is reported.
 */
export function parseDocumentOutput(output: unknown): DocumentParse {
  if (typeof output !== 'object' || output === null) return fail('unknown_shape', null);
  const candidate = output as { documentType?: unknown; title?: unknown; contextRefs?: unknown; sections?: unknown };

  if (!isDocumentType(candidate.documentType)) return fail('unknown_document_type', null);
  if (!present(candidate.title, MAX_HEADING_LENGTH)) return fail('invalid_title', null);

  // G5 — provenance first, because a document with no inputs is not a draft of anything.
  if (!Array.isArray(candidate.contextRefs)) return fail('no_provenance', null);
  const rawRefs = candidate.contextRefs as readonly unknown[];
  if (rawRefs.length === 0) return fail('no_provenance', null);
  if (rawRefs.length > MAX_CONTEXT_REFS) return fail('invalid_provenance', null);
  const seenRefs = new Set<string>();
  const contextRefs: string[] = [];
  for (const ref of rawRefs) {
    if (!present(ref, MAX_HEADING_LENGTH)) return fail('invalid_provenance', null);
    if (seenRefs.has(ref)) return fail('invalid_provenance', null);
    seenRefs.add(ref);
    contextRefs.push(ref);
  }

  if (!Array.isArray(candidate.sections)) return fail('unknown_shape', null);
  const rawSections = candidate.sections as readonly unknown[];
  if (rawSections.length === 0) return fail('no_sections', null);
  if (rawSections.length > MAX_DOCUMENT_SECTIONS) return fail('too_many_sections', null);

  const sections: DocumentSection[] = [];
  const seenHeadings = new Set<string>();
  for (const [index, entry] of rawSections.entries()) {
    if (typeof entry !== 'object' || entry === null) return fail('invalid_section', index);
    const s = entry as { heading?: unknown; body?: unknown };
    // The HEADING is structural — an unlabelled block cannot be revised in isolation, which defeats "editable".
    if (!present(s.heading, MAX_HEADING_LENGTH)) return fail('invalid_section', index);
    // AND IT MUST BE UNIQUE. Review pass 2: two sections sharing a heading make section-level revision ambiguous —
    // P5-012 has to address a section by something, and "the one called Market" stops identifying anything. It also
    // makes the needs-revision warning ambiguous, since that names failing sections by heading.
    const key = s.heading.trim().toLowerCase();
    if (seenHeadings.has(key)) return fail('duplicate_heading', index);
    seenHeadings.add(key);
    if (typeof s.body !== 'string' || s.body.length > MAX_SECTION_BODY) return fail('invalid_section', index);
    sections.push({ heading: s.heading, body: s.body });
  }

  return { ok: true, document: { documentType: candidate.documentType, title: candidate.title, contextRefs, sections } };
}

/**
 * Placeholder bodies — a model declining to write while appearing to have written.
 *
 * MATCHED AGAINST THE WHOLE TRIMMED BODY, never as a substring. "Our todo list for launch is short" is written
 * content; flagging it would train founders to ignore the warning, which is worse than not having one.
 */
const PLACEHOLDER_BODIES: readonly string[] = ['tbd', 'todo', 'to be determined', 'to be completed', 'n/a', 'na', 'none', 'unknown', 'placeholder', 'lorem ipsum', 'xxx', '...', '-', '?'];

// `unknown` IS in that list, and that is a deliberate difference from the strategy worker, where `unknown` is the
// ADR-019 sentinel meaning "honestly undetermined" and must be ACCEPTED. The two are not in conflict: there, it is a
// declared value for a named field in a structured comparison; here, it is the entire body of a prose section, which
// is a section nobody wrote. Same word, different unit — worth stating because a future reader will notice the
// apparent contradiction.

/**
 * `[insert market size]`, `<describe the offer>`, `{{value}}` — a template slot left unfilled.
 *
 * REPEATED brackets on both ends, which is what makes the mustache form match. Review pass 1 found the first version
 * — `^[[<{(][^\]>})]*[\]>})]$` — did NOT match `{{value}}`: the opener consumed one `{`, the body ran to the first
 * `}`, and the trailing `}` had nothing left to match. The comment listed `{{value}}` as an example the whole time,
 * which is a claim in a doc comment the code did not keep.
 */
const UNFILLED_SLOT = /^[[<{(]+[^\]>})]*[\]>})]+$/;

/** A body counts as written if it is neither empty, nor a bare placeholder, nor an unfilled slot. */
function isWritten(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed === '') return false;
  const normalized = trimmed.toLowerCase();
  if (PLACEHOLDER_BODIES.includes(normalized)) return false;
  if (normalized.startsWith('lorem ipsum')) return false;
  if (UNFILLED_SLOT.test(trimmed)) return false;
  return true;
}

/**
 * Derive the document's status (G1, G4).
 *
 * THE CHECK IS ABOUT EMPTINESS, NOT QUALITY. Judging whether prose is *good* is not something this can honestly do;
 * detecting that nothing was said is. So it looks for sections that are blank, bare placeholders, or unfilled
 * template slots — each one a section the model did not actually write.
 *
 * EVERY failing section is named. A warning that says "some sections need work" sends the founder hunting.
 */
export function assessDocumentQuality(document: StructuredDocument): DocumentAssessment {
  const failingSections = document.sections.filter((s) => !isWritten(s.body)).map((s) => s.heading);
  return { status: failingSections.length === 0 ? 'complete' : 'needs_revision', failingSections };
}

/**
 * Render the document as markdown — the artifact's bytes.
 *
 * THE WARNING GOES FIRST (G2), above the first section heading, naming every section that failed. Appending it as a
 * footnote would satisfy the letter of "marked needs-revision" while losing its entire point: a founder skims from
 * the top, and a draft that looks finished for its first two pages has already misled them.
 *
 * A COMPLETE document carries no warning at all, because a label that appears on everything means nothing.
 */
export function renderDocumentMarkdown(document: StructuredDocument, assessment: DocumentAssessment): string {
  const lines: string[] = [`# ${document.title}`, ''];

  if (assessment.status === 'needs_revision') {
    lines.push(
      '> **⚠️ NEEDS REVISION — this is a draft, not a finished document.**',
      '>',
      `> The following sections were left empty or unwritten and need your attention: ${assessment.failingSections.join(', ')}.`,
      '',
    );
  }

  for (const section of document.sections) {
    lines.push(`## ${section.heading}`, '', section.body.trim() === '' ? '_(empty — needs writing)_' : section.body, '');
  }

  // Provenance last but always present: a document "with provenance" that nobody can see has none.
  lines.push('---', '', '**Built from:**', ...document.contextRefs.map((ref) => `- ${ref}`), '');
  return `${lines.join('\n')}\n`;
}
