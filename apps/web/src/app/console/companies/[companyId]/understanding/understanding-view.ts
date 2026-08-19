/*
 * ACBP-FE-009 — turning the understanding read into a document a founder can actually check.
 *
 * AN ABSENT UNDERSTANDING IS A SUCCESS. The route answers 200 with `document: null` before the interview has
 * produced anything (the G9 rule), so `null` is the ordinary first-visit state and its copy carries no failure
 * vocabulary. Pinned by a test.
 *
 * ⚠️ `confirmed` AND `superseded` ARE TWO FACTS, AND THIS FILE IS WHERE COLLAPSING THEM WOULD DO THE DAMAGE.
 * `confirmed: false` is true both of a document nobody has confirmed and of one whose confirmation a correction
 * undid (DISC-008). The row's acceptance is "the UI shows a stale document as stale", so the two become
 * DIFFERENT states with different copy — `awaiting_confirmation` asks the founder to confirm, `superseded` tells
 * them their correction landed and re-opened the document. A test asserts the two states never share copy.
 *
 * ⚠️ THE ITEM CLASS ARRIVES AS `string`, NOT AS THE CLOSED UNION. `UnderstandingItemDTO.class` is typed `string`
 * in the DTO. The server already drops rows outside the closed set, but this view must not ASSUME that: it
 * groups by the imported `UNDERSTANDING_CLASSES` vocabulary and counts anything else as `unclassifiedItemCount`
 * rather than inventing a section for it or silently discarding it. Rendering an unknown class beside real ones
 * would misreport what the interview established; dropping it without saying so would hide that it happened.
 *
 * CONFIDENCE IS A LABELLED VALUE, NEVER A BARE COLOUR (the row's accessibility line). Every confidence in this
 * view arrives as a percentage AND a sentence naming what the number means, so a screen reading it aloud, or a
 * founder who cannot distinguish the palette, gets the same information as everyone else.
 */
import { SECTION_CONFIDENCE_THRESHOLD, SECTION_STATUSES, UNDERSTANDING_CLASSES, isUnderstandingClass, type SectionStatus, type UnderstandingClass } from '@acbp/contracts';

/**
 * Narrow a wire status to the closed set. Driven by the IMPORTED `SECTION_STATUSES` rather than a restated
 * literal union, so adding a status upstream cannot leave this screen silently rejecting it as unknown.
 * (`@acbp/contracts` exports no `isSectionStatus` today; if one lands, this should be deleted for it.)
 */
function isSectionStatus(value: string | undefined): value is SectionStatus {
  return value !== undefined && (SECTION_STATUSES as readonly string[]).includes(value);
}

/** The wire shape this screen consumes. Pinned to the route's real output by the contract-alignment suite. */
export interface UnderstandingItemWire {
  readonly class: string;
  readonly content: string;
  readonly confidence: number;
}
export interface UnderstandingSectionWire {
  readonly class: string;
  readonly count: number;
  readonly confidence: number;
  /**
   * ⚠️ `string`, NOT `SectionStatus`, BECAUSE THAT IS WHAT THE DTO ACTUALLY DECLARES. `UnderstandingSectionDTO`
   * widens both `class` and `status` to `string`, so narrowing them here would be this screen ASSERTING a
   * guarantee the type does not make. It is narrowed defensively below instead, exactly as `class` is.
   */
  readonly status: string;
}
export interface UnderstandingDocumentWire {
  readonly documentId: string;
  readonly version: number;
  readonly status: 'complete' | 'partial';
  readonly overallConfidence: number;
  readonly sections: readonly UnderstandingSectionWire[];
  readonly items: readonly UnderstandingItemWire[];
  readonly createdAt: string;
}

export type UnderstandingState = 'none' | 'awaiting_confirmation' | 'confirmed' | 'superseded';

export interface ItemView {
  readonly content: string;
  readonly confidencePercent: number;
  readonly confidenceLabel: string;
}

export interface SectionView {
  readonly class: UnderstandingClass;
  /** The founder-facing name. The wire value is a system vocabulary, not a label to print. */
  readonly label: string;
  readonly count: number;
  readonly status: SectionStatus;
  readonly confidencePercent: number;
  readonly confidenceLabel: string;
  /** True when the interview established nothing in this class — a GAP, shown rather than omitted. */
  readonly isGap: boolean;
  readonly items: readonly ItemView[];
}

export interface UnderstandingView {
  readonly state: UnderstandingState;
  readonly headline: string;
  /** One sentence naming what the founder can do next. Never empty, and never shared between two states. */
  readonly statusNote: string;
  readonly documentId: string | null;
  readonly version: number | null;
  readonly createdAt: string | null;
  readonly overallConfidencePercent: number;
  readonly overallConfidenceLabel: string;
  /** All six classes, in the CANONICAL order, gaps included. Transport order is an accident. */
  readonly sections: readonly SectionView[];
  readonly itemCount: number;
  /** Items whose class is outside the closed set. Never rendered as a section; never silently dropped. */
  readonly unclassifiedItemCount: number;
  /** The server marked the document incomplete — a separate fact from confidence being low. */
  readonly partial: boolean;
  /** Whether a confirm control should be offered AT ALL. The server still decides if it is allowed. */
  readonly canConfirm: boolean;
}

/** Founder-facing names for the closed class vocabulary. Keyed by the imported constant, so a new class breaks the build. */
const CLASS_LABELS: Readonly<Record<UnderstandingClass, string>> = {
  fact: 'Facts',
  preference: 'Preferences',
  constraint: 'Constraints',
  assumption: 'Assumptions',
  research_finding: 'Research findings',
  open_question: 'Open questions',
};

const EMPTY: UnderstandingView = {
  state: 'none',
  // NO FAILURE VOCABULARY — a first visit is not a fault.
  headline: 'The interview has not produced an understanding of this company yet.',
  statusNote: 'Answer the interview questions and an understanding document will be generated from them.',
  documentId: null,
  version: null,
  createdAt: null,
  overallConfidencePercent: 0,
  overallConfidenceLabel: 'No confidence to report yet.',
  sections: [],
  itemCount: 0,
  unclassifiedItemCount: 0,
  partial: false,
  canConfirm: false,
};

/** A percentage as an integer. Rounded once, here, so no two places round differently. */
function percent(confidence: number): number {
  return Math.round(confidence * 100);
}

/**
 * The sentence that accompanies every confidence number.
 *
 * The threshold is IMPORTED, not restated: `SECTION_CONFIDENCE_THRESHOLD` is what the server used to decide
 * `present` vs `assumed`, and a second copy here would eventually describe a different line than the one drawn.
 */
function confidenceLabel(confidence: number, noun: string): string {
  const pct = percent(confidence);
  const strength = confidence >= SECTION_CONFIDENCE_THRESHOLD ? 'well supported' : 'weakly supported';
  return `${String(pct)}% confidence — ${noun} is ${strength}.`;
}

function sectionConfidenceLabel(count: number, confidence: number): string {
  if (count === 0) return 'Nothing established here yet.';
  return confidenceLabel(confidence, 'this section');
}

function headlineFor(state: UnderstandingState, version: number, itemCount: number): string {
  const what = `Version ${String(version)} of what we understand, from ${String(itemCount)} ${itemCount === 1 ? 'item' : 'items'}.`;
  if (state === 'confirmed') return `${what} You have confirmed it.`;
  if (state === 'superseded') return `${what} Your correction has re-opened it.`;
  return `${what} It is waiting for your confirmation.`;
}

/**
 * The copy for each lifecycle state.
 *
 * `awaiting_confirmation` and `superseded` MUST NOT share a sentence. Both are `confirmed: false` on the wire,
 * and telling a founder who has just corrected the document to "review and confirm it" reads as though their
 * correction never registered. A test asserts the two strings differ.
 */
function statusNoteFor(state: UnderstandingState, partial: boolean): string {
  const partialWarning = partial ? ' The server marked this document partial — it is not everything that was said.' : '';
  switch (state) {
    case 'confirmed':
      return `This understanding is confirmed, so planning can proceed from it.${partialWarning}`;
    case 'superseded':
      return `You corrected this understanding after confirming it, so planning is blocked again until a new version is generated and confirmed.${partialWarning}`;
    case 'awaiting_confirmation':
      return `Planning stays blocked until you confirm this understanding is right.${partialWarning}`;
    case 'none':
      return EMPTY.statusNote;
  }
}

/** The lifecycle state, from the two flags the server sends — never derived one from the other. */
export function understandingStateOf(confirmed: boolean, superseded: boolean): Exclude<UnderstandingState, 'none'> {
  if (confirmed) return 'confirmed';
  return superseded ? 'superseded' : 'awaiting_confirmation';
}

export function toUnderstandingView(document: UnderstandingDocumentWire | null, confirmed: boolean, superseded: boolean): UnderstandingView {
  if (document === null) return EMPTY;

  const state = understandingStateOf(confirmed, superseded);

  // Group the items by class ONCE, using the imported vocabulary as the key set.
  const byClass = new Map<UnderstandingClass, UnderstandingItemWire[]>();
  let unclassified = 0;
  for (const item of document.items) {
    if (!isUnderstandingClass(item.class)) {
      unclassified += 1;
      continue;
    }
    const list = byClass.get(item.class) ?? [];
    list.push(item);
    byClass.set(item.class, list);
  }

  const sectionByClass = new Map(document.sections.filter((s) => isUnderstandingClass(s.class)).map((s) => [s.class as UnderstandingClass, s]));

  const sections: readonly SectionView[] = UNDERSTANDING_CLASSES.map((cls) => {
    const items = byClass.get(cls) ?? [];
    // The SERVER's rollup wins where it exists. Falling back to a locally-counted section only when the server
    // sent none keeps one definition of a section, with a visible default rather than a silent zero.
    const wire = sectionByClass.get(cls);
    const count = wire?.count ?? items.length;
    const confidence = wire?.confidence ?? 0;
    // A status outside the closed set falls back to `unknown` — the deny-by-default reading. Rendering an
    // unrecognised status verbatim would print a system token at a founder; assuming `present` would claim
    // the section is well supported on the strength of a value nothing validated.
    const status: SectionStatus = isSectionStatus(wire?.status) ? wire.status : 'unknown';
    return {
      class: cls,
      label: CLASS_LABELS[cls],
      count,
      status,
      confidencePercent: percent(confidence),
      confidenceLabel: sectionConfidenceLabel(count, confidence),
      isGap: count === 0,
      items: items.map((i) => ({
        content: i.content,
        confidencePercent: percent(i.confidence),
        confidenceLabel: confidenceLabel(i.confidence, 'this item'),
      })),
    };
  });

  const partial = document.status === 'partial';
  return {
    state,
    headline: headlineFor(state, document.version, document.items.length),
    statusNote: statusNoteFor(state, partial),
    documentId: document.documentId,
    version: document.version,
    createdAt: document.createdAt,
    overallConfidencePercent: percent(document.overallConfidence),
    overallConfidenceLabel: confidenceLabel(document.overallConfidence, 'this understanding'),
    sections,
    itemCount: document.items.length,
    unclassifiedItemCount: unclassified,
    partial,
    // Offered only where confirming is the next step. A confirmed document does not need re-confirming, and a
    // superseded one needs a NEW VERSION first — `confirmUnderstanding` refuses it as `stale_version`, so
    // offering the control there would be offering a button whose only outcome is an error.
    canConfirm: state === 'awaiting_confirmation',
  };
}
