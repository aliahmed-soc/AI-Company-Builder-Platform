// @acbp/contracts — understanding-generation contracts (ACBP-P2-008; CDR-029; UNDER-001/005).
//
// Provider-neutral shapes + PURE logic for the classified, versioned business-understanding document. The model
// returns classified items; the gateway validates via `parseUnderstanding` (deny-by-default). The document view —
// per-section confidence + status (present/assumed/unknown) + the weakest-section overall confidence (UNDER-005) —
// is computed here, never trusted from the model. Zero-dependency leaf: no provider SDK, no DB, no framework.

/** The CLOSED 6-class set the understanding document classifies items into (diagram 04 `gen`). Derived from the
 *  P2-006 memory types by provenance (UNDER-002) plus `open_question` for gaps — never set by content. */
export const UNDERSTANDING_CLASSES = ['fact', 'preference', 'constraint', 'assumption', 'research_finding', 'open_question'] as const;
export type UnderstandingClass = (typeof UNDERSTANDING_CLASSES)[number];
export function isUnderstandingClass(v: unknown): v is UnderstandingClass {
  return typeof v === 'string' && (UNDERSTANDING_CLASSES as readonly string[]).includes(v);
}

/** A section (class) is present (well-supported), assumed (weakly-supported), or unknown (a gap). */
export const SECTION_STATUSES = ['present', 'assumed', 'unknown'] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];

/** A generated document is complete, or partial when generation failed / returned a malformed payload. */
export const DOCUMENT_STATUSES = ['complete', 'partial'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Section-status threshold (CDR-029 §2): >= is present, < is assumed. */
export const SECTION_CONFIDENCE_THRESHOLD = 0.5;
/** Bounds (defense-in-depth against runaway output; also the DB column widths in migration 0019). */
export const UNDERSTANDING_CONTENT_MAX = 10_000;
export const MAX_UNDERSTANDING_ITEMS = 200;

/** The gateway output-schema ref for understanding generation (the composition dispatches validateOutput on it). */
export const UNDERSTANDING_SCHEMA = 'understanding.generate.output@1';

/** One classified understanding item (the model's output unit; `source_ref` is stamped by the core, not the model). */
export interface UnderstandingItemInput {
  readonly class: UnderstandingClass;
  readonly content: string;
  readonly confidence: number;
}

/** One section (class) rollup: item count, aggregate confidence, and derived status. */
export interface UnderstandingSection {
  readonly class: UnderstandingClass;
  readonly count: number;
  readonly confidence: number;
  readonly status: SectionStatus;
}

export type UnderstandingParse = { readonly ok: true; readonly value: { readonly items: readonly UnderstandingItemInput[]; readonly partial: boolean } } | { readonly ok: false };

const FAIL = { ok: false } as const;

function isFiniteInRange(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

/**
 * Parse the model's understanding output. Accepts `{items: [{class, content, confidence}]}` with 0..MAX items,
 * each a valid class, a non-blank bounded content, and a confidence in [0,1]. An empty list is valid (a document
 * with no derived items — every section unknown). Deny-by-default: any malformed element rejects the whole output.
 */
export function parseUnderstanding(raw: string): UnderstandingParse {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return FAIL;
  }
  if (typeof root !== 'object' || root === null) return FAIL;
  const list = (root as { items?: unknown }).items;
  if (!Array.isArray(list) || list.length > MAX_UNDERSTANDING_ITEMS) return FAIL;
  // Optional `partial` flag — the model signals it could not fully analyse (honest partial labeling, CDR-029 §3).
  // Absent → complete; any non-boolean present → reject (deny-by-default, no silent coercion).
  const rawPartial = (root as { partial?: unknown }).partial;
  if (rawPartial !== undefined && typeof rawPartial !== 'boolean') return FAIL;
  const partial = rawPartial === true;
  const items: UnderstandingItemInput[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) return FAIL;
    const cls = (raw as { class?: unknown }).class;
    const content = (raw as { content?: unknown }).content;
    const confidence = (raw as { confidence?: unknown }).confidence;
    if (!isUnderstandingClass(cls)) return FAIL;
    if (typeof content !== 'string' || content.trim().length === 0 || content.length > UNDERSTANDING_CONTENT_MAX) return FAIL;
    if (!isFiniteInRange(confidence, 0, 1)) return FAIL;
    items.push({ class: cls, content: content.trim(), confidence });
  }
  return { ok: true, value: { items, partial } };
}

/** Roll classified items up into one section per class: count, mean confidence, and derived status. */
export function computeSections(items: readonly UnderstandingItemInput[]): readonly UnderstandingSection[] {
  return UNDERSTANDING_CLASSES.map((cls) => {
    const own = items.filter((i) => i.class === cls);
    const count = own.length;
    const confidence = count === 0 ? 0 : own.reduce((s, i) => s + i.confidence, 0) / count;
    const status: SectionStatus = count === 0 ? 'unknown' : confidence >= SECTION_CONFIDENCE_THRESHOLD ? 'present' : 'assumed';
    return { class: cls, count, confidence, status };
  });
}

/** The overall document confidence = the WEAKEST covered (non-unknown) section (UNDER-005); 0 if all unknown. */
export function overallConfidence(sections: readonly UnderstandingSection[]): number {
  const covered = sections.filter((s) => s.status !== 'unknown');
  if (covered.length === 0) return 0;
  return Math.min(...covered.map((s) => s.confidence));
}
