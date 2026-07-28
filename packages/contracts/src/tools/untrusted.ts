// @acbp/contracts — the injection boundary (ACBP-P5-003c; CDR-055; NFR-021; invariant 17; trust-critical #17).
// Zero-dep and PURE.
//
// THE BOUNDARY IS PROVENANCE, NOT DETECTION. `AI-AND-WORKER-ARCHITECTURE §4`'s hard rule is that tool calls originate
// exclusively from worker control flow — "never from instructions parsed out of processed content" — and that a call
// proposed while processing untrusted content faces *heightened policy scrutiny*.
//
// So what stops an injection is that the CONTEXT was untrusted, not that a detector recognised the text. A corpus
// entry no signal here matches still cannot cause a tool call. `detectInjection` exists for the second half of
// NFR-021 — quarantine and flagging — and is deliberately shaped so it cannot be mistaken for the first half.

/** CLOSED. Canon's own content classes (`AI-AND-WORKER-ARCHITECTURE §4`). */
export const CONTENT_TRUST = ['trusted_user_input', 'untrusted_external', 'semi_trusted_generated', 'tool_output'] as const;
export type ContentTrust = (typeof CONTENT_TRUST)[number];

export function isContentTrust(value: unknown): value is ContentTrust {
  return typeof value === 'string' && (CONTENT_TRUST as readonly string[]).includes(value);
}

/**
 * The ONLY class treated as trustworthy input. Everything else — including anything unrecognised — is untrusted.
 *
 * `tool_output` IS NOT HERE, and that is the whole point (review pass 2). An earlier version listed it, which opened a
 * laundering path: a `web_research` tool fetches a page, its output goes into the context labelled `tool_output`, the
 * label reads as trusted, and the injected instructions are back inside the boundary they were supposed to be outside
 * of. Canon never called tool output trusted — `AI-AND-WORKER-ARCHITECTURE §4` says **"per-tool class"**, meaning the
 * TOOL decides, and a web-fetching tool's output is external content wearing a different hat. Until a per-tool trust
 * mapping exists (it needs the worker/tool registry of P5-004), the safe reading of "per-tool" is "not automatically
 * trusted".
 *
 * `semi_trusted_generated` is likewise out: canon says generated documents are "never auto-promoted to fact", and a
 * model's own earlier output is exactly the channel a successful injection would use to persist across steps.
 */
const TRUSTED_INPUT: readonly string[] = ['trusted_user_input'];

/**
 * Is this trust label untrusted? **Unknown counts as untrusted**, which is the whole point: defaulting an
 * unrecognised provenance to "trusted" would turn a broken caller into a bypass.
 */
export function isUntrustedTrust(value: unknown): boolean {
  return !(typeof value === 'string' && TRUSTED_INPUT.includes(value));
}

export interface ContentProvenance {
  /** Where it came from — a URL, a connection id, an uploader reference. Never a credential. */
  readonly source: string;
  /** ISO instant it was acquired. A string, so this module stays clock-free and pure. */
  readonly fetchedAt: string;
}

export interface ClassifiedContent {
  readonly trust: ContentTrust;
  readonly content: string;
  readonly provenance: ContentProvenance;
}

/**
 * Wrap external content as untrusted DATA with its provenance.
 *
 * IT DOES NOT SANITISE, and that is deliberate twice over. Sanitisation is a filter, and filters are evaded; a value
 * that never reaches an instruction position has nothing to evade. And silently rewriting the content would corrupt
 * the evidence a human later reads when deciding whether an injection actually occurred.
 */
export function wrapUntrusted(content: string, provenance: ContentProvenance): ClassifiedContent {
  return { trust: 'untrusted_external', content, provenance };
}

/**
 * Does the working context contain anything untrusted?
 *
 * THIS is what withdraws the dispatcher's informational waiver (CDR-055 §1). A malformed or unrecognised item counts
 * as untrusted: "I cannot tell what this is" is not a clean bill of health.
 */
export function hasUntrustedContext(items: readonly unknown[] | undefined): boolean {
  if (items === undefined || items.length === 0) return false;
  return items.some((item) => isUntrustedTrust((item as { trust?: unknown } | null | undefined)?.trust));
}

/** CLOSED. What a signal MEANS, not a rule id — these are read by humans deciding whether to quarantine. */
export const INJECTION_SIGNALS = ['instruction_override', 'role_reassignment', 'concealment', 'tool_invocation_request', 'authority_claim'] as const;
export type InjectionSignal = (typeof INJECTION_SIGNALS)[number];

/**
 * The patterns, kept next to the signal they justify so a reader can judge each one.
 *
 * These are LOW-recall by design. A pattern that fires on ordinary prose would train everyone to ignore the signal,
 * and the boundary does not depend on recall — provenance already closed the gate.
 */
const PATTERNS: ReadonlyArray<readonly [InjectionSignal, RegExp]> = [
  ['instruction_override', /\bignore\s+(?:all\s+)?(?:previous|prior|earlier|above)\b[^.\n]{0,40}\binstructions?\b/i],
  ['instruction_override', /\bdisregard\s+(?:all\s+)?(?:previous|prior|the\s+above)\b/i],
  ['role_reassignment', /\byou\s+are\s+now\b[^.\n]{0,60}\b(?:mode|admin|root|unrestricted|developer)\b/i],
  ['role_reassignment', /(?:^|\n)\s*(?:#{1,6}\s*)?(?:system|assistant)\s*:/i],
  ['concealment', /\b(?:do\s+not|don't|never)\s+(?:tell|mention|inform|reveal)\b[^.\n]{0,40}\b(?:user|owner|human)\b/i],
  ['tool_invocation_request', /\b(?:call|invoke|execute|run|use)\s+the\s+[a-z_]{3,40}\s+tool\b/i],
  ['authority_claim', /\b(?:the\s+)?(?:owner|admin|user)\s+(?:has\s+)?(?:already\s+)?(?:approved|authoriz(?:ed|es)|permitted)\b/i],
];

/**
 * What this content matched.
 *
 * THE RETURN SHAPE IS THE CONTRACT. There is no `safe`, `clean` or `suspected` field, because this heuristic cannot
 * support that claim and an API that let a caller spell it would eventually have one who believed it. An empty
 * `signals` array means "matched nothing known" — nothing more.
 *
 * TOTAL: any string yields a result. A detector that throws is a gap in the very path that is supposed to be watching.
 */
export function detectInjection(content: string): { readonly signals: readonly InjectionSignal[] } {
  const found = new Set<InjectionSignal>();
  // Bounded so a pathological input cannot turn detection into a denial of service on the caller. Injection markers
  // that matter sit in the content a model will actually read, which is itself bounded upstream.
  const scanned = typeof content === 'string' ? content.slice(0, 64_000) : '';
  for (const [signal, pattern] of PATTERNS) {
    if (pattern.test(scanned)) found.add(signal);
  }
  return { signals: [...found] };
}
